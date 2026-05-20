// ============================================================================
// 0.7.10 — Destructive cleanup primitives. Four admin-tier tools governed by
// the confirm-contract foundation (P1) that landed in rc.1:
//
//   maad_bulk_delete         — explicit docId list, soft or hard.
//   maad_delete_where        — filter-driven, composes query + bulk_delete.
//   maad_purge_soft_deleted  — hard-delete the cemetery older than a threshold.
//   maad_repair_where        — filter-driven tolerant repair via strategy registry.
//
// Contract (per docs/specs/0.7.10-integrity-cleanup.md §confirm-contract):
//   - confirm:true required to mutate; otherwise dry-run returns the would-
//     affect set with no side effects.
//   - maxRecords default 100, ceiling 1000, with per-tool env override
//     MAAD_CLEANUP_MAX_RECORDS_<TOOL_SUFFIX>. Tool arg > env > default.
//   - Exceeding the cap returns BULK_LIMIT_EXCEEDED with chunking hint.
//   - One commit per call on confirmed runs (atomic batch).
//   - Audit log carries confirm_mode: 'dry_run' | 'confirmed' via auditToolCall
//     extras.
//   - Optional idempotencyKey deduplicates retries within TTL via withIdempotency.
// ============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InstanceCtx } from '../ctx.js';
import { withEngine } from '../with-session.js';
import { withIdempotency } from '../idempotency.js';
import { auditToolCall } from '../guardrails.js';
import { resultToResponse, errorResponse, successResponse, attachDurability } from '../response.js';
import { maadError } from '../../errors.js';
import { docId as toDocId, docType as toDocType, type DocumentQuery, type FilterCondition } from '../../types.js';
import {
  resolveCleanupMaxRecords,
  checkCleanupSize,
} from '../bulk-cap.js';
import { notifyWrite } from '../notifications.js';
import type { BulkDeleteResult, PurgeSoftDeletedResult, RepairStrategyName, RepairWhereResult } from '../../engine/types.js';

const REPAIR_STRATEGY_NAMES = ['prune_orphan_refs', 'fix_schema_drift'] as const;

const DEFAULT_PURGE_RETENTION_DAYS = 30;

function resolvePurgeRetentionDays(): number {
  const raw = process.env.MAAD_PURGE_DEFAULT_RETENTION_DAYS;
  if (!raw) return DEFAULT_PURGE_RETENTION_DAYS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_PURGE_RETENTION_DAYS;
  return n;
}

function dryRunResponseAffected(
  toolName: string,
  affected: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) {
  return successResponse({
    dryRun: true,
    tool: toolName,
    confirmMode: 'dry_run',
    totalAffected: affected.length,
    affected,
    ...extra,
  }, toolName);
}

export function register(server: McpServer, ctx: InstanceCtx): number {
  // --------------------------------------------------------------------------
  // maad_bulk_delete — explicit list, single commit, soft or hard.
  // --------------------------------------------------------------------------
  server.registerTool('maad_bulk_delete', {
    description: 'Delete multiple records in one call with single-commit atomicity. Dry-run by default — pass confirm:true to actually delete. Per-record failures (e.g., docId not found) collect into result.failed without aborting the batch. Default mode is "soft" (rename to _deleted_*); "hard" unlinks the file and removes the index row + cascade. Caps at maxRecords (default 100, ceiling 1000); MAAD_CLEANUP_MAX_RECORDS_BULK_DELETE env override.',
    inputSchema: z.object({
      docIds: z.array(z.string()).min(1).describe('Explicit docId list to delete'),
      mode: z.enum(['soft', 'hard']).optional().describe('soft=rename to _deleted_* (default), hard=unlink file + remove index row'),
      maxRecords: z.number().optional().describe('Per-call cap (default 100, ceiling 1000)'),
      confirm: z.boolean().optional().describe('Set true to actually delete. Absent/false returns dry-run preview.'),
      idempotencyKey: z.string().max(128).optional().describe('Opaque client-supplied key; scopes (project, tool, key) and dedupes retries within TTL'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_bulk_delete', args, async ({ engine, projectName, requestId }) =>
    withIdempotency(projectName, 'maad_bulk_delete', args.idempotencyKey, requestId, async () => {
      const confirmed = args.confirm === true;
      const mode = (args.mode ?? 'soft') as 'soft' | 'hard';
      const maxRecords = resolveCleanupMaxRecords('BULK_DELETE', args.maxRecords);

      const cap = checkCleanupSize('maad_bulk_delete', args.docIds.length, maxRecords);
      if (cap) {
        return errorResponse([
          maadError('BULK_LIMIT_EXCEEDED', cap.message, undefined, {
            tool: cap.tool,
            received: cap.received,
            limit: cap.limit,
            suggestedChunkSize: cap.suggestedChunkSize,
          }),
        ]);
      }

      auditToolCall('maad_bulk_delete', args, { confirm_mode: confirmed ? 'confirmed' : 'dry_run' });

      if (!confirmed) {
        // Resolve which of the requested docIds actually exist so the
        // dry-run preview matches what a confirmed run would touch.
        const affected: Array<{ docId: string; docType: string; filePath: string }> = [];
        const missing: string[] = [];
        for (const id of args.docIds) {
          const doc = engine.getBackend().getDocument(toDocId(id));
          if (doc) {
            affected.push({ docId: doc.docId as string, docType: doc.docType as string, filePath: doc.filePath as string });
          } else {
            missing.push(id);
          }
        }
        return dryRunResponseAffected('maad_bulk_delete', affected as unknown as Array<Record<string, unknown>>, {
          mode,
          missing,
          maxRecords,
        });
      }

      const result = await engine.bulkDelete(args.docIds, mode);
      const response = resultToResponse(result, 'maad_bulk_delete');
      if (!result.ok) return response;
      const value = result.value as BulkDeleteResult;
      if (value.writeDurable) {
        for (const s of value.succeeded) {
          await notifyWrite(ctx, {
            action: 'delete',
            docId: s.docId,
            docType: s.docType,
            project: projectName,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      return attachDurability(response, value.writeDurable, value.commitFailure);
    }),
  ));

  // --------------------------------------------------------------------------
  // maad_delete_where — filter-driven; composes query + bulk_delete.
  // --------------------------------------------------------------------------
  server.registerTool('maad_delete_where', {
    description: 'Delete every record matching a filter, single commit. Same filter shape as maad_query. Dry-run by default — pass confirm:true to actually delete. Default mode soft; hard removes file + index row. Caps at maxRecords (default 100, ceiling 1000); MAAD_CLEANUP_MAX_RECORDS_DELETE_WHERE env override. If the filter matches more than maxRecords, returns BULK_LIMIT_EXCEEDED with chunking hint.',
    inputSchema: z.object({
      docType: z.string().describe('Document type to delete within'),
      filters: z.any().optional().describe('Field filters — same shape as maad_query (shorthand eq, single-op, between, array-of-ops AND-semantics)'),
      mode: z.enum(['soft', 'hard']).optional().describe('soft=rename to _deleted_* (default), hard=unlink file + remove index row'),
      maxRecords: z.number().optional().describe('Per-call cap (default 100, ceiling 1000)'),
      confirm: z.boolean().optional().describe('Set true to actually delete. Absent/false returns dry-run preview.'),
      idempotencyKey: z.string().max(128).optional().describe('Opaque client-supplied key; scopes (project, tool, key) and dedupes retries within TTL'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_delete_where', args, async ({ engine, projectName, requestId }) =>
    withIdempotency(projectName, 'maad_delete_where', args.idempotencyKey, requestId, async () => {
      const confirmed = args.confirm === true;
      const mode = (args.mode ?? 'soft') as 'soft' | 'hard';
      const maxRecords = resolveCleanupMaxRecords('DELETE_WHERE', args.maxRecords);

      const query: DocumentQuery = { docType: toDocType(args.docType) };
      if (args.filters !== undefined) (query as { filters?: unknown }).filters = args.filters;
      // Probe with maxRecords+1 so we can detect overflow without scanning
      // the entire matching set when the operator's scope is wider than
      // they realize.
      query.limit = maxRecords + 1;
      const queryResult = engine.findDocuments(query);
      if (!queryResult.ok) return resultToResponse(queryResult, 'maad_delete_where');

      const matched = queryResult.value.results;
      if (matched.length > maxRecords) {
        const cap = checkCleanupSize('maad_delete_where', matched.length, maxRecords);
        return errorResponse([
          maadError('BULK_LIMIT_EXCEEDED', cap!.message, undefined, {
            tool: cap!.tool,
            received: cap!.received,
            limit: cap!.limit,
            suggestedChunkSize: cap!.suggestedChunkSize,
          }),
        ]);
      }

      auditToolCall('maad_delete_where', args, { confirm_mode: confirmed ? 'confirmed' : 'dry_run' });

      const docIds = matched.map(m => m.docId as string);

      if (!confirmed) {
        const affected = matched.map(m => ({
          docId: m.docId as string,
          docType: args.docType,
        }));
        return dryRunResponseAffected('maad_delete_where', affected as unknown as Array<Record<string, unknown>>, {
          mode,
          docType: args.docType,
          maxRecords,
        });
      }

      if (docIds.length === 0) {
        // Confirmed call with no matches — succeed cheaply, no commit.
        const empty: BulkDeleteResult = { succeeded: [], failed: [], totalRequested: 0, writeDurable: true };
        return resultToResponse({ ok: true, value: empty } as const, 'maad_delete_where');
      }

      const result = await engine.bulkDelete(docIds, mode);
      const response = resultToResponse(result, 'maad_delete_where');
      if (!result.ok) return response;
      const value = result.value as BulkDeleteResult;
      if (value.writeDurable) {
        for (const s of value.succeeded) {
          await notifyWrite(ctx, {
            action: 'delete',
            docId: s.docId,
            docType: s.docType,
            project: projectName,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      return attachDurability(response, value.writeDurable, value.commitFailure);
    }),
  ));

  // --------------------------------------------------------------------------
  // maad_purge_soft_deleted — hard-delete cemetery older than retention.
  // --------------------------------------------------------------------------
  server.registerTool('maad_purge_soft_deleted', {
    description: 'Hard-delete soft-deleted records older than the retention threshold. Removes the _deleted_* file from disk, removes the documents row, cascades to objects/relationships/blocks/field_index. Single commit. Dry-run by default — pass confirm:true to actually purge. Default retention 30 days (MAAD_PURGE_DEFAULT_RETENTION_DAYS env). Caps at maxRecords (default 100, ceiling 1000); MAAD_CLEANUP_MAX_RECORDS_PURGE_SOFT_DELETED env override. Reports scanned (total matching) vs purged.length (clipped to maxRecords).',
    inputSchema: z.object({
      olderThan: z.string().optional().describe('ISO-8601 timestamp threshold. Records with updated_at < this are eligible. Default: now - MAAD_PURGE_DEFAULT_RETENTION_DAYS (default 30 days).'),
      maxRecords: z.number().optional().describe('Per-call cap (default 100, ceiling 1000)'),
      confirm: z.boolean().optional().describe('Set true to actually purge. Absent/false returns dry-run preview.'),
      idempotencyKey: z.string().max(128).optional().describe('Opaque client-supplied key; scopes (project, tool, key) and dedupes retries within TTL'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_purge_soft_deleted', args, async ({ engine, projectName, requestId }) =>
    withIdempotency(projectName, 'maad_purge_soft_deleted', args.idempotencyKey, requestId, async () => {
      const confirmed = args.confirm === true;
      const maxRecords = resolveCleanupMaxRecords('PURGE_SOFT_DELETED', args.maxRecords);
      const olderThanIso = args.olderThan ?? new Date(Date.now() - resolvePurgeRetentionDays() * 24 * 60 * 60 * 1000).toISOString();

      auditToolCall('maad_purge_soft_deleted', args, { confirm_mode: confirmed ? 'confirmed' : 'dry_run' });

      if (!confirmed) {
        // Dry-run preview: scan with maxRecords clip so the affected list
        // is what a confirmed run would touch. `scanned` from the engine
        // accounts for the unclipped count when we do the real run.
        const candidates = engine.getBackend().findSoftDeletedBefore(olderThanIso, maxRecords);
        const affected = candidates.map(d => ({
          docId: d.docId as string,
          docType: d.docType as string,
          filePath: d.filePath as string,
          updatedAt: d.updatedAt,
        }));
        return dryRunResponseAffected('maad_purge_soft_deleted', affected as unknown as Array<Record<string, unknown>>, {
          retentionThresholdIso: olderThanIso,
          maxRecords,
        });
      }

      const result = await engine.purgeSoftDeleted(olderThanIso, maxRecords);
      const response = resultToResponse(result, 'maad_purge_soft_deleted');
      if (!result.ok) return response;
      const value = result.value as PurgeSoftDeletedResult;
      if (value.writeDurable) {
        for (const p of value.purged) {
          await notifyWrite(ctx, {
            action: 'delete',
            docId: p.docId,
            docType: p.docType,
            project: projectName,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      return attachDurability(response, value.writeDurable, value.commitFailure);
    }),
  ));

  // --------------------------------------------------------------------------
  // maad_repair_where — filter-driven tolerant repair via strategy registry.
  // --------------------------------------------------------------------------
  server.registerTool('maad_repair_where', {
    description: 'Tolerantly repair records matching a filter. Runs the requested strategies in order per record: prune_orphan_refs removes ref-field targets that no longer exist; fix_schema_drift bumps the record\'s schemaRef to the current pack version, adds missing optional fields with schema defaults, drops fields no longer declared. NEVER coerces types — records needing migration fail with REPAIR_REQUIRES_MIGRATION. Dry-run by default; pass confirm:true to mutate. Single trailing commit per call. Caps at maxRecords (default 100, ceiling 1000); MAAD_CLEANUP_MAX_RECORDS_REPAIR_WHERE env override.',
    inputSchema: z.object({
      docType: z.string().describe('Document type to repair within'),
      filters: z.any().optional().describe('Field filters — same shape as maad_query'),
      repairTypes: z.array(z.enum(REPAIR_STRATEGY_NAMES)).min(1).describe('Repair strategies to apply per matched record, in order. v1: prune_orphan_refs, fix_schema_drift.'),
      maxRecords: z.number().optional().describe('Per-call cap (default 100, ceiling 1000)'),
      confirm: z.boolean().optional().describe('Set true to actually repair. Absent/false returns dry-run preview.'),
      idempotencyKey: z.string().max(128).optional().describe('Opaque client-supplied key; scopes (project, tool, key) and dedupes retries within TTL'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_repair_where', args, async ({ engine, projectName, requestId }) =>
    withIdempotency(projectName, 'maad_repair_where', args.idempotencyKey, requestId, async () => {
      const confirmed = args.confirm === true;
      const maxRecords = resolveCleanupMaxRecords('REPAIR_WHERE', args.maxRecords);
      const repairTypes = args.repairTypes as RepairStrategyName[];
      const docTypeValue = toDocType(args.docType);
      const filters = args.filters as Record<string, FilterCondition> | undefined;

      // Probe with maxRecords+1 to detect overflow without scanning the full
      // matching set. Mirrors delete_where.
      const probeQuery: DocumentQuery = { docType: docTypeValue, limit: maxRecords + 1 };
      if (filters !== undefined) (probeQuery as { filters?: unknown }).filters = filters;
      const probe = engine.findDocuments(probeQuery);
      if (!probe.ok) return resultToResponse(probe, 'maad_repair_where');

      if (probe.value.results.length > maxRecords) {
        const cap = checkCleanupSize('maad_repair_where', probe.value.results.length, maxRecords);
        return errorResponse([
          maadError('BULK_LIMIT_EXCEEDED', cap!.message, undefined, {
            tool: cap!.tool,
            received: cap!.received,
            limit: cap!.limit,
            suggestedChunkSize: cap!.suggestedChunkSize,
          }),
        ]);
      }

      auditToolCall('maad_repair_where', args, { confirm_mode: confirmed ? 'confirmed' : 'dry_run' });

      if (!confirmed) {
        const affected = probe.value.results.map(m => ({
          docId: m.docId as string,
          docType: args.docType,
        }));
        return dryRunResponseAffected('maad_repair_where', affected as unknown as Array<Record<string, unknown>>, {
          docType: args.docType,
          repairTypes,
          maxRecords,
        });
      }

      const result = await engine.repairWhere(filters, docTypeValue, repairTypes, maxRecords);
      const response = resultToResponse(result, 'maad_repair_where');
      if (!result.ok) return response;
      const value = result.value as RepairWhereResult;
      if (value.writeDurable) {
        for (const s of value.succeeded) {
          await notifyWrite(ctx, {
            action: 'update',
            docId: s.docId,
            docType: s.docType,
            project: projectName,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      return attachDurability(response, value.writeDurable, value.commitFailure);
    }),
  ));

  return 4;
}
