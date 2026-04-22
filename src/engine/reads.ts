// ============================================================================
// Reads — getDocument, findDocuments, searchObjects, listRelated,
//         describe, summary, getSchema, schemaInfo
// ============================================================================

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ok, singleErr, type Result } from '../errors.js';
import { validateFrontmatter } from '../schema/index.js';
import { logger } from './logger.js';
import {
  docId as toDocId,
  docType as toDocType,
  type DocId,
  type DocType,
  type SchemaDefinition,
  type DocumentQuery,
  type ObjectQuery,
  type FilterCondition,
} from '../types.js';
import { extractBody } from '../writer/index.js';
import type { EngineContext } from './context.js';
import type {
  GetResult,
  FindResult,
  SearchResult,
  RelatedResult,
  DescribeResult,
  SummaryResult,
  SchemaInfoResult,
  VerifyResult,
  AggregateQuery,
  AggregateResult,
  JoinQuery,
  JoinResult,
  JoinResultRow,
  ChangesSinceQuery,
  ChangesPage,
  ChangesSinceParsedCursor,
} from './types.js';
import { readFrontmatter, readFrontmatterSync, readBlockContent } from './helpers.js';

export async function getDocument(
  ctx: EngineContext,
  id: DocId,
  depth: 'hot' | 'warm' | 'cold',
  blockIdOrHeading?: string | undefined,
): Promise<Result<GetResult>> {
  const doc = ctx.backend.getDocument(id);
  if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${id as string}" not found`);

  const frontmatter = await readFrontmatter(ctx.projectRoot, doc);

  const result: GetResult = {
    docId: doc.docId,
    docType: doc.docType,
    version: doc.version,
    updatedAt: doc.updatedAt,
    depth,
    frontmatter,
  };

  if (depth === 'warm' && blockIdOrHeading) {
    const blocks = ctx.backend.getBlocks(id);
    const match = blocks.find(b =>
      (b.id as string) === blockIdOrHeading ||
      b.heading.toLowerCase() === blockIdOrHeading.toLowerCase()
    );
    if (match) {
      const content = await readBlockContent(ctx.projectRoot, doc, match.startLine, match.endLine, match.heading === '');
      result.block = {
        id: match.id as string | null,
        heading: match.heading,
        content,
      };
    }
  }

  if (depth === 'cold') {
    const absPath = path.join(ctx.projectRoot, doc.filePath as string);
    try {
      const raw = await readFile(absPath, 'utf-8');
      result.body = extractBody(raw);
    } catch (e) {
      logger.degraded('reads', 'getDocument.cold', `Failed to read file for cold read: ${absPath}`, { error: e instanceof Error ? e.message : String(e) });
      result.body = '';
    }
  }

  return ok(result);
}

// 0.7.1 — hard caps on list-returning read tools. Prevents silent truncation
// when the MCP client's tool-output harness caps the response payload. Callers
// requesting above the cap get the clamped result plus `_meta.limit_clamped`
// in the MCP response, never a hidden partial.
export const MAX_QUERY_LIMIT = 500;
export const MAX_AGGREGATE_LIMIT = 2000;

// 0.7.1 R2 — recognized single-op filter set (excludes `between`, which is a
// compound shortcut desugared at expand time).
const ATOMIC_FILTER_OPS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'contains']);

// 0.7.1 R2 — validate and normalize a single field's filter input into a flat
// list of atomic FilterConditions. Input accepts:
//   - scalar (string/number, shorthand eq)
//   - single FilterCondition object ({op, value})
//   - 'between' shortcut ({op: "between", value: [lo, hi]}) → desugars to [gte, lte]
//   - array of FilterConditions (AND semantics; betweens inside are also desugared)
// After expansion, the backend sees only atomic ops — never between, never arrays
// of unvalidated shapes.
function normalizeFilterField(field: string, raw: unknown): Result<FilterCondition[]> {
  // Scalar shorthand → eq
  if (typeof raw === 'string' || typeof raw === 'number') {
    return ok([{ op: 'eq', value: raw }]);
  }

  // Array-of-ops
  if (Array.isArray(raw)) {
    if (raw.length === 0) {
      return singleErr('FILTER_EMPTY_ARRAY', `filter for field "${field}" is an empty array`);
    }
    const out: FilterCondition[] = [];
    for (const item of raw) {
      const inner = normalizeFilterField(field, item);
      if (!inner.ok) return inner;
      out.push(...inner.value);
    }
    return ok(out);
  }

  // Object — must have op
  if (typeof raw !== 'object' || raw === null) {
    // Fallback: stringify scalar-ish value → eq
    return ok([{ op: 'eq', value: String(raw) }]);
  }
  const obj = raw as { op?: unknown; value?: unknown };
  if (typeof obj.op !== 'string') {
    return singleErr('FILTER_OP_INVALID', `filter for field "${field}" missing or non-string op`);
  }

  // Between — desugar to [gte, lte]
  if (obj.op === 'between') {
    if (!Array.isArray(obj.value) || obj.value.length !== 2) {
      return singleErr('FILTER_BETWEEN_INVALID', `between for field "${field}" requires a 2-tuple value`);
    }
    const [lo, hi] = obj.value as [unknown, unknown];
    if (lo === undefined || lo === null || hi === undefined || hi === null) {
      return singleErr('FILTER_BETWEEN_INVALID', `between for field "${field}" has null/undefined bound`);
    }
    // Type-homogeneous lo > hi check (strings sort lexically; mixed types pass through).
    if (typeof lo === 'number' && typeof hi === 'number' && lo > hi) {
      return singleErr('FILTER_BETWEEN_INVALID', `between for field "${field}": lo (${lo}) > hi (${hi})`);
    }
    if (typeof lo === 'string' && typeof hi === 'string' && lo > hi) {
      return singleErr('FILTER_BETWEEN_INVALID', `between for field "${field}": lo ("${lo}") > hi ("${hi}")`);
    }
    return ok([
      { op: 'gte', value: lo as number | string },
      { op: 'lte', value: hi as number | string },
    ]);
  }

  if (!ATOMIC_FILTER_OPS.has(obj.op)) {
    return singleErr('FILTER_OP_INVALID', `unknown filter op "${obj.op}" for field "${field}"`);
  }
  return ok([obj as FilterCondition]);
}

export function expandFilters(
  raw: Record<string, unknown> | undefined,
): Result<Record<string, FilterCondition[]>> {
  if (!raw || typeof raw !== 'object') return ok({});
  const out: Record<string, FilterCondition[]> = {};
  for (const [field, value] of Object.entries(raw)) {
    const result = normalizeFilterField(field, value);
    if (!result.ok) return result;
    out[field] = result.value;
  }
  return ok(out);
}

export function findDocuments(ctx: EngineContext, query: DocumentQuery): Result<FindResult> {
  // 0.7.1 R2 — validate + expand filters into atomic per-field arrays.
  const expanded = expandFilters(query.filters as Record<string, unknown> | undefined);
  if (!expanded.ok) return expanded;

  let effectiveQuery: DocumentQuery = { ...query, filters: expanded.value as any };
  let limitClamped: { requested: number; applied: number } | undefined;
  if (query.limit !== undefined && query.limit > MAX_QUERY_LIMIT) {
    limitClamped = { requested: query.limit, applied: MAX_QUERY_LIMIT };
    effectiveQuery = { ...effectiveQuery, limit: MAX_QUERY_LIMIT };
  }

  const results = ctx.backend.findDocuments(effectiveQuery);
  const total = ctx.backend.countDocuments(effectiveQuery);

  if (effectiveQuery.fields && effectiveQuery.fields.length > 0 && results.length > 0) {
    const docIds = results.map(r => r.docId);
    const fieldValues = ctx.backend.getFieldValues(docIds, effectiveQuery.fields);
    for (const match of results) {
      match.fields = fieldValues.get(match.docId as string) ?? {};
    }
  }

  const result: FindResult = { total, results };
  if (limitClamped) result.limitClamped = limitClamped;
  return ok(result);
}

export function searchObjects(ctx: EngineContext, query: ObjectQuery): Result<SearchResult> {
  const results = ctx.backend.findObjects(query);
  const total = ctx.backend.countObjects(query);
  return ok({ total, results });
}

export function listRelated(
  ctx: EngineContext,
  id: DocId,
  direction: 'outgoing' | 'incoming' | 'both',
  types?: DocType[] | undefined,
): Result<RelatedResult> {
  const rels = ctx.backend.getRelationships(id, direction);

  // Batch lookup all related doc IDs in one query
  const relatedIds = new Set<DocId>();
  for (const rel of rels) {
    if (rel.sourceDocId === id) relatedIds.add(rel.targetDocId);
    else relatedIds.add(rel.sourceDocId);
  }
  const docsMap = ctx.backend.getDocumentsByIds([...relatedIds]);

  const outgoing: RelatedResult['outgoing'] = [];
  const incoming: RelatedResult['incoming'] = [];

  for (const rel of rels) {
    if (rel.sourceDocId === id) {
      const targetDoc = docsMap.get(rel.targetDocId);
      const targetType = targetDoc?.docType ?? toDocType('unknown');
      if (!types || types.includes(targetType)) {
        outgoing.push({ docId: rel.targetDocId, docType: targetType, field: rel.field });
      }
    } else {
      const sourceDoc = docsMap.get(rel.sourceDocId);
      const sourceType = sourceDoc?.docType ?? toDocType('unknown');
      if (!types || types.includes(sourceType)) {
        incoming.push({ docId: rel.sourceDocId, docType: sourceType, field: rel.field });
      }
    }
  }

  return ok({ docId: id, outgoing, incoming });
}

export function describe(ctx: EngineContext): DescribeResult {
  const stats = ctx.backend.getStats();

  const registryTypes = [...ctx.registry.types.values()].map(rt => ({
    type: rt.name as string,
    path: rt.path,
    idPrefix: rt.idPrefix,
    schema: rt.schemaRef as string,
    docCount: stats.documentCountByType[rt.name as string] ?? 0,
  }));

  return {
    registryTypes,
    extractionPrimitives: [
      'entity', 'date', 'duration', 'amount', 'measure',
      'quantity', 'percentage', 'location', 'identifier', 'contact', 'media',
    ],
    totalDocuments: stats.totalDocuments,
    lastIndexedAt: stats.lastIndexedAt,
    subtypeInventory: ctx.backend.getSubtypeInventory(20),
  };
}

export function summary(ctx: EngineContext): SummaryResult {
  const stats = ctx.backend.getStats();

  const types = [...ctx.registry.types.values()].map(rt => ({
    type: rt.name as string,
    count: stats.documentCountByType[rt.name as string] ?? 0,
    sampleIds: ctx.backend.getSampleDocIds(rt.name, 3).map(id => id as string),
  }));

  // Warnings: broken refs (cheap SQL) + validation errors (scan all docs)
  const brokenRefs = ctx.backend.countBrokenRefs();
  let validationErrors = 0;
  const allDocs = ctx.backend.findDocuments({ limit: 100000 });
  for (const match of allDocs) {
    const doc = ctx.backend.getDocument(match.docId);
    if (!doc) continue;
    const schema = ctx.schemaStore.getSchemaForType(doc.docType);
    if (!schema) { validationErrors++; continue; }
    const fm = readFrontmatterSync(ctx.projectRoot, doc);
    if (fm) {
      // Read mode: precision enforcement skipped (historical records must
      // never be judged on the way out).
      const result = validateFrontmatter(fm, schema, ctx.registry, undefined, { mode: 'read' });
      if (!result.valid) validationErrors++;
    }
  }

  const emptyProject = ctx.registry.types.size === 0 && stats.totalDocuments === 0;

  return {
    types,
    totalDocuments: stats.totalDocuments,
    totalObjects: stats.totalObjects,
    totalRelationships: stats.totalRelationships,
    lastIndexedAt: stats.lastIndexedAt,
    warnings: { brokenRefs, validationErrors },
    emptyProject,
    bootstrapHint: emptyProject ? '_skills/architect-core.md' : null,
    readOnly: ctx.readOnly,
  };
}

export function getSchema(ctx: EngineContext, dt: DocType): SchemaDefinition | undefined {
  return ctx.schemaStore.getSchemaForType(dt);
}

export function schemaInfo(ctx: EngineContext, dt: DocType): Result<SchemaInfoResult> {
  const regType = ctx.registry.types.get(dt);
  if (!regType) return singleErr('UNKNOWN_TYPE', `Type "${dt as string}" not in registry`);

  const schema = ctx.schemaStore.getSchemaForType(dt);
  if (!schema) return singleErr('SCHEMA_NOT_FOUND', `No schema for type "${dt as string}"`);

  const fields: SchemaInfoResult['fields'] = [];
  for (const [name, field] of schema.fields) {
    let typeStr = field.type as string;
    if (field.type === 'ref' && field.target) typeStr = `ref -> ${field.target as string}`;
    if (field.type === 'list' && field.itemType) {
      typeStr = `list of ${field.itemType}`;
      if (field.target) typeStr += ` -> ${field.target as string}`;
    }

    const format = field.format ?? (field.type === 'amount' ? '<number> <currency> (e.g. 1250.00 USD)' : undefined);

    // 0.7.0 — build entry with only the populated fields. Pre-0.7.0 serialized
    // null placeholders for every optional field, bloating the response.
    const entry: SchemaInfoResult['fields'][number] = {
      name,
      type: typeStr,
      required: schema.required.includes(name),
      indexed: field.index,
    };
    if (field.values !== null && field.values !== undefined) entry.values = field.values;
    if (field.target !== null && field.target !== undefined) entry.target = field.target as string;
    if (format !== undefined) entry.format = format;
    if (field.defaultValue !== null && field.defaultValue !== undefined) entry.default = field.defaultValue;
    // 0.6.7 precision hints — already omitted when null/unset.
    if (field.storePrecision !== null) entry.storePrecision = field.storePrecision;
    if (field.onCoarser !== null) entry.onCoarser = field.onCoarser;
    if (field.displayPrecision !== null) entry.displayPrecision = field.displayPrecision;
    fields.push(entry);
  }

  const result: SchemaInfoResult = {
    type: dt as string,
    idPrefix: regType.idPrefix as string,
    schemaRef: regType.schemaRef as string,
    fields,
  };
  if (schema.template) {
    result.templateHeadings = schema.template.map(t => ({ level: t.level, text: t.text }));
  }
  return ok(result);
}

// 0.7.1 R1 — sentinel group key for records whose ref chain could not be
// fully resolved at query time (broken ref, null field, missing target).
// Surfaced as a group so data-quality issues stay visible to the caller
// rather than silently vanishing.
export const UNRESOLVED_GROUP_KEY = '__unresolved__';

export function aggregate(ctx: EngineContext, query: AggregateQuery): Result<AggregateResult> {
  // 0.7.1 R2 — validate + expand filters into atomic per-field arrays.
  const expanded = expandFilters(query.filters as Record<string, unknown> | undefined);
  if (!expanded.ok) return expanded;

  let effectiveQuery: AggregateQuery = { ...query, filters: expanded.value as any };
  let limitClamped: { requested: number; applied: number } | undefined;
  if (query.limit !== undefined && query.limit > MAX_AGGREGATE_LIMIT) {
    limitClamped = { requested: query.limit, applied: MAX_AGGREGATE_LIMIT };
    effectiveQuery = { ...effectiveQuery, limit: MAX_AGGREGATE_LIMIT };
  }

  // R1 — ref-chain groupBy: "ref_field->ref_field->leaf_field". Arbitrary depth.
  // Chain detected by presence of '->' in the groupBy string. Dispatch to chain-aware
  // path; validate schema chain; aggregate at first hop via backend; resolve remaining
  // hops in the engine; merge groups that collapse to the same resolved key.
  if (effectiveQuery.groupBy.includes('->')) {
    return aggregateWithRefChain(ctx, effectiveQuery, limitClamped);
  }

  const result = ctx.backend.aggregate(effectiveQuery);
  if (limitClamped) result.limitClamped = limitClamped;
  return ok(result);
}

// ---------------------------------------------------------------------------
// R1 — ref-chain aggregate helpers
// ---------------------------------------------------------------------------

function splitRefChain(groupBy: string): string[] {
  return groupBy.split('->').map(s => s.trim());
}

function validateRefChain(
  ctx: EngineContext,
  docTypeArg: DocType | undefined,
  hops: string[],
): Result<true> {
  if (!docTypeArg) {
    return singleErr('SCHEMA_REF_CHAIN_INVALID', 'ref-chain groupBy requires an explicit docType');
  }
  if (hops.length < 2) {
    return singleErr('SCHEMA_REF_CHAIN_INVALID', 'ref-chain groupBy must have at least two segments');
  }
  for (const seg of hops) {
    if (!seg) return singleErr('SCHEMA_REF_CHAIN_INVALID', 'ref-chain segment is empty');
  }

  let currentType: DocType = docTypeArg;
  for (let i = 0; i < hops.length; i++) {
    const seg = hops[i]!;
    const schema = ctx.schemaStore.getSchemaForType(currentType);
    if (!schema) {
      return singleErr('SCHEMA_REF_CHAIN_INVALID', `no schema for type "${currentType as string}" at segment ${i} (${seg})`);
    }
    const field = schema.fields.get(seg);
    if (!field) {
      return singleErr('SCHEMA_REF_CHAIN_INVALID', `field "${seg}" not found on type "${currentType as string}"`);
    }
    const isLast = i === hops.length - 1;
    if (!isLast) {
      if (field.type !== 'ref') {
        return singleErr('SCHEMA_REF_CHAIN_INVALID', `non-leaf segment "${seg}" must be a ref field on "${currentType as string}" (got ${field.type})`);
      }
      if (!field.target) {
        return singleErr('SCHEMA_REF_CHAIN_INVALID', `ref field "${seg}" on "${currentType as string}" has no target`);
      }
      currentType = field.target;
    } else {
      // Leaf: allowed to be anything (typically string/enum/number). A leaf ref
      // is unusual but legal — callers get the target docId as the group key.
    }
  }
  return ok(true);
}

// Resolve a chain of hops starting from `startDocId`. Returns the leaf value
// (stringified) or null if any hop fails to resolve (broken ref, missing target,
// null field value).
function resolveRefChain(
  ctx: EngineContext,
  startDocId: string,
  hops: string[],
): string | null {
  let currentDocId = startDocId;
  for (let i = 0; i < hops.length; i++) {
    const field = hops[i]!;
    const isLast = i === hops.length - 1;
    const values = ctx.backend.getFieldValues([toDocId(currentDocId)], [field]);
    const v = values.get(currentDocId)?.[field];
    if (v === undefined || v === null || v === '') return null;
    const str = String(v);
    if (isLast) return str;
    currentDocId = str;
  }
  return null;
}

interface ChainGroupAccum {
  count: number;
  sum: number;     // used for sum + avg
  min: number;     // used for min
  max: number;     // used for max
  minSet: boolean;
  maxSet: boolean;
}

function freshAccum(): ChainGroupAccum {
  return { count: 0, sum: 0, min: 0, max: 0, minSet: false, maxSet: false };
}

function aggregateWithRefChain(
  ctx: EngineContext,
  query: AggregateQuery,
  limitClamped: { requested: number; applied: number } | undefined,
): Result<AggregateResult> {
  const hops = splitRefChain(query.groupBy);

  const validation = validateRefChain(ctx, query.docType, hops);
  if (!validation.ok) return validation;

  // Aggregate at first hop (which we've validated is a ref field on query.docType).
  // Pull enough groups that the limit clamp still applies after merge — ask for
  // a generous page since multiple first-hop groups can collapse to one resolved
  // key. MAX_AGGREGATE_LIMIT caps the underlying scan at 2000 rows.
  const firstHop = hops[0]!;
  const remainingHops = hops.slice(1);
  const requestedFinalLimit = query.limit ?? 50;

  const firstHopQuery: AggregateQuery = {
    groupBy: firstHop,
    limit: MAX_AGGREGATE_LIMIT,
  };
  if (query.docType !== undefined) firstHopQuery.docType = query.docType;
  if (query.metric !== undefined) firstHopQuery.metric = query.metric;
  if (query.filters !== undefined) firstHopQuery.filters = query.filters;

  const firstHopResult = ctx.backend.aggregate(firstHopQuery);

  // Resolve each first-hop group (target docId) to a final leaf key; merge
  // accumulators across groups that resolve to the same key.
  const merged = new Map<string, ChainGroupAccum>();
  let unresolvedCount = 0;

  for (const group of firstHopResult.groups) {
    const resolved = resolveRefChain(ctx, group.value, remainingHops);
    const key = resolved ?? UNRESOLVED_GROUP_KEY;
    if (resolved === null) unresolvedCount++;

    const acc = merged.get(key) ?? freshAccum();
    acc.count += group.count;

    if (query.metric) {
      const m = group.metric ?? 0;
      if (query.metric.op === 'sum') {
        acc.sum += m;
      } else if (query.metric.op === 'avg') {
        // Reconstruct per-group sum = avg * count, then re-divide at finalize.
        acc.sum += m * group.count;
      } else if (query.metric.op === 'min') {
        acc.min = acc.minSet ? Math.min(acc.min, m) : m;
        acc.minSet = true;
      } else if (query.metric.op === 'max') {
        acc.max = acc.maxSet ? Math.max(acc.max, m) : m;
        acc.maxSet = true;
      }
      // count op: tracked in acc.count directly.
    }

    merged.set(key, acc);
  }

  if (unresolvedCount > 0) {
    logger.bestEffort('reads', 'aggregate.refChain',
      `${unresolvedCount} first-hop group(s) fell through to ${UNRESOLVED_GROUP_KEY} (broken ref or null target)`,
      { docType: String(query.docType), chain: hops.join('->'), unresolvedGroups: unresolvedCount });
  }

  // Finalize: compute metric values per merged group.
  const finalGroups: Array<{ value: string; count: number; metric?: number | null }> = [];
  for (const [key, acc] of merged.entries()) {
    let metric: number | null | undefined;
    if (query.metric) {
      switch (query.metric.op) {
        case 'count': metric = acc.count; break;
        case 'sum':   metric = acc.sum; break;
        case 'avg':   metric = acc.count > 0 ? acc.sum / acc.count : null; break;
        case 'min':   metric = acc.minSet ? acc.min : null; break;
        case 'max':   metric = acc.maxSet ? acc.max : null; break;
      }
    }
    const g: { value: string; count: number; metric?: number | null } = { value: key, count: acc.count };
    if (metric !== undefined) g.metric = metric;
    finalGroups.push(g);
  }

  // Sort to match backend behavior: metric desc when a metric is set, count desc otherwise.
  finalGroups.sort((a, b) => {
    const aVal = query.metric ? (a.metric ?? 0) : a.count;
    const bVal = query.metric ? (b.metric ?? 0) : b.count;
    return (bVal as number) - (aVal as number);
  });

  // Apply user's requested limit at the final (merged) stage.
  const limited = finalGroups.slice(0, requestedFinalLimit);

  const total = limited.reduce((s, g) => s + g.count, 0);

  const result: AggregateResult = { groups: limited, total };

  // totalMetric: only semantically meaningful for sum / count. For avg/min/max,
  // a post-merge "total" is not defined — omit rather than emit a misleading number.
  if (query.metric && (query.metric.op === 'sum' || query.metric.op === 'count')) {
    result.totalMetric = limited.reduce((s, g) => s + ((g.metric as number) ?? 0), 0);
  }

  if (limitClamped) result.limitClamped = limitClamped;
  return ok(result);
}

export function join(ctx: EngineContext, query: JoinQuery): Result<JoinResult> {
  // Step 1: Find source documents
  const docQuery: DocumentQuery = { docType: query.docType };
  if (query.filters) docQuery.filters = query.filters;
  if (query.limit) docQuery.limit = query.limit;
  if (query.offset) docQuery.offset = query.offset;

  const docs = ctx.backend.findDocuments(docQuery);
  const total = ctx.backend.countDocuments(docQuery);
  if (docs.length === 0) return ok({ total, results: [] });

  const docIds = docs.map(d => d.docId);

  // Step 2: Get projected fields from source docs
  const allSourceFields = [...(query.fields ?? []), ...query.refs];
  const sourceFieldValues = ctx.backend.getFieldValues(docIds, allSourceFields);

  // Step 3: Collect all ref target IDs and batch-fetch their fields
  const refTargetIds = new Set<string>();
  for (const [, fields] of sourceFieldValues) {
    for (const refField of query.refs) {
      const targetId = fields[refField];
      if (targetId) refTargetIds.add(targetId);
    }
  }

  // Get all requested ref fields across all targets
  const allRefFieldNames = new Set<string>();
  if (query.refFields) {
    for (const fieldNames of Object.values(query.refFields)) {
      for (const f of fieldNames) allRefFieldNames.add(f);
    }
  }

  const refFieldValues = refTargetIds.size > 0 && allRefFieldNames.size > 0
    ? ctx.backend.getFieldValues(
        [...refTargetIds].map(id => id as DocId),
        [...allRefFieldNames],
      )
    : new Map<string, Record<string, string>>();

  // Step 4: Assemble results
  const results: JoinResultRow[] = [];
  for (const doc of docs) {
    const srcFields = sourceFieldValues.get(doc.docId as string) ?? {};

    // Build source fields (excluding ref field names)
    const displayFields: Record<string, string> = {};
    for (const f of (query.fields ?? [])) {
      if (srcFields[f] !== undefined) displayFields[f] = srcFields[f];
    }

    // Build ref results
    const refs: Record<string, { docId: string; fields: Record<string, string> } | null> = {};
    for (const refField of query.refs) {
      const targetId = srcFields[refField];
      if (!targetId) {
        refs[refField] = null;
        continue;
      }

      const targetFields = refFieldValues.get(targetId) ?? {};
      const requestedRefFields = query.refFields?.[refField] ?? [];
      const filteredFields: Record<string, string> = {};
      for (const f of requestedRefFields) {
        if (targetFields[f] !== undefined) filteredFields[f] = targetFields[f];
      }

      refs[refField] = { docId: targetId, fields: filteredFields };
    }

    results.push({ docId: doc.docId as string, fields: displayFields, refs });
  }

  return ok({ total, results });
}

// ---- Verify — fact-checking primitive --------------------------------------

export async function verifyField(
  ctx: EngineContext,
  id: DocId,
  field: string,
  expected: unknown,
): Promise<Result<VerifyResult>> {
  const doc = ctx.backend.getDocument(id);
  if (!doc) {
    return ok({
      grounded: false,
      claim: 'field',
      expected,
      actual: null,
      source: { docId: id as string, filePath: '' },
    });
  }

  const fm = await readFrontmatter(ctx.projectRoot, doc);
  const actual = fm[field] ?? null;

  // Canonical comparison (handles dates, arrays, type coercion).
  // For Date values, compare against full ISO string. Day-form fallback
  // kept so pre-0.6.7 callers passing day-form strings still match
  // records that happen to have been parsed as Date objects.
  const actualStr = actual instanceof Date ? actual.toISOString() : String(actual ?? '');
  const expectedStr = expected instanceof Date ? expected.toISOString() : String(expected ?? '');
  const grounded = actualStr === expectedStr
    || (actual instanceof Date && String(expected ?? '') === actual.toISOString().slice(0, 10))
    || (expected instanceof Date && String(actual ?? '') === expected.toISOString().slice(0, 10))
    || (Array.isArray(expected) && Array.isArray(actual) && JSON.stringify(expected) === JSON.stringify(actual));

  return ok({
    grounded,
    claim: 'field',
    expected,
    actual,
    source: { docId: id as string, filePath: doc.filePath as string },
  });
}

export function verifyCount(
  ctx: EngineContext,
  dt: DocType,
  expectedCount: number,
  filters?: Record<string, import('../types.js').FilterCondition>,
): Result<VerifyResult> {
  const query: DocumentQuery = { docType: dt, limit: 0 };
  if (filters) query.filters = filters;
  const actual = ctx.backend.countDocuments(query);

  return ok({
    grounded: actual === expectedCount,
    claim: 'count',
    expected: expectedCount,
    actual,
    source: 'query',
  });
}

// ============================================================================
// changesSince — polling delta (0.5.0 R5).
// Strictly (updated_at, doc_id)-ordered. Cursor is opaque base64url-encoded
// JSON {u: updatedAt, d: docId}. Omitting cursor starts from the beginning.
// ============================================================================

const DEFAULT_CHANGES_LIMIT = 100;
const MAX_CHANGES_LIMIT = 1000;

export function encodeChangesCursor(cursor: ChangesSinceParsedCursor): string {
  const json = JSON.stringify({ u: cursor.updatedAt, d: cursor.docId });
  return Buffer.from(json, 'utf8').toString('base64url');
}

export function decodeChangesCursor(raw: string): Result<ChangesSinceParsedCursor> {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, 'base64url').toString('utf8');
  } catch {
    return singleErr('INVALID_FIELDS', 'cursor is not valid base64url');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return singleErr('INVALID_FIELDS', 'cursor payload is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object') {
    return singleErr('INVALID_FIELDS', 'cursor payload is not an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.u !== 'string' || typeof obj.d !== 'string') {
    return singleErr('INVALID_FIELDS', 'cursor payload missing u/d fields');
  }
  return ok({ updatedAt: obj.u, docId: obj.d });
}

export function changesSince(ctx: EngineContext, query: ChangesSinceQuery): Result<ChangesPage> {
  const rawLimit = query.limit ?? DEFAULT_CHANGES_LIMIT;
  if (!Number.isFinite(rawLimit) || rawLimit <= 0) {
    return singleErr('INVALID_FIELDS', 'limit must be a positive integer');
  }
  const limit = Math.min(Math.floor(rawLimit), MAX_CHANGES_LIMIT);

  let parsedCursor: ChangesSinceParsedCursor | null = null;
  if (query.cursor !== undefined && query.cursor !== '') {
    const result = decodeChangesCursor(query.cursor);
    if (!result.ok) return result;
    parsedCursor = result.value;
  }

  // Query one extra row to detect hasMore without a second round-trip.
  const rows = ctx.backend.listChangesSince({
    cursor: parsedCursor,
    limit: limit + 1,
    docTypes: query.docTypes,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const changes = page.map((r) => ({
    docId: r.docId,
    docType: r.docType,
    updatedAt: r.updatedAt,
    // version == 1 → first materialization of the doc (create).
    // version  > 1 → subsequent update. Deletes are not emitted in 0.5.0
    // because the engine does not tombstone (see spec).
    operation: (r.version <= 1 ? 'create' : 'update') as 'create' | 'update',
  }));

  const nextCursor = hasMore && changes.length > 0
    ? encodeChangesCursor({
        updatedAt: changes[changes.length - 1]!.updatedAt,
        docId: changes[changes.length - 1]!.docId,
      })
    : null;

  return ok({ changes, nextCursor, hasMore });
}
