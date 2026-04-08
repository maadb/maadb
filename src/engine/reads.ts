// ============================================================================
// Reads — getDocument, findDocuments, searchObjects, listRelated,
//         describe, summary, getSchema, schemaInfo
// ============================================================================

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ok, singleErr, type Result } from '../errors.js';
import { logger } from './logger.js';
import {
  docId as toDocId,
  docType as toDocType,
  type DocId,
  type DocType,
  type SchemaDefinition,
  type DocumentQuery,
  type ObjectQuery,
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
  AggregateQuery,
  AggregateResult,
  JoinQuery,
  JoinResult,
  JoinResultRow,
} from './types.js';
import { readFrontmatter, readBlockContent } from './helpers.js';

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

export function findDocuments(ctx: EngineContext, query: DocumentQuery): Result<FindResult> {
  const results = ctx.backend.findDocuments(query);
  const total = ctx.backend.countDocuments(query);

  if (query.fields && query.fields.length > 0 && results.length > 0) {
    const docIds = results.map(r => r.docId);
    const fieldValues = ctx.backend.getFieldValues(docIds, query.fields);
    for (const match of results) {
      match.fields = fieldValues.get(match.docId as string) ?? {};
    }
  }

  return ok({ total, results });
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
  };
}

export function summary(ctx: EngineContext): SummaryResult {
  const stats = ctx.backend.getStats();

  const types = [...ctx.registry.types.values()].map(rt => ({
    type: rt.name as string,
    count: stats.documentCountByType[rt.name as string] ?? 0,
    sampleIds: ctx.backend.getSampleDocIds(rt.name, 3).map(id => id as string),
  }));

  const subtypeInventory = ctx.backend.getSubtypeInventory(20);

  return {
    types,
    totalDocuments: stats.totalDocuments,
    totalObjects: stats.totalObjects,
    totalRelationships: stats.totalRelationships,
    lastIndexedAt: stats.lastIndexedAt,
    subtypeInventory,
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

    const format = field.format ?? (field.type === 'amount' ? '<number> <currency> (e.g. 1250.00 USD)' : null);

    fields.push({
      name,
      type: typeStr,
      required: schema.required.includes(name),
      indexed: field.index,
      values: field.values,
      target: field.target as string | null,
      format,
      default: field.defaultValue,
    });
  }

  const templateHeadings = schema.template
    ? schema.template.map(t => ({ level: t.level, text: t.text }))
    : null;

  return ok({
    type: dt as string,
    idPrefix: regType.idPrefix as string,
    schemaRef: regType.schemaRef as string,
    fields,
    templateHeadings,
  });
}

export function aggregate(ctx: EngineContext, query: AggregateQuery): Result<AggregateResult> {
  return ok(ctx.backend.aggregate(query));
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
