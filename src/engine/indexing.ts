// ============================================================================
// Indexing — indexAll, indexFile, processDocument, reindex
// ============================================================================

import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { ok, err, singleErr, type Result } from '../errors.js';
import { logger } from './logger.js';
import {
  docId as toDocId,
  docType as toDocType,
  filePath as toFilePath,
  type DocId,
  type DocType,
  type FilePath,
  type ParsedDocument,
  type BoundDocument,
  type ValidatedField,
  type ExtractionResult,
  type DocumentRecord,
  type SchemaDefinition,
} from '../types.js';
import { parseDocument } from '../parser/index.js';
import { validateFrontmatter } from '../schema/index.js';
import { extract } from '../extractor/index.js';
import type { EngineContext } from './context.js';
import type { IndexResult } from './types.js';
import { collectMarkdownFiles, computeNumericValue, toCanonicalRelPath } from './helpers.js';

// 0.7.4 (fup-2026-093) — Per-type schema fingerprint covering the indexed
// field set. When a schema edit flips a field's `index: false → true` (or
// adds/removes an indexed field), the fingerprint changes; indexAll detects
// that and force-rebuilds docs of the affected type even when their file
// hashes are unchanged. Closes the silent "indexed: 0, skipped: N" footgun.
//
// Fingerprint covers: indexed field names + their types (so a type-change
// on an indexed field also triggers rebuild). Sorted+joined+hashed; first
// 16 hex chars are plenty of collision resistance for this use.
function computeIndexedFieldFingerprint(schema: SchemaDefinition): string {
  const parts: string[] = [];
  for (const [name, def] of schema.fields) {
    if (def.index) parts.push(`${name}:${def.type}`);
  }
  parts.sort();
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

const SCHEMA_FP_KEY_PREFIX = 'schema_index_fp:';

export async function indexAll(ctx: EngineContext, opts?: { force?: boolean }): Promise<IndexResult> {
  const force = opts?.force ?? false;
  const result: IndexResult = { scanned: 0, indexed: 0, skipped: 0, errors: [] };

  // 0.7.4 — Detect schema-index changes per type. Types whose fingerprint
  // changed (or was never recorded) join `dirtyTypes`, which overrides the
  // file-hash skip path below so docs of those types reindex even if their
  // markdown is byte-for-byte unchanged.
  const dirtyTypes = new Set<string>();
  const currentFingerprints = new Map<DocType, string>();
  for (const [typeName] of ctx.registry.types) {
    const schema = ctx.schemaStore.getSchemaForType(typeName);
    if (!schema) continue;
    const fp = computeIndexedFieldFingerprint(schema);
    currentFingerprints.set(typeName, fp);
    if (force) {
      dirtyTypes.add(typeName as string);
      continue;
    }
    const stored = ctx.backend.getMeta(`${SCHEMA_FP_KEY_PREFIX}${typeName as string}`);
    if (stored !== fp) dirtyTypes.add(typeName as string);
  }

  const storedHashes = force ? new Map() : ctx.backend.getAllFileHashes();
  const filesOnDisk = new Set<string>();

  for (const [typeName, regType] of ctx.registry.types) {
    const isTypeDirty = dirtyTypes.has(typeName as string);
    const dirPath = path.join(ctx.projectRoot, regType.path);
    if (!existsSync(dirPath)) continue;

    const files = await collectMarkdownFiles(dirPath);

    for (const file of files) {
      result.scanned++;
      // 0.7.12 — canonical (forward-slash) form for both the skip-by-hash
      // lookup against getAllFileHashes (which now stores '/' post-0.7.12)
      // and the filesOnDisk set used by the stale-row sweep.
      const fp = toFilePath(toCanonicalRelPath(ctx.projectRoot, file));
      const absPath = toFilePath(file);
      filesOnDisk.add(fp as string);

      // Skip-by-hash only applies when neither --force nor a schema-fingerprint
      // change is in play. Otherwise we rebuild even if disk content matches.
      if (!force && !isTypeDirty) {
        const raw = await readFile(file, 'utf-8');
        const currentHash = createHash('sha256').update(raw).digest('hex');
        const storedHash = storedHashes.get(fp);
        if (storedHash === currentHash) {
          result.skipped++;
          continue;
        }
      }

      const indexResult = await indexFile(ctx, absPath);
      if (indexResult.ok) {
        result.indexed++;
        if (indexResult.value.annotationsTruncated) {
          result.partial = (result.partial ?? 0) + 1;
        }
      } else {
        result.errors.push(...indexResult.errors);
      }
    }
  }

  // Remove stale backend records
  const allStoredPaths = ctx.backend.getAllFileHashes();
  for (const [storedPath] of allStoredPaths) {
    if (!filesOnDisk.has(storedPath as string)) {
      const doc = ctx.backend.getDocumentByPath(storedPath);
      if (doc) {
        ctx.backend.removeDocument(doc.docId);
      }
    }
  }

  // 0.7.4 — Persist current fingerprints AFTER successful rebuild so a
  // crash mid-reindex leaves the prior fingerprint in place; next run sees
  // the diff again and retries.
  for (const [typeName, fp] of currentFingerprints) {
    ctx.backend.setMeta(`${SCHEMA_FP_KEY_PREFIX}${typeName as string}`, fp);
  }

  if (dirtyTypes.size > 0) {
    result.rebuiltTypes = [...dirtyTypes].sort();
  }

  // 0.7.17 — refresh planner statistics after a rebuild touched rows. Skipped
  // on a no-op pass (everything hash-skipped) so steady-state reindex polling
  // doesn't pay for an ANALYZE that would change nothing.
  if (result.indexed > 0) {
    ctx.backend.analyze();
  }

  return result;
}

// 0.7.13 — per-doc index-time memory guards. A single document can allocate
// far beyond its own byte size in V8 heap while indexing: the dominant driver
// is body annotation count (each [[type:value|label]] becomes a parsed
// annotation, an extracted object, and often a relationship — all live at once
// alongside the SQLite bind params). A doc with hundreds of thousands of
// annotations can exhaust the heap and FATAL the whole engine process, taking
// every project on it down and crash-looping on restart as reindex re-touches
// the same doc.
//
// Two layered guards, both designed to keep the document FINDABLE rather than
// silently dropping it:
//
//  1. Annotation cap (MAAD_MAX_DOC_ANNOTATIONS, default 50k). Body annotation
//     extraction stops at the cap, so objects/relationships stay bounded. The
//     document record + frontmatter index are still written in full — the doc
//     remains queryable by id and by frontmatter field; only its body objects
//     are partial. Surfaced as IndexResult.partial + a degraded ops event.
//
//  2. Byte backstop (MAAD_MAX_DOC_BYTES, default 16 MiB). For a file so large
//     that even reading + line-splitting it is unsafe, skip entirely with
//     DOC_TOO_LARGE rather than risk the read. 16 MiB is ~28 average novels of
//     text in one file — far past any legitimate record. Set 0 to disable.
const DEFAULT_MAX_DOC_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_DOC_ANNOTATIONS = 50_000;

function maxDocBytes(): number {
  const raw = process.env['MAAD_MAX_DOC_BYTES'];
  if (raw === undefined) return DEFAULT_MAX_DOC_BYTES;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_DOC_BYTES;
  return n; // 0 = disabled
}

function maxDocAnnotations(): number {
  const raw = process.env['MAAD_MAX_DOC_ANNOTATIONS'];
  if (raw === undefined) return DEFAULT_MAX_DOC_ANNOTATIONS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_DOC_ANNOTATIONS;
  return n; // 0 = disabled
}

export async function indexFile(ctx: EngineContext, absolutePath: FilePath): Promise<Result<ExtractionResult>> {
  // Backstop: a stat is cheap, and reading + line-splitting a multi-hundred-MB
  // file is itself a heap risk before any extraction cap can apply. Skip those.
  const byteCap = maxDocBytes();
  if (byteCap > 0) {
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(absolutePath as string).size;
    } catch {
      // stat failure falls through to parseDocument, which surfaces the real
      // FILE_READ_ERROR with proper location info.
      sizeBytes = 0;
    }
    if (sizeBytes > byteCap) {
      logger.degraded('engine', 'doc_too_large',
        `skipped oversized document (${sizeBytes} bytes > cap ${byteCap}); too large to read safely`,
        { file: absolutePath as string, sizeBytes, capBytes: byteCap });
      return singleErr('DOC_TOO_LARGE',
        `Document ${absolutePath as string} is ${sizeBytes} bytes, over the ${byteCap}-byte read cap (MAAD_MAX_DOC_BYTES). Skipped to protect the engine; split the document or raise the cap with matching heap headroom.`,
        { file: absolutePath, line: 0, col: 0 },
        { sizeBytes, capBytes: byteCap });
    }
  }

  // Bound body annotation extraction so a pathological annotation count can't
  // build an unbounded object/relationship set. The doc still indexes (record
  // + frontmatter + capped body) and stays findable.
  const annoCap = maxDocAnnotations();
  const parsed = await parseDocument(absolutePath, ctx.registry.subtypeMap,
    annoCap > 0 ? { maxAnnotations: annoCap } : undefined);
  if (!parsed.ok) return parsed;

  if (parsed.value.annotationsTruncated) {
    logger.degraded('engine', 'doc_body_truncated',
      `indexed with body annotations capped at ${annoCap}; document record + frontmatter are complete, body objects are partial`,
      { file: absolutePath as string, capAnnotations: annoCap });
  }

  return processDocument(ctx, parsed.value);
}

export function processDocument(ctx: EngineContext, parsed: ParsedDocument): Result<ExtractionResult> {
  const fmDocType = parsed.frontmatter['doc_type'];
  if (typeof fmDocType !== 'string') {
    return singleErr('UNKNOWN_TYPE', `Document has no doc_type in frontmatter: ${parsed.filePath}`);
  }

  const dt = toDocType(fmDocType);
  const schema = ctx.schemaStore.getSchemaForType(dt);
  if (!schema) {
    return singleErr('UNKNOWN_TYPE', `No schema found for doc_type "${fmDocType}"`);
  }

  const fmDocId = parsed.frontmatter['doc_id'];
  if (typeof fmDocId !== 'string') {
    return singleErr('INVALID_DOC_ID', `Document has no doc_id in frontmatter: ${parsed.filePath}`);
  }

  const regType = ctx.registry.types.get(dt);
  if (!regType) {
    return singleErr('UNKNOWN_TYPE', `Type "${fmDocType}" not in registry`);
  }

  // Index mode: structural validation only. Precision enforcement is write-
  // time only — historical records on disk must stay indexable regardless
  // of current schema precision declarations.
  const validation = validateFrontmatter(parsed.frontmatter, schema, ctx.registry, parsed.filePath, { mode: 'index' });

  const validatedFields: Record<string, ValidatedField> = {};
  for (const [fieldName, fieldDef] of schema.fields) {
    const value = parsed.frontmatter[fieldName];
    if (value !== undefined && value !== null) {
      validatedFields[fieldName] = {
        name: fieldName,
        value,
        fieldType: fieldDef.type,
        role: fieldDef.role,
        indexed: fieldDef.index,
      };
    }
  }

  const bound: BoundDocument = {
    parsed,
    docId: toDocId(fmDocId),
    docType: dt,
    schemaRef: regType.schemaRef,
    validatedFields,
    validationResult: validation,
  };

  const extraction = extract(bound, schema, ctx.registry);

  // 0.7.12 — canonicalize file_path to forward slashes at the write boundary
  // so the SQLite index is portable across Windows/POSIX. Helper in
  // engine/helpers.ts is the single source of truth for relative-path
  // canonicalization; reuse it across all write-path sites.
  const relativePath = toCanonicalRelPath(ctx.projectRoot, parsed.filePath as string);
  const existing = ctx.backend.getDocument(bound.docId);
  // Only bump version when file content actually changed — reindex of unchanged files preserves version
  const contentChanged = !existing || existing.fileHash !== parsed.fileHash;
  const version = existing
    ? (contentChanged ? existing.version + 1 : existing.version)
    : 1;
  const now = new Date().toISOString();
  // 0.7.12 — engine-stamped createdAt. Preserve on existing docs (immutable
  // once set), backfill from updatedAt for pre-0.7.12 rows that migrated in
  // with an empty createdAt, and stamp `now` for net-new docs.
  const createdAt = existing
    ? (existing.createdAt || existing.updatedAt || now)
    : now;
  const docRecord: DocumentRecord = {
    docId: bound.docId,
    docType: bound.docType,
    schemaRef: bound.schemaRef,
    filePath: toFilePath(relativePath),
    fileHash: parsed.fileHash,
    version,
    deleted: false,
    indexedAt: now,
    updatedAt: contentChanged ? now : (existing?.updatedAt ?? now),
    createdAt,
    // 0.7.17 — persist index-time structural validity so summary() can COUNT
    // invalid records instead of re-reading every file. `validation` was
    // computed above in mode 'index'.
    valid: validation.valid,
  };

  const fieldIndex: Array<{ name: string; value: string; numericValue: number | null; type: string }> = [];
  for (const [name, field] of Object.entries(validatedFields)) {
    if (field.indexed) {
      // List fields: one row per item so filters match individual values
      if (field.fieldType === 'list' && Array.isArray(field.value)) {
        for (const item of field.value) {
          const itemValue = item instanceof Date
            ? item.toISOString()
            : String(item);
          fieldIndex.push({
            name,
            value: itemValue,
            numericValue: computeNumericValue(item, 'string'),
            type: field.fieldType,
          });
        }
      } else {
        const fieldValue = field.value instanceof Date
          ? field.value.toISOString()
          : String(field.value);
        fieldIndex.push({
          name,
          value: fieldValue,
          numericValue: computeNumericValue(field.value, field.fieldType),
          type: field.fieldType,
        });
      }
    }
  }

  ctx.backend.materializeDocument(
    docRecord,
    extraction.objects,
    extraction.relationships,
    parsed.blocks,
    fieldIndex,
  );

  // Carry the partial-index signal up so indexAll can tally it. The record +
  // frontmatter above are always written in full; only body objects are capped.
  if (parsed.annotationsTruncated) extraction.annotationsTruncated = true;
  return ok(extraction);
}

export async function reindex(ctx: EngineContext, opts?: { docId?: DocId; force?: boolean }): Promise<Result<IndexResult>> {
  if (opts?.docId) {
    const doc = ctx.backend.getDocument(opts.docId);
    if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${opts.docId as string}" not found`);

    const absPath = path.join(ctx.projectRoot, doc.filePath as string);
    const result = await indexFile(ctx, toFilePath(absPath));
    if (!result.ok) return err(result.errors);
    return ok({ scanned: 1, indexed: 1, skipped: 0, errors: [] });
  }

  return ok(await indexAll(ctx, { force: opts?.force ?? false }));
}
