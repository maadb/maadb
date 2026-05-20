// ============================================================================
// 0.7.10 — Tolerant-only repair primitives behind maad_repair_where.
//
// Two strategies registered in an internal `REPAIR_STRATEGIES` map:
//
//   prune_orphan_refs  — for each ref-typed field in the record's frontmatter,
//                        if the target docId can't be resolved (target missing
//                        OR soft-deleted, matching verifyIntegrity's broken_refs
//                        semantics), drop the broken ref. Single-valued ref →
//                        set to null; list-of-ref → filter out missing targets.
//                        Pure compute; the orchestrator owns the disk write.
//
//   fix_schema_drift   — bump the record's `schema` frontmatter value (and the
//                        backing schemaRef column on next reindex) to the
//                        registry's current schemaRef for the record's docType.
//                        Tolerant migration only — adds missing optional fields
//                        with their schema defaults, drops fields no longer
//                        declared, NEVER coerces types. Records with type
//                        coercion needs surface as REPAIR_REQUIRES_MIGRATION
//                        for a future migration tool to handle.
//
// Both strategies return RepairOutcome — a pure computed value with the new
// frontmatter and changed-fields list, or a failure code. The orchestrator
// (`repairWhere`) chains strategies per record, accumulates changes, writes
// once per record via atomicWrite + indexFile, and emits a single trailing
// git commit for the whole batch (mirrors bulkUpdate's pattern).
//
// Spec lock: docs/specs/0.7.10-integrity-cleanup.md §maad_repair_where.
// ============================================================================

import path from 'node:path';
import { ok, type Result, type MaadError } from '../errors.js';
import {
  docId as toDocId,
  filePath as toFilePath,
  type DocId,
  type DocType,
  type DocumentRecord,
  type FieldDefinition,
  type FilterCondition,
} from '../types.js';
import type { EngineContext } from './context.js';
import { gitCommit } from './context.js';
import type {
  CommitFailureDetail,
  RepairStrategyName,
  RepairWhereResult,
} from './types.js';
import type { CommitOutcome } from '../git/index.js';
import { readFrontmatter } from './helpers.js';
import { generateDocument, extractBody } from '../writer/index.js';
import { atomicWrite } from './journal.js';
import { indexFile } from './indexing.js';
import { readFile } from 'node:fs/promises';

// ---- Per-strategy outcome --------------------------------------------------

interface RepairOk {
  ok: true;
  /** True when the strategy ran but the record was already clean. */
  noop: boolean;
  /** Field names mutated (frontmatter keys). Empty when noop. */
  changedFields: string[];
  /** New frontmatter to persist when noop=false. */
  newFrontmatter: Record<string, unknown>;
}

interface RepairErr {
  ok: false;
  code: 'REPAIR_REQUIRES_MIGRATION';
  message: string;
}

type RepairOutcome = RepairOk | RepairErr;

type RepairStrategy = (
  ctx: EngineContext,
  doc: DocumentRecord,
  frontmatter: Record<string, unknown>,
) => RepairOutcome;

// ---- prune_orphan_refs -----------------------------------------------------

function pruneOrphanRefs(
  ctx: EngineContext,
  doc: DocumentRecord,
  frontmatter: Record<string, unknown>,
): RepairOutcome {
  const schema = ctx.schemaStore.getSchemaForType(doc.docType);
  if (!schema) {
    // Schema gone — fix_schema_drift would catch this; prune can't reason
    // about ref fields without the schema, so noop. Operator can either run
    // fix_schema_drift first or restore the schema pack.
    return { ok: true, noop: true, changedFields: [], newFrontmatter: frontmatter };
  }

  const next: Record<string, unknown> = { ...frontmatter };
  const changedFields: string[] = [];

  for (const [fieldName, def] of schema.fields) {
    const value = next[fieldName];
    if (value === undefined || value === null) continue;

    if (def.type === 'ref') {
      // Single-valued ref. Value is a string docId.
      if (typeof value !== 'string') continue;
      if (!isRefBroken(ctx, value)) continue;
      next[fieldName] = null;
      changedFields.push(fieldName);
      continue;
    }

    if (def.type === 'list' && def.itemType === 'ref') {
      if (!Array.isArray(value)) continue;
      const filtered = value.filter(v => typeof v === 'string' && !isRefBroken(ctx, v));
      if (filtered.length !== value.length) {
        next[fieldName] = filtered;
        changedFields.push(fieldName);
      }
    }
  }

  if (changedFields.length === 0) {
    return { ok: true, noop: true, changedFields: [], newFrontmatter: frontmatter };
  }
  return { ok: true, noop: false, changedFields, newFrontmatter: next };
}

function isRefBroken(ctx: EngineContext, targetDocId: string): boolean {
  // Aligned with verifyIntegrity's broken_refs semantics: a ref is "broken"
  // when its target either doesn't exist OR is soft-deleted. backend.getDocument
  // already filters deleted=0, so a null return covers both cases.
  return ctx.backend.getDocument(toDocId(targetDocId)) === null;
}

// ---- fix_schema_drift ------------------------------------------------------

function fixSchemaDrift(
  ctx: EngineContext,
  doc: DocumentRecord,
  frontmatter: Record<string, unknown>,
): RepairOutcome {
  const regType = ctx.registry.types.get(doc.docType);
  if (!regType) {
    // No registry entry for this docType — can't determine the target
    // schemaRef. Best-effort: report as REPAIR_REQUIRES_MIGRATION so the
    // operator knows manual intervention is needed.
    return {
      ok: false,
      code: 'REPAIR_REQUIRES_MIGRATION',
      message: `docType "${doc.docType as string}" is not in the current registry; cannot determine target schemaRef`,
    };
  }

  const currentRef = doc.schemaRef as string;
  const targetRef = regType.schemaRef as string;
  if (currentRef === targetRef) {
    return { ok: true, noop: true, changedFields: [], newFrontmatter: frontmatter };
  }

  const targetSchema = ctx.schemaStore.getSchemaForType(doc.docType);
  if (!targetSchema) {
    return {
      ok: false,
      code: 'REPAIR_REQUIRES_MIGRATION',
      message: `target schema "${targetRef}" is registered but not loaded; cannot compute tolerant migration`,
    };
  }

  const next: Record<string, unknown> = { ...frontmatter };
  const changedFields: string[] = [];

  // Step 1 — drop fields present in the doc but no longer declared by the
  // target schema. Skip core fields (doc_id, doc_type, schema).
  const declaredFields = new Set(targetSchema.fields.keys());
  for (const key of Object.keys(next)) {
    if (key === 'doc_id' || key === 'doc_type' || key === 'schema') continue;
    if (declaredFields.has(key)) continue;
    delete next[key];
    changedFields.push(key);
  }

  // Step 2 — detect type-coercion conflicts (the not-tolerant case). A
  // declared field present in the doc whose schema type changed in a way
  // that doesn't trivially round-trip is REPAIR_REQUIRES_MIGRATION. We treat
  // any non-noop type change as requiring migration; tolerant additions
  // (optional field newly declared, defaulted in) are handled below.
  for (const [fieldName, def] of targetSchema.fields) {
    const value = next[fieldName];
    if (value === undefined || value === null) continue;
    if (!isTypeCompatible(value, def)) {
      return {
        ok: false,
        code: 'REPAIR_REQUIRES_MIGRATION',
        message: `field "${fieldName}" value type ${typeof value} is not tolerant-compatible with declared type "${def.type}"; migration required`,
      };
    }
  }

  // Step 3 — add missing optional fields with schema defaults. Required
  // fields stay missing — that's a validation failure caught at write time,
  // not something tolerant repair can invent.
  for (const [fieldName, def] of targetSchema.fields) {
    if (next[fieldName] !== undefined) continue;
    if (targetSchema.required.includes(fieldName)) continue;
    if (def.defaultValue === undefined || def.defaultValue === null) continue;
    next[fieldName] = def.defaultValue;
    changedFields.push(fieldName);
  }

  // Step 4 — bump the `schema` frontmatter key to the new schemaRef. The
  // indexFile pass after the write will pick this up into documents.schema_ref.
  if (next.schema !== targetRef) {
    next.schema = targetRef;
    changedFields.push('schema');
  }

  if (changedFields.length === 0) {
    return { ok: true, noop: true, changedFields: [], newFrontmatter: frontmatter };
  }
  return { ok: true, noop: false, changedFields, newFrontmatter: next };
}

function isTypeCompatible(value: unknown, def: FieldDefinition): boolean {
  // Tolerant repair is strict about type identity — anything that would
  // require coercion (e.g. "5" → 5) is migration, not repair, and lands as
  // REPAIR_REQUIRES_MIGRATION. `amount` is the one legitimate hybrid: it
  // accepts both numeric scalars and currency-prefixed strings ("$100") as
  // first-class values throughout the engine.
  switch (def.type) {
    case 'string':
    case 'enum':
    case 'date':
    case 'ref':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'amount':
      return typeof value === 'number' || typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'list':
      return Array.isArray(value);
  }
}

// ---- Registry --------------------------------------------------------------

const REPAIR_STRATEGIES: Record<RepairStrategyName, RepairStrategy> = {
  prune_orphan_refs: pruneOrphanRefs,
  fix_schema_drift: fixSchemaDrift,
};

export function getRepairStrategyNames(): RepairStrategyName[] {
  return Object.keys(REPAIR_STRATEGIES) as RepairStrategyName[];
}

// ---- Orchestrator ----------------------------------------------------------

/**
 * 0.7.10 — `maad_repair_where` engine entry point. Applies each strategy in
 * `repairTypes` to every doc matching `(docType, filter)`, capped at
 * `maxRecords`. Per-record per-strategy failures collect independently;
 * per-record successes accumulate and write once with a single trailing
 * commit for the batch.
 *
 * The MCP layer owns the confirm contract, maxRecords resolution, idempotency,
 * and dry-run preview. This function assumes the caller has already gated on
 * `confirm: true`.
 */
export async function repairWhere(
  ctx: EngineContext,
  filter: Record<string, FilterCondition> | undefined,
  docType: DocType | undefined,
  repairTypes: RepairStrategyName[],
  maxRecords: number,
): Promise<Result<RepairWhereResult>> {
  // Query matches. Without docType the query layer rejects (findDocuments
  // requires it), so the MCP layer is responsible for surfacing a clear
  // error before reaching here. We re-defend with an empty match set so the
  // engine never crashes on a malformed call.
  if (!docType) {
    return ok({
      succeeded: [],
      failed: [],
      totalRequested: 0,
      writeDurable: true,
    });
  }

  const matches = ctx.backend.findDocuments({
    docType,
    ...(filter !== undefined ? { filters: filter } : {}),
    limit: maxRecords,
  });

  const succeeded: RepairWhereResult['succeeded'] = [];
  const failed: RepairWhereResult['failed'] = [];
  const allFiles: string[] = [];

  for (const match of matches) {
    const docId = match.docId;
    const doc = ctx.backend.getDocument(docId);
    if (!doc) {
      // Race: row was deleted between findDocuments and getDocument. Skip
      // silently — there's nothing left to repair.
      continue;
    }

    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = await readFrontmatter(ctx.projectRoot, doc);
    } catch (e) {
      for (const strategy of repairTypes) {
        failed.push({
          docId: docId as string,
          strategy,
          code: 'REPAIR_REQUIRES_MIGRATION',
          message: `cannot read frontmatter for ${docId as string}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      continue;
    }

    let workingFrontmatter = frontmatter;
    const appliedRepairs: RepairWhereResult['succeeded'][number]['appliedRepairs'] = [];

    for (const strategyName of repairTypes) {
      const strategy = REPAIR_STRATEGIES[strategyName];
      const outcome = strategy(ctx, doc, workingFrontmatter);
      if (!outcome.ok) {
        failed.push({
          docId: docId as string,
          strategy: strategyName,
          code: outcome.code,
          message: outcome.message,
        });
        continue;
      }
      if (outcome.noop) continue;
      workingFrontmatter = outcome.newFrontmatter;
      appliedRepairs.push({ strategy: strategyName, changedFields: outcome.changedFields });
    }

    if (appliedRepairs.length === 0) continue;

    // Write the record back. Mirrors updateDocument's atomic write + indexFile
    // pattern but skips per-record git commits — the trailing batch commit
    // covers everything. Failures collapse the per-record applied repairs to
    // a single failed entry per strategy attempted.
    const writeResult = await writeRepairedRecord(ctx, doc, workingFrontmatter);
    if (!writeResult.ok) {
      for (const r of appliedRepairs) {
        failed.push({
          docId: docId as string,
          strategy: r.strategy,
          code: writeResult.code,
          message: writeResult.message,
        });
      }
      continue;
    }

    succeeded.push({
      docId: docId as string,
      docType: doc.docType as string,
      appliedRepairs,
    });
    allFiles.push(writeResult.absPath);
  }

  let commitFailure: CommitFailureDetail | undefined;
  let writeDurable = true;
  const first = succeeded[0];
  if (first) {
    const outcome: CommitOutcome = await gitCommit(ctx, {
      action: 'update',
      docId: toDocId(first.docId),
      docType: first.docType as DocType,
      detail: `repair:${repairTypes.join(',')}:${succeeded.length}`,
      summary: `Repaired ${succeeded.length} records via ${repairTypes.join(' + ')}`,
      files: allFiles,
    });
    if (outcome.status === 'failed') {
      writeDurable = false;
      commitFailure = { code: outcome.code, message: outcome.message, action: 'update' };
    }
  }

  const result: RepairWhereResult = {
    succeeded,
    failed,
    totalRequested: matches.length,
    writeDurable,
  };
  if (commitFailure) result.commitFailure = commitFailure;
  return ok(result);
}

interface WriteOk {
  ok: true;
  absPath: string;
}

interface WriteErr {
  ok: false;
  code: string;
  message: string;
}

async function writeRepairedRecord(
  ctx: EngineContext,
  doc: DocumentRecord,
  newFrontmatter: Record<string, unknown>,
): Promise<WriteOk | WriteErr> {
  const targetSchema = ctx.schemaStore.getSchemaForType(doc.docType);
  if (!targetSchema) {
    return { ok: false, code: 'SCHEMA_NOT_FOUND', message: `no schema for "${doc.docType as string}"` };
  }
  const absPath = path.join(ctx.projectRoot, doc.filePath as string);
  let rawBody: string;
  try {
    const raw = await readFile(absPath, 'utf-8');
    rawBody = extractBody(raw);
  } catch (e) {
    return { ok: false, code: 'FILE_READ_ERROR', message: `cannot read ${absPath}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const markdown = generateDocument(newFrontmatter, targetSchema, rawBody.length > 0 ? rawBody : undefined);
  try {
    await atomicWrite(absPath, markdown);
  } catch (e) {
    return { ok: false, code: 'WRITE_ERROR', message: `atomicWrite failed for ${absPath}: ${e instanceof Error ? e.message : String(e)}` };
  }
  const indexResult = await indexFile(ctx, toFilePath(absPath));
  if (!indexResult.ok) {
    return {
      ok: false,
      code: 'INDEX_FAILED',
      message: `index update failed for ${doc.docId as string}: ${indexResult.errors.map((err: MaadError) => err.message).join('; ')}`,
    };
  }
  return { ok: true, absPath };
}
