// ============================================================================
// Maintain tools — maad_delete, maad_reindex, maad_reload, maad_health
// ============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { docId } from '../../types.js';
import { resultToResponse, successResponse, getProvenanceMode, attachDurability } from '../response.js';
import type { DeleteResult } from '../../engine/types.js';
import { notifyWrite } from '../notifications.js';
import { isDryRun, dryRunResponse, auditToolCall } from '../guardrails.js';
import type { InstanceCtx } from '../ctx.js';
import { withEngine } from '../with-session.js';
import { getTransportSnapshot, isInitialized as telemetryInitialized } from '../transport/telemetry.js';

export function register(server: McpServer, ctx: InstanceCtx): number {
  server.registerTool('maad_delete', {
    description: 'Deletes a record. Soft: renames file with _deleted prefix. Hard: removes file entirely.',
    inputSchema: z.object({
      docId: z.string().describe('Document ID to delete'),
      mode: z.enum(['soft', 'hard']).default('soft').describe('soft=rename, hard=remove file'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_delete', args, async ({ engine, projectName }) => {
    auditToolCall('maad_delete', args);
    if (isDryRun()) return dryRunResponse('maad_delete', args);
    const result = await engine.deleteDocument(docId(args.docId), args.mode);
    const response = resultToResponse(result);
    if (!result.ok) return response;
    const value = result.value as DeleteResult;
    if (value.writeDurable) {
      await notifyWrite(ctx, {
        action: 'delete',
        docId: String(value.docId),
        docType: String(value.docType),
        project: projectName,
        updatedAt: new Date().toISOString(),
      });
    }
    return attachDurability(response, value.writeDurable, value.commitFailure);
  }));

  server.registerTool('maad_reindex', {
    description: 'Rebuilds the SQLite index from markdown files. Use after external file changes or to recover from stale state.',
    inputSchema: z.object({
      force: z.boolean().optional().default(false).describe('Force full rebuild (skip hash check)'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_reindex', args, async ({ engine }) => {
    return resultToResponse(await engine.reindex({ force: args.force }));
  }));

  server.registerTool('maad_reload', {
    description: 'Reloads the engine — picks up new registry, schemas, and type directories without restarting the server. Use after changing _registry/ or _schema/ files.',
    inputSchema: z.object({
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_reload', args, async ({ engine }) => {
    auditToolCall('maad_reload', {});
    return resultToResponse(await engine.reload());
  }));

  server.registerTool('maad_health', {
    description: 'Engine health + transport + session telemetry + instance reload stats. sessions block: {active, pinned, subscribed, byProject: {<project>:{<role>:count}}, byIdentity: {<agent_id|anonymous>:count}, ...lifecycle counters}. instance block: {source, configPath?, projectCount, reload counters}.',
    inputSchema: z.object({
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_health', args, ({ engine }) => {
    const health = engine.health();
    const provMode = getProvenanceMode();
    // Telemetry may be uninitialized in test contexts that build an engine
    // without going through startServer. Fall back gracefully so maad_health
    // stays useful in those environments.
    const pinnedCount = ctx.sessions.snapshot().filter(s => s.bindingSource === 'gateway_pin').length;
    const telemetry = telemetryInitialized()
      ? getTransportSnapshot(ctx.sessions.size(), pinnedCount)
      : null;

    // 0.6.12 — subscribed-session counter for cheap observability. Admins
    // grep `subscribed > 0` to confirm push-based delivery is in use at all;
    // full inventory is the admin-only maad_subscriptions tool.
    const subscribedCount = ctx.sessions.snapshot().filter(s => s.subscription !== undefined).length;

    // 0.7.0 — byProject + byIdentity aggregates (spec v2 fix #4: byProject
    // replaces the ambiguous flat byRole because multi-project sessions
    // carry different roles per project). byProject counts session×project
    // pairs grouped by role so the inner sums can exceed `active` when
    // multi-mode sessions exist. byIdentity counts DISTINCT sessions per
    // agent_id; sessions with no token bucket under 'anonymous'.
    const byProject: Record<string, Record<string, number>> = {};
    const byIdentity: Record<string, number> = {};
    for (const state of ctx.sessions.snapshot()) {
      for (const [projectName, role] of state.effectiveRoles) {
        const bucket = byProject[projectName] ?? (byProject[projectName] = {});
        bucket[role] = (bucket[role] ?? 0) + 1;
      }
      const ident = state.token?.agentId ?? 'anonymous';
      byIdentity[ident] = (byIdentity[ident] ?? 0) + 1;
    }

    // 0.6.9 — instance reload stats, always included. Operators watching
    // hot-reload behavior (cohort expansion, tenant churn) filter on this
    // block to verify their last reload landed + projectCount is current.
    const reloadStats = ctx.pool.reloadStats();
    const instanceBlock = {
      name: ctx.instance.name,
      source: ctx.instance.source,
      configPath: ctx.instance.configPath ?? null,
      projectCount: ctx.instance.projects.length,
      lastReloadAt: reloadStats.lastReloadAt ? reloadStats.lastReloadAt.toISOString() : null,
      reloadsAttempted: reloadStats.reloadsAttempted,
      reloadsSucceeded: reloadStats.reloadsSucceeded,
      reloadsFailed: reloadStats.reloadsFailed,
      projectsAdded: reloadStats.projectsAdded,
      projectsRemoved: reloadStats.projectsRemoved,
    };

    const sessionsBlock = telemetry
      ? { ...telemetry.sessions, subscribed: subscribedCount, byProject, byIdentity }
      : { subscribed: subscribedCount, byProject, byIdentity };
    const payload = telemetry
      ? { ...health, provenance: provMode, transport: telemetry.transport, sessions: sessionsBlock, instance: instanceBlock }
      : { ...health, provenance: provMode, sessions: sessionsBlock, instance: instanceBlock };
    return successResponse(payload, 'maad_health');
  }));

  return 4;
}
