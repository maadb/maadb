// ============================================================================
// Read tools — maad.get, maad.query, maad.search, maad.related, maad.schema
// ============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MaadEngine } from '../../engine.js';
import { docId, docType, type ObjectQuery } from '../../types.js';
import { resultToResponse } from '../response.js';

export function register(server: McpServer, engine: MaadEngine): void {
  server.registerTool('maad.get', {
    description: 'Reads a markdown-backed record at increasing depth: hot (frontmatter), warm (+block), cold (full body), full (resolved refs+objects+related, provisional composite).',
    inputSchema: z.object({
      docId: z.string().describe('Document ID to read'),
      depth: z.enum(['hot', 'warm', 'cold', 'full']).default('hot')
        .describe('hot=frontmatter, warm=+block, cold=full body, full=resolved refs+objects+related'),
      block: z.string().optional().describe('Block ID or heading (warm depth only)'),
    }),
  }, async (args) => {
    if (args.depth === 'full') {
      return resultToResponse(await engine.getDocumentFull(docId(args.docId)), 'maad.get');
    }
    return resultToResponse(await engine.getDocument(docId(args.docId), args.depth, args.block ?? undefined), 'maad.get');
  });

  server.registerTool('maad.query', {
    description: 'Finds documents by type with optional field filters and projection. Filters support operators: eq, neq, gt, gte, lt, lte (dates as ISO strings work for ranges), in, contains. Use fields to return frontmatter values instead of just IDs.',
    inputSchema: z.object({
      docType: z.string().describe('Document type to query'),
      filters: z.any().optional().describe('Field filters: { fieldName: { op: "eq"|"neq"|"gt"|"gte"|"lt"|"lte"|"in"|"contains", value: ... } }. Examples: { status: { op: "eq", value: "active" } }, { opened_at: { op: "gte", value: "2025-01-01" } }'),
      fields: z.array(z.string()).optional().describe('Field names to return in results (e.g. ["name", "status", "opened_at"]). Only indexed fields available.'),
      limit: z.number().optional().describe('Max results (default 50)'),
      offset: z.number().optional().describe('Skip first N results'),
    }),
  }, (args) => {
    const query: import('../../types.js').DocumentQuery = { docType: docType(args.docType) };
    if (args.filters !== undefined) query.filters = args.filters as any;
    if (args.fields !== undefined) query.fields = args.fields;
    if (args.limit !== undefined) query.limit = args.limit;
    if (args.offset !== undefined) query.offset = args.offset;
    return resultToResponse(engine.findDocuments(query), 'maad.query');
  });

  server.registerTool('maad.search', {
    description: 'Searches extracted objects across all documents. Filter by primitive + optional subtype, then narrow with query (substring) or value (exact). Without query or value, returns ALL objects matching primitive/subtype.',
    inputSchema: z.object({
      primitive: z.string().describe('Extraction primitive (entity, date, amount, etc.)'),
      subtype: z.string().optional().describe('Subtype filter (person, org, attorney, etc.)'),
      query: z.string().optional().describe('Substring match on values (e.g. "Attorney" matches "Lead Attorney")'),
      value: z.string().optional().describe('Exact value match (must match the full extracted value)'),
      contains: z.string().optional().describe('Alias for query — substring match on values'),
      docId: z.string().optional().describe('Scope search to a single document'),
      limit: z.number().optional().describe('Max results (default 50)'),
      offset: z.number().optional().describe('Skip first N results'),
    }),
  }, (args) => {
    const query: ObjectQuery = { primitive: args.primitive as any };
    if (args.subtype !== undefined) query.subtype = args.subtype;
    if (args.value !== undefined) query.value = args.value;
    const containsValue = args.query ?? args.contains;
    if (containsValue !== undefined) query.contains = containsValue;
    if (args.docId !== undefined) query.docId = docId(args.docId);
    if (args.limit !== undefined) query.limit = args.limit;
    if (args.offset !== undefined) query.offset = args.offset;
    return resultToResponse(engine.searchObjects(query), 'maad.search');
  });

  server.registerTool('maad.related', {
    description: 'Returns documents connected to a given doc via ref fields.',
    inputSchema: z.object({
      docId: z.string().describe('Document ID'),
      direction: z.enum(['outgoing', 'incoming', 'both']).default('both')
        .describe('outgoing=docs this references, incoming=docs that reference this, both=all'),
    }),
  }, (args) => {
    return resultToResponse(engine.listRelated(docId(args.docId), args.direction), 'maad.related');
  });

  server.registerTool('maad.schema', {
    description: 'Returns field definitions, required fields, enum values, ID prefix, and format hints for a type. Use before create/update to know what fields to pass and how to format values.',
    inputSchema: z.object({
      docType: z.string().describe('Document type'),
    }),
  }, (args) => {
    return resultToResponse(engine.schemaInfo(docType(args.docType)), 'maad.schema');
  });

  server.registerTool('maad.aggregate', {
    description: 'Groups documents by a field and optionally computes a metric (count/sum/avg/min/max) on another field. Examples: count cases by status, sum claim_amount by attorney, avg amount by year.',
    inputSchema: z.object({
      docType: z.string().optional().describe('Document type to scope (optional)'),
      groupBy: z.string().describe('Field name to group by (e.g. "status", "assigned_attorney")'),
      metric: z.object({
        field: z.string().describe('Field to aggregate (must be indexed, numeric for sum/avg/min/max)'),
        op: z.enum(['count', 'sum', 'avg', 'min', 'max']).describe('Aggregation operation'),
      }).optional().describe('Optional metric to compute per group. Without this, returns count per group value.'),
      filters: z.any().optional().describe('Field filters (same format as maad.query filters)'),
      limit: z.number().optional().describe('Max groups to return (default 50)'),
    }),
  }, (args) => {
    const query: import('../../engine/types.js').AggregateQuery = {
      groupBy: args.groupBy,
    };
    if (args.docType !== undefined) query.docType = docType(args.docType);
    if (args.metric !== undefined) query.metric = args.metric;
    if (args.filters !== undefined) query.filters = args.filters as any;
    if (args.limit !== undefined) query.limit = args.limit;
    return resultToResponse(engine.aggregate(query), 'maad.aggregate');
  });

  server.registerTool('maad.join', {
    description: 'Queries documents and follows ref fields to return projected fields from both source and target records in one call. Eliminates N+1 round-trips. Example: all cases with their client name and attorney name.',
    inputSchema: z.object({
      docType: z.string().describe('Source document type to query'),
      refs: z.array(z.string()).describe('Ref field names to follow (e.g. ["client", "assigned_attorney"])'),
      fields: z.array(z.string()).optional().describe('Fields to return from source documents'),
      refFields: z.record(z.string(), z.array(z.string())).optional().describe('Fields to return from each ref target: { "client": ["name", "industry"], "assigned_attorney": ["first_name"] }'),
      filters: z.any().optional().describe('Field filters on source documents (same format as maad.query)'),
      limit: z.number().optional().describe('Max results (default 50)'),
      offset: z.number().optional().describe('Skip first N results'),
    }),
  }, (args) => {
    const query: import('../../engine/types.js').JoinQuery = {
      docType: docType(args.docType),
      refs: args.refs,
    };
    if (args.fields !== undefined) query.fields = args.fields;
    if (args.refFields !== undefined) query.refFields = args.refFields;
    if (args.filters !== undefined) query.filters = args.filters as any;
    if (args.limit !== undefined) query.limit = args.limit;
    if (args.offset !== undefined) query.offset = args.offset;
    return resultToResponse(engine.join(query), 'maad.join');
  });
}
