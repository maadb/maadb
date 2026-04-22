// ============================================================================
// Write tools — maad_create, maad_update, maad_validate, maad_bulk_*
// ============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { docId, docType } from '../../types.js';
import type { CreateResult, UpdateResult, BulkResult } from '../../engine/types.js';
import { resultToResponse, errorResponse, attachWarnings, attachDurability } from '../response.js';
import { maadError } from '../../errors.js';
import { isDryRun, dryRunResponse, auditToolCall } from '../guardrails.js';
import type { InstanceCtx } from '../ctx.js';
import { withEngine } from '../with-session.js';
import { withIdempotency } from '../idempotency.js';
import { getRateLimiter } from '../rate-limit.js';
import { logWriteAudit, logValidationWarning } from '../../logging.js';
import type { ValidationWarning } from '../../types.js';
import { notifyWrite, type ChangeEvent } from '../notifications.js';

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
  // 0.7.0 — identity snapshot from the session's token (undefined in
  // stdio/synthetic mode). Propagates to audit events.
  token?: import('../../auth/types.js').TokenRecord;
  role?: string;
}

function logWarnings(
  audit: AuditContext,
  docId: string | null,
  warnings: ValidationWarning[] | undefined,
): void {
  if (!warnings || warnings.length === 0) return;
  for (const w of warnings) {
    logValidationWarning({
      request_id: audit.requestId,
      session_id: audit.sessionId,
      project: audit.projectName,
      tool: audit.tool,
      doc_id: docId,
      doc_type: audit.docType ?? null,
      field: w.field,
      code: w.code,
      message: w.message,
    });
  }
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
  const fields: Parameters<typeof logWriteAudit>[0] = {
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
  };
  if (audit.token) {
    fields.token_id = audit.token.id;
    if (audit.token.agentId !== undefined) fields.agent_id = audit.token.agentId;
    if (audit.token.userId !== undefined) fields.user_id = audit.token.userId;
  }
  if (audit.role !== undefined) fields.role = audit.role;
  logWriteAudit(fields);
}

/** Audit a successful bulk write. */
function auditBulkWrite(
  audit: AuditContext,
  result: { succeeded: Array<{ docId: string; version?: number }> },
): void {
  const docIds = result.succeeded.map((s) => s.docId);
  const fields: Parameters<typeof logWriteAudit>[0] = {
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
  };
  if (audit.token) {
    fields.token_id = audit.token.id;
    if (audit.token.agentId !== undefined) fields.agent_id = audit.token.agentId;
    if (audit.token.userId !== undefined) fields.user_id = audit.token.userId;
  }
  if (audit.role !== undefined) fields.role = audit.role;
  logWriteAudit(fields);
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
  }, async (args, extra) => withEngine(ctx, extra, 'maad_create', args, async ({ engine, projectName, sessionId, requestId, role, token }) =>
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
        const ctxAudit: AuditContext = { requestId, sessionId, projectName, tool: 'maad_create', docType: args.docType, role };
        if (token !== undefined) ctxAudit.token = token;
        auditSingleWrite(
          ctxAudit,
          result.value as { docId?: unknown; version?: number; changedFields?: string[] },
          null, // version_before: null on create
        );
        logWarnings(ctxAudit, String((result.value as CreateResult).docId ?? ''), (result.value as CreateResult).validation.warnings);
      }
      const response = resultToResponse(result, 'maad_create');
      if (!result.ok) return response;
      const value = result.value as CreateResult;
      if (value.writeDurable) {
        await notifyWrite(ctx, {
          action: 'create',
          docId: String(value.docId),
          docType: args.docType,
          project: projectName,
          updatedAt: new Date().toISOString(),
        });
      }
      return attachDurability(attachWarnings(response, value.validation.warnings), value.writeDurable, value.commitFailure);
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
  }, async (args, extra) => withEngine(ctx, extra, 'maad_update', args, async ({ engine, projectName, sessionId, requestId, role, token }) =>
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
        const ctxAudit: AuditContext = { requestId, sessionId, projectName, tool: 'maad_update', role };
        if (token !== undefined) ctxAudit.token = token;
        auditSingleWrite(ctxAudit, value, versionBefore);
        logWarnings(ctxAudit, String((result.value as UpdateResult).docId ?? ''), (result.value as UpdateResult).validation.warnings);
      }
      const response = resultToResponse(result, 'maad_update');
      if (!result.ok) return response;
      const value = result.value as UpdateResult;
      // Only fire on real state change: durable AND the update actually
      // touched the file. changedFields empty + no body mutation = noop,
      // which engine reports as writeDurable:true but should NOT notify.
      if (value.writeDurable && (value.changedFields.length > 0 || args.body !== undefined || args.appendBody !== undefined)) {
        await notifyWrite(ctx, {
          action: 'update',
          docId: String(value.docId),
          docType: String(value.docType),
          project: projectName,
          updatedAt: new Date().toISOString(),
        });
      }
      return attachDurability(attachWarnings(response, value.validation.warnings), value.writeDurable, value.commitFailure);
    }),
  ));

  server.registerTool('maad_validate', {
    description: 'Validates one or all documents against their schemas. Returns validation report with any errors. Pass includePrecision: true to audit date fields for stored values coarser than their declared store_precision (0.6.7+) — informational, never counted as invalid.',
    inputSchema: z.object({
      docId: z.string().optional().describe('Validate a specific document (all if omitted)'),
      includePrecision: z.boolean().optional().describe('If true, report historical date values coarser than the schema\'s store_precision. Non-blocking; returns a precisionDrift array in the report.'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_validate', args, async ({ engine }) => {
    const options = args.includePrecision !== undefined ? { includePrecision: args.includePrecision } : undefined;
    const result = await engine.validate(args.docId ? docId(args.docId) : undefined, options);
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
  }, async (args, extra) => withEngine(ctx, extra, 'maad_bulk_create', args, async ({ engine, projectName, sessionId, requestId, role, token }) =>
    withIdempotency(projectName, 'maad_bulk_create', args.idempotencyKey, requestId, async () => {
      const rateRejection = checkWriteRate(sessionId, 'maad_bulk_create');
      if (rateRejection) return rateRejection;
      auditToolCall('maad_bulk_create', { count: args.records.length });
      if (isDryRun()) return dryRunResponse('maad_bulk_create', { count: args.records.length });
      const result = await engine.bulkCreate(args.records as any);
      if (result.ok) {
        const bulk = result.value as BulkResult;
        const ctxAudit: AuditContext = { requestId, sessionId, projectName, tool: 'maad_bulk_create', role };
        if (token !== undefined) ctxAudit.token = token;
        if (bulk.succeeded.length > 0) {
          auditBulkWrite(ctxAudit, bulk);
        }
        for (const s of bulk.succeeded) logWarnings(ctxAudit, s.docId, s.warnings);
      }
      const response = resultToResponse(result);
      if (!result.ok) return response;
      const value = result.value as BulkResult;
      if (value.writeDurable && value.succeeded.length > 0) {
        const now = new Date().toISOString();
        for (const s of value.succeeded) {
          await notifyWrite(ctx, {
            action: 'create',
            docId: s.docId,
            docType: s.docType,
            project: projectName,
            updatedAt: now,
          });
        }
      }
      return attachDurability(attachWarnings(response, value.warnings), value.writeDurable, value.commitFailure);
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
  }, async (args, extra) => withEngine(ctx, extra, 'maad_bulk_update', args, async ({ engine, projectName, sessionId, requestId, role, token }) =>
    withIdempotency(projectName, 'maad_bulk_update', args.idempotencyKey, requestId, async () => {
      const rateRejection = checkWriteRate(sessionId, 'maad_bulk_update');
      if (rateRejection) return rateRejection;
      auditToolCall('maad_bulk_update', { count: args.updates.length });
      if (isDryRun()) return dryRunResponse('maad_bulk_update', { count: args.updates.length });
      const result = await engine.bulkUpdate(args.updates as any);
      if (result.ok) {
        const bulk = result.value as BulkResult;
        const ctxAudit: AuditContext = { requestId, sessionId, projectName, tool: 'maad_bulk_update', role };
        if (token !== undefined) ctxAudit.token = token;
        if (bulk.succeeded.length > 0) {
          auditBulkWrite(ctxAudit, bulk);
        }
        for (const s of bulk.succeeded) logWarnings(ctxAudit, s.docId, s.warnings);
      }
      const response = resultToResponse(result);
      if (!result.ok) return response;
      const value = result.value as BulkResult;
      if (value.writeDurable && value.succeeded.length > 0) {
        const now = new Date().toISOString();
        for (const s of value.succeeded) {
          await notifyWrite(ctx, {
            action: 'update',
            docId: s.docId,
            docType: s.docType,
            project: projectName,
            updatedAt: now,
          });
        }
      }
      return attachDurability(attachWarnings(response, value.warnings), value.writeDurable, value.commitFailure);
    }),
  ));

  return 5;
}
