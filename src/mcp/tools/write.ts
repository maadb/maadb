// ============================================================================
// Write tools — maad_create, maad_update, maad_validate, maad_bulk_*
// ============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { docId, docType } from '../../types.js';
import { resultToResponse, errorResponse } from '../response.js';
import { maadError } from '../../errors.js';
import { isDryRun, dryRunResponse, auditToolCall } from '../guardrails.js';
import type { InstanceCtx } from '../ctx.js';
import { withEngine } from '../with-session.js';
import { withIdempotency } from '../idempotency.js';
import { getRateLimiter } from '../rate-limit.js';
import { logWriteAudit } from '../../logging.js';

function checkWriteRate(sessionId: string, toolName: string): ReturnType<typeof errorResponse> | null {
  const rejection = getRateLimiter().tryAcquireWrite(sessionId);
  if (!rejection) return null;
  return errorResponse([
    maadError('RATE_LIMITED', `Write rate limit exceeded (${rejection.reason})`, undefined, {
      reason: rejection.reason,
      limit: rejection.limit,
      retryAfterMs: rejection.retryAfterMs,
      tool: toolName,
    }),
  ]);
}

function parseFields(raw: unknown): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') {
    try { const parsed = JSON.parse(raw); return typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; }
    catch { return null; }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return null;
}

interface AuditContext {
  requestId: string;
  sessionId: string;
  projectName: string;
  tool: string;
  docType?: string;
}

/**
 * Emit an audit line for a successful single-record write. Called after the
 * engine returns `ok: true`. version_before/version_after/changed_fields come
 * from the engine result shape. git_commit SHA is not currently threaded
 * through the engine result — set to null for now; 0.8.5 may plumb it.
 */
function auditSingleWrite(
  audit: AuditContext,
  result: { docId?: string | unknown; version?: number; changedFields?: string[] },
  versionBefore: number | null,
): void {
  logWriteAudit({
    request_id: audit.requestId,
    session_id: audit.sessionId,
    project: audit.projectName,
    tool: audit.tool,
    doc_id: typeof result.docId === 'string' ? result.docId : String(result.docId ?? ''),
    doc_type: audit.docType ?? null,
    version_before: versionBefore,
    version_after: result.version ?? null,
    changed_fields: result.changedFields ?? [],
    git_commit: null,
  });
}

/** Audit a successful bulk write. */
function auditBulkWrite(
  audit: AuditContext,
  result: { succeeded: Array<{ docId: string; version?: number }> },
): void {
  const docIds = result.succeeded.map((s) => s.docId);
  logWriteAudit({
    request_id: audit.requestId,
    session_id: audit.sessionId,
    project: audit.projectName,
    tool: audit.tool,
    doc_id: null,
    doc_ids: docIds,
    doc_type: audit.docType ?? null,
    version_before: null,
    version_after: null,
    changed_fields: [],
    git_commit: null,
  });
}

export function register(server: McpServer, ctx: InstanceCtx): number {
  server.registerTool('maad_create', {
    description: 'Creates a new markdown record. Schema-validated. Auto-commits to git. Returns the new docId, filePath, and version. Pass fields as an object: { name: "Acme", status: "active" }',
    inputSchema: z.object({
      docType: z.string().describe('Document type to create'),
      fields: z.any().describe('Frontmatter fields as object: { name: "Acme", status: "active" }'),
      body: z.string().optional().describe('Markdown body content'),
      docId: z.string().optional().describe('Custom doc_id (auto-generated if omitted)'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
      idempotencyKey: z.string().max(128).optional().describe('Opaque client-supplied key; scopes (project, tool, key) and dedupes retries within TTL'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_create', args, async ({ engine, projectName, sessionId, requestId }) =>
    withIdempotency(projectName, 'maad_create', args.idempotencyKey, requestId, async () => {
      const rateRejection = checkWriteRate(sessionId, 'maad_create');
      if (rateRejection) return rateRejection;
      auditToolCall('maad_create', args);
      if (isDryRun()) return dryRunResponse('maad_create', args);
      const fields = parseFields(args.fields);
      if (!fields) return errorResponse([maadError('INVALID_FIELDS', 'fields must be a JSON object, not a string or array')]);
      const result = await engine.createDocument(
        docType(args.docType),
        fields,
        args.body ?? undefined,
        args.docId ?? undefined,
      );
      if (result.ok) {
        auditSingleWrite(
          { requestId, sessionId, projectName, tool: 'maad_create', docType: args.docType },
          result.value as { docId?: unknown; version?: number; changedFields?: string[] },
          null, // version_before: null on create
        );
      }
      return resultToResponse(result, 'maad_create');
    }),
  ));

  server.registerTool('maad_update', {
    description: 'Updates a record\'s fields or body. Pass expectedVersion from a prior get to detect concurrent modifications.',
    inputSchema: z.object({
      docId: z.string().describe('Document ID to update'),
      fields: z.any().optional().describe('Frontmatter fields to update as object: { status: "closed" }'),
      body: z.string().optional().describe('Replace entire body'),
      appendBody: z.string().optional().describe('Append to existing body'),
      expectedVersion: z.number().optional().describe('Version from prior get — rejects if document has changed'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
      idempotencyKey: z.string().max(128).optional().describe('Opaque client-supplied key; scopes (project, tool, key) and dedupes retries within TTL'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_update', args, async ({ engine, projectName, sessionId, requestId }) =>
    withIdempotency(projectName, 'maad_update', args.idempotencyKey, requestId, async () => {
      const rateRejection = checkWriteRate(sessionId, 'maad_update');
      if (rateRejection) return rateRejection;
      auditToolCall('maad_update', args);
      if (isDryRun()) return dryRunResponse('maad_update', args);
      const fields = args.fields !== undefined ? parseFields(args.fields) : undefined;
      if (args.fields !== undefined && !fields) return errorResponse([{ code: 'INVALID_FIELDS', message: 'fields must be a JSON object, not a string or array' } as any]);
      const result = await engine.updateDocument(
        docId(args.docId),
        fields ?? undefined,
        args.body ?? undefined,
        args.appendBody ?? undefined,
        args.expectedVersion ?? undefined,
      );
      if (result.ok) {
        const value = result.value as { docId?: unknown; version?: number; changedFields?: string[] };
        const versionBefore = typeof value.version === 'number' ? value.version - 1 : null;
        auditSingleWrite(
          { requestId, sessionId, projectName, tool: 'maad_update' },
          value,
          versionBefore,
        );
      }
      return resultToResponse(result, 'maad_update');
    }),
  ));

  server.registerTool('maad_validate', {
    description: 'Validates one or all documents against their schemas. Returns validation report with any errors.',
    inputSchema: z.object({
      docId: z.string().optional().describe('Validate a specific document (all if omitted)'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_validate', args, async ({ engine }) => {
    const result = await engine.validate(args.docId ? docId(args.docId) : undefined);
    return resultToResponse(result);
  }));

  server.registerTool('maad_bulk_create', {
    description: 'Creates multiple records in one call. Validates each record, writes files, single git commit. Returns per-record success/failure. Much faster than individual creates for imports.',
    inputSchema: z.object({
      records: z.array(z.object({
        docType: z.string().describe('Document type'),
        fields: z.any().describe('Frontmatter fields'),
        body: z.string().optional().describe('Markdown body'),
        docId: z.string().optional().describe('Custom ID (auto-generated if omitted)'),
      })).describe('Array of records to create'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
      idempotencyKey: z.string().max(128).optional().describe('Opaque client-supplied key; scopes (project, tool, key) and dedupes retries within TTL'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_bulk_create', args, async ({ engine, projectName, sessionId, requestId }) =>
    withIdempotency(projectName, 'maad_bulk_create', args.idempotencyKey, requestId, async () => {
      const rateRejection = checkWriteRate(sessionId, 'maad_bulk_create');
      if (rateRejection) return rateRejection;
      auditToolCall('maad_bulk_create', { count: args.records.length });
      if (isDryRun()) return dryRunResponse('maad_bulk_create', { count: args.records.length });
      const result = await engine.bulkCreate(args.records as any);
      if (result.ok) {
        const value = result.value as { succeeded: Array<{ docId: string; version?: number }> };
        if (value.succeeded.length > 0) {
          auditBulkWrite(
            { requestId, sessionId, projectName, tool: 'maad_bulk_create' },
            value,
          );
        }
      }
      return resultToResponse(result);
    }),
  ));

  server.registerTool('maad_bulk_update', {
    description: 'Updates multiple records in one call. Returns per-record success/failure.',
    inputSchema: z.object({
      updates: z.array(z.object({
        docId: z.string().describe('Document ID to update'),
        fields: z.any().optional().describe('Frontmatter fields to update'),
        body: z.string().optional().describe('Replace entire body'),
        appendBody: z.string().optional().describe('Append to body'),
      })).describe('Array of updates'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
      idempotencyKey: z.string().max(128).optional().describe('Opaque client-supplied key; scopes (project, tool, key) and dedupes retries within TTL'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_bulk_update', args, async ({ engine, projectName, sessionId, requestId }) =>
    withIdempotency(projectName, 'maad_bulk_update', args.idempotencyKey, requestId, async () => {
      const rateRejection = checkWriteRate(sessionId, 'maad_bulk_update');
      if (rateRejection) return rateRejection;
      auditToolCall('maad_bulk_update', { count: args.updates.length });
      if (isDryRun()) return dryRunResponse('maad_bulk_update', { count: args.updates.length });
      const result = await engine.bulkUpdate(args.updates as any);
      if (result.ok) {
        const value = result.value as { succeeded: Array<{ docId: string; version?: number }> };
        if (value.succeeded.length > 0) {
          auditBulkWrite(
            { requestId, sessionId, projectName, tool: 'maad_bulk_update' },
            value,
          );
        }
      }
      return resultToResponse(result);
    }),
  ));

  return 5;
}
