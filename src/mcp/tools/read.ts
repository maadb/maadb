// ============================================================================
// Read tools — maad_get, maad_query, maad_search, maad_related, maad_schema,
//              maad_aggregate, maad_verify, maad_join
// ============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { docId, docType, type ObjectQuery } from '../../types.js';
import { resultToResponse, attachMeta, guardResponseSize } from '../response.js';
import type { InstanceCtx } from '../ctx.js';
import { withEngine } from '../with-session.js';

export function register(server: McpServer, ctx: InstanceCtx): number {
  server.registerTool('maad_get', {
    description: 'Reads a markdown-backed record at increasing depth: hot (frontmatter), warm (+block), cold (full body), full (resolved refs+objects+related, provisional composite).',
    inputSchema: z.object({
      docId: z.string().describe('Document ID to read'),
      depth: z.enum(['hot', 'warm', 'cold', 'full']).default('hot')
        .describe('hot=frontmatter, warm=+block, cold=full body, full=resolved refs+objects+related'),
      block: z.string().optional().describe('Block ID or heading (warm depth only)'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_get', args, async ({ engine }) => {
    if (args.depth === 'full') {
      return resultToResponse(await engine.getDocumentFull(docId(args.docId)), 'maad_get');
    }
    return resultToResponse(await engine.getDocument(docId(args.docId), args.depth, args.block ?? undefined), 'maad_get');
  }));

  server.registerTool('maad_query', {
    description: 'Finds documents by type with optional field filters and projection. Filters support shorthand eq, single-op, between shortcut, and array-of-ops (AND semantics). Use fields to return frontmatter values inline instead of chasing IDs.',
    inputSchema: z.object({
      docType: z.string().describe('Document type to query'),
      filters: z.any().optional().describe('Field filters. Shorthand: { status: "active" }. Single op: { opened_at: { op: "gte", value: "2026-01-01" } }. Range shortcut: { opened_at: { op: "between", value: ["2026-03-01", "2026-03-31"] } }. Array-of-ops (AND): { opened_at: [{op: "gte", value: "2026-03-01"}, {op: "lte", value: "2026-03-31"}] }. Ops: eq, neq, gt, gte, lt, lte, in, contains, between.'),
      fields: z.array(z.string()).optional().describe('Field names to return inline (e.g. ["name", "status"]). Indexed fields only.'),
      sortBy: z.string().optional().describe('Indexed field to sort by'),
      sortOrder: z.enum(['asc', 'desc']).optional().describe('Sort direction (default desc)'),
      limit: z.number().optional().describe('Max results (default 50, capped at 500). Over-requests are clamped silently with _meta.limit_clamped set.'),
      offset: z.number().optional().describe('Skip first N results'),
      includeFilePath: z.boolean().optional().describe('Include filePath in each result row (default false — omitted to trim response size)'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_query', args, ({ engine }) => {
    const query: import('../../types.js').DocumentQuery = { docType: docType(args.docType) };
    if (args.filters !== undefined) query.filters = args.filters as any;
    if (args.fields !== undefined) query.fields = args.fields;
    if (args.sortBy !== undefined) query.sortBy = args.sortBy;
    if (args.sortOrder !== undefined) query.sortOrder = args.sortOrder;
    if (args.limit !== undefined) query.limit = args.limit;
    if (args.offset !== undefined) query.offset = args.offset;
    const result = engine.findDocuments(query);
    // 0.7.0 — default-strip filePath to trim response size. Clients that
    // need the on-disk path opt in via includeFilePath:true. Backend still
    // produces the field; we drop it at the MCP boundary.
    let effective = result;
    if (result.ok && args.includeFilePath !== true) {
      const stripped = result.value.results.map(r => {
        const { filePath, ...rest } = r;
        void filePath;
        return rest;
      });
      const newValue: import('../../engine/types.js').FindResult = {
        total: result.value.total,
        results: stripped as typeof result.value.results,
      };
      if (result.value.limitClamped) newValue.limitClamped = result.value.limitClamped;
      effective = { ok: true, value: newValue } as typeof result;
    }
    let response = resultToResponse(effective, 'maad_query');
    // 0.7.1 — surface engine limit-clamping in _meta, then guard response size.
    if (effective.ok && effective.value.limitClamped) {
      response = attachMeta(response, { limit_clamped: effective.value.limitClamped });
    }
    return guardResponseSize(response, { tool: 'maad_query' });
  }));

  server.registerTool('maad_search', {
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
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_search', args, ({ engine }) => {
    const query: ObjectQuery = { primitive: args.primitive as any };
    if (args.subtype !== undefined) query.subtype = args.subtype;
    if (args.value !== undefined) query.value = args.value;
    const containsValue = args.query ?? args.contains;
    if (containsValue !== undefined) query.contains = containsValue;
    if (args.docId !== undefined) query.docId = docId(args.docId);
    if (args.limit !== undefined) query.limit = args.limit;
    if (args.offset !== undefined) query.offset = args.offset;
    return resultToResponse(engine.searchObjects(query), 'maad_search');
  }));

  server.registerTool('maad_related', {
    description: 'Returns documents connected to a given doc via ref fields.',
    inputSchema: z.object({
      docId: z.string().describe('Document ID'),
      direction: z.enum(['outgoing', 'incoming', 'both']).default('both')
        .describe('outgoing=docs this references, incoming=docs that reference this, both=all'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_related', args, ({ engine }) => {
    return resultToResponse(engine.listRelated(docId(args.docId), args.direction), 'maad_related');
  }));

  server.registerTool('maad_schema', {
    description: 'Returns field definitions, required fields, enum values, ID prefix, and format hints for a type. Use before create/update to know what fields to pass and how to format values.',
    inputSchema: z.object({
      docType: z.string().describe('Document type'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_schema', args, ({ engine }) => {
    return resultToResponse(engine.schemaInfo(docType(args.docType)), 'maad_schema');
  }));

  server.registerTool('maad_aggregate', {
    description: 'Groups documents by a field and optionally computes a metric (count/sum/avg/min/max) on another field. Supports multi-hop ref chains in groupBy (e.g. "client->industry") for cross-doctype aggregates — resolves refs at query time, merges groups that collapse to the same leaf value. Use instead of iterating records for totals.',
    inputSchema: z.object({
      docType: z.string().optional().describe('Document type to scope (optional; required for ref-chain groupBy)'),
      groupBy: z.string().describe('Field name or ref chain to group by. Single field: "status". Multi-hop chain: "client_id->industry" or "case_id->account_id->name". Each non-leaf segment must be a ref field on its parent type.'),
      metric: z.object({
        field: z.string().describe('Field to aggregate (must be indexed, numeric for sum/avg/min/max)'),
        op: z.enum(['count', 'sum', 'avg', 'min', 'max']).describe('Aggregation operation'),
      }).optional().describe('Optional metric to compute per group. Without this, returns count per group value.'),
      filters: z.any().optional().describe('Field filters (same format as maad_query — shorthand, single-op, between shortcut, array-of-ops with AND semantics).'),
      limit: z.number().optional().describe('Max groups to return (default 50, capped at 2000). Over-requests are clamped silently with _meta.limit_clamped set.'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_aggregate', args, ({ engine }) => {
    const query: import('../../engine/types.js').AggregateQuery = {
      groupBy: args.groupBy,
    };
    if (args.docType !== undefined) query.docType = docType(args.docType);
    if (args.metric !== undefined) query.metric = args.metric;
    if (args.filters !== undefined) query.filters = args.filters as any;
    if (args.limit !== undefined) query.limit = args.limit;
    const result = engine.aggregate(query);
    let response = resultToResponse(result, 'maad_aggregate');
    // 0.7.1 — surface engine limit-clamping in _meta, then guard response size.
    if (result.ok && result.value.limitClamped) {
      response = attachMeta(response, { limit_clamped: result.value.limitClamped });
    }
    return guardResponseSize(response, { tool: 'maad_aggregate' });
  }));

  server.registerTool('maad_verify', {
    description: 'Fact-check a claim against the database. Two modes: (1) field — verify a specific field value on a document, (2) count — verify a document count for a type with optional filters. Use this BEFORE stating any number, date, amount, or count as fact.',
    inputSchema: z.object({
      mode: z.enum(['field', 'count']).describe('Verification mode'),
      docId: z.string().optional().describe('Document ID (required for field mode)'),
      field: z.string().optional().describe('Field name to verify (required for field mode)'),
      expected: z.any().optional().describe('Expected value for the field (required for field mode)'),
      docType: z.string().optional().describe('Document type (required for count mode)'),
      expectedCount: z.number().optional().describe('Expected document count (required for count mode)'),
      filters: z.any().optional().describe('Field filters for count mode (same format as maad_query)'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_verify', args, async ({ engine }) => {
    if (args.mode === 'field') {
      if (!args.docId || !args.field || args.expected === undefined) {
        return resultToResponse({ ok: false, errors: [{ code: 'INVALID_ARGS', message: 'field mode requires docId, field, and expected' }] } as any, 'maad_verify');
      }
      return resultToResponse(await engine.verifyField(docId(args.docId), args.field, args.expected), 'maad_verify');
    }
    if (args.mode === 'count') {
      if (!args.docType || args.expectedCount === undefined) {
        return resultToResponse({ ok: false, errors: [{ code: 'INVALID_ARGS', message: 'count mode requires docType and expectedCount' }] } as any, 'maad_verify');
      }
      return resultToResponse(engine.verifyCount(docType(args.docType), args.expectedCount, args.filters as any), 'maad_verify');
    }
    return resultToResponse({ ok: false, errors: [{ code: 'INVALID_ARGS', message: 'mode must be "field" or "count"' }] } as any, 'maad_verify');
  }));

  server.registerTool('maad_join', {
    description: 'Queries documents and follows ref fields to return projected fields from both source and target records in one call. Eliminates N+1 round-trips. Example: all cases with their client name and attorney name.',
    inputSchema: z.object({
      docType: z.string().describe('Source document type to query'),
      refs: z.array(z.string()).describe('Ref field names to follow (e.g. ["client", "assigned_attorney"])'),
      fields: z.array(z.string()).optional().describe('Fields to return from source documents'),
      refFields: z.record(z.string(), z.array(z.string())).optional().describe('Fields to return from each ref target: { "client": ["name", "industry"], "assigned_attorney": ["first_name"] }'),
      filters: z.any().optional().describe('Field filters on source documents (same format as maad_query)'),
      limit: z.number().optional().describe('Max results (default 50)'),
      offset: z.number().optional().describe('Skip first N results'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_join', args, ({ engine }) => {
    const query: import('../../engine/types.js').JoinQuery = {
      docType: docType(args.docType),
      refs: args.refs,
    };
    if (args.fields !== undefined) query.fields = args.fields;
    if (args.refFields !== undefined) query.refFields = args.refFields;
    if (args.filters !== undefined) query.filters = args.filters as any;
    if (args.limit !== undefined) query.limit = args.limit;
    if (args.offset !== undefined) query.offset = args.offset;
    return resultToResponse(engine.join(query), 'maad_join');
  }));

  server.registerTool('maad_changes_since', {
    description: 'Polling delta. Returns records with updated_at > cursor, ordered (updated_at ASC, doc_id ASC). Omit cursor to start. Pass nextCursor back verbatim to paginate; hasMore signals more pages. Operation: create | update (deletes not emitted).',
    inputSchema: z.object({
      cursor: z.string().optional().describe('Opaque cursor from a previous response. Omit on first call.'),
      limit: z.number().int().positive().optional().describe('Max changes per page (default 100, max 1000).'),
      docTypes: z.array(z.string()).optional().describe('Filter to these document types only.'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_changes_since', args, ({ engine }) => {
    const q: import('../../engine/types.js').ChangesSinceQuery = {};
    if (args.cursor !== undefined) q.cursor = args.cursor;
    if (args.limit !== undefined) q.limit = args.limit;
    if (args.docTypes !== undefined) q.docTypes = args.docTypes;
    return resultToResponse(engine.changesSince(q), 'maad_changes_since');
  }));

  return 9;
}
