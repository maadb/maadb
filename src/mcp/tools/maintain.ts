// ============================================================================
// Maintain tools — maad_delete, maad_reindex, maad_reload, maad_health
// ============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { docId } from '../../types.js';
import { resultToResponse, successResponse, getProvenanceMode, attachDurability, attachWarnings } from '../response.js';
import type { DeleteResult } from '../../engine/types.js';
import { notifyWrite } from '../notifications.js';
import { isDryRun, dryRunResponse, auditToolCall } from '../guardrails.js';
import type { InstanceCtx } from '../ctx.js';
import { withEngine } from '../with-session.js';
import { getTransportSnapshot, isInitialized as telemetryInitialized } from '../transport/telemetry.js';
import { getMemoryPressureSnapshot } from '../memory-pressure.js';
import { getHeavyOpGuard } from '../heavy-ops.js';
import { roleSatisfies, parseRole } from '../roles.js';
import { maadError } from '../../errors.js';
import { errorResponse } from '../response.js';
import { engineVersion, checkProject, planRefresh, applyRefresh } from '../../instructions/manifest.js';

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
    description: 'Rebuilds the SQLite index from markdown files. In multi-project instance mode, this is the only tool allowed to recover a false-empty index; single-project servers must use MAAD_BOOT_REINDEX=1 or the CLI. Fleet CLI recovery: maad reindex --project <absolute path exactly as declared in instance.yaml>, in the server filesystem namespace. Avoid relative paths, inherited MAAD_PROJECT, and mismatched container mounts. Auto-detects per-type schema-index changes and rebuilds affected types even when files are byte-identical (rebuiltTypes lists them in the response).',
    inputSchema: z.object({
      force: z.boolean().optional().default(false).describe('Force full rebuild (skip both hash check and the schema-fingerprint shortcut). Rarely needed since 0.7.4 — the engine now auto-rebuilds types whose indexed-field set changed.'),
      embeddings: z.boolean().optional().default(false).describe('0.8.0 — rebuild the semantic index: force a full reindex (repopulating per-block text + FTS), re-enqueue every block, and drain the embed worker. Use after enabling MAAD_SEMANTIC_ENABLE on an existing project or after an embedding provider/model change. No-op when semantic is off.'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_reindex', args, async ({ engine, projectName }) => {
    const result = await engine.reindex({ force: args.force, embeddings: args.embeddings });
    const recovery = await ctx.pool.completeEmptyIndexRecovery(
      projectName,
      engine,
      result.ok && result.value.errors.length === 0 && result.value.indexed > 0,
    );
    if (!recovery.ok) return resultToResponse(recovery);
    const response = resultToResponse(result);
    // 0.8.1 — scan/sweep warnings (registry path mismatch, kept-not-pruned
    // rows, glob fallback) ride the standard _meta.warnings channel so clients
    // that already read write-tool warnings see reindex warnings the same way.
    if (result.ok && result.value.warnings && result.value.warnings.length > 0) {
      return attachWarnings(response, result.value.warnings.map(message => ({
        field: '',
        message,
        code: 'REINDEX_WARNING',
        location: null,
      })));
    }
    return response;
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
    description: 'Engine health + transport + session telemetry + instance reload stats. sessions block: {active, pinned, subscribed, byProject: {<project>:{<role>:count}}, byIdentity: {<agent_id|anonymous>:count}, ...lifecycle counters}. instance block: {source, configPath?, projectCount, reload counters}. runtime block: {memoryPressure: {enabled, intervalMs, thresholdRatio, lastSampleAt, heapUsedMb, heapCapMb, heapRatio, rssMb, externalMb, arrayBuffersMb, cgroupCurrentMb, cgroupMaxMb, cgroupRatio, inPressure, heapInPressure, cgroupInPressure, lastPressureAt, pressureFiresTotal}}. 0.7.10 integrity/backup observability: lastIntegritySweepAt (ISO|null), lastIntegrityFindings ({missing_in_index, missing_on_disk, hash_drift, schema_drift, broken_refs}|null), lastBackupTag ({tag, sha, createdAt}|null). The integrity fields populate on the next maad_verify mode:integrity call; the backup field populates on the next maad_backup mode:create call.',
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
    // 0.7.10 P5 — runtime block surfaces process-level memory-pressure state so
    // operators can read V8 heap pressure without grepping logs. Snapshot is
    // always present; `enabled: false` indicates the sampler is disabled.
    const runtime = { memoryPressure: getMemoryPressureSnapshot(), heavyOpGuard: getHeavyOpGuard().snapshot() };
    // 0.8.0 — semantic subsystem block: provider/model/dim + queue depth,
    // embedded vs indexed block counts, and embed failures. enabled:false when off.
    const embeddings = engine.semanticHealth();
    const payload = telemetry
      ? { ...health, provenance: provMode, transport: telemetry.transport, sessions: sessionsBlock, instance: instanceBlock, runtime, embeddings }
      : { ...health, provenance: provMode, sessions: sessionsBlock, instance: instanceBlock, runtime, embeddings };
    return successResponse(payload, 'maad_health');
  }));

  server.registerTool('maad_instructions', {
    description: 'Managed-instruction lifecycle for the bound project. action=check (any role): per-file state — current | outdated (pristine but stale; safe to refresh) | modified (user-edited) | unmanaged (pre-lifecycle vintage) | missing. action=refresh (admin, dryRun defaults true): updates outdated/missing files to the current engine templates; force=true also replaces modified/unmanaged (git history is the undo path). Boot and reindex never refresh — this tool and the CLI are the only mutation paths.',
    inputSchema: z.object({
      action: z.enum(['check', 'refresh']).default('check').describe('check = read-only status; refresh = update managed files'),
      dryRun: z.boolean().optional().default(true).describe('refresh only: report the plan without writing (default true)'),
      force: z.boolean().optional().default(false).describe('refresh only: also replace modified/unmanaged files'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_instructions', args, async ({ engine, role }) => {
    const projectRoot = engine.getProjectRoot();

    if (args.action === 'check') {
      return successResponse({
        engineVersion: engineVersion(),
        files: checkProject(projectRoot),
      }, 'maad_instructions');
    }

    // refresh — admin-gated, blocked on read-only deployments, dry-run first.
    if (!roleSatisfies(parseRole(role), 'admin')) {
      return errorResponse([maadError('INSUFFICIENT_ROLE',
        `maad_instructions action=refresh requires admin; session has "${role}" on this project.`)]);
    }
    if (engine.isReadOnly()) {
      return errorResponse([maadError('READ_ONLY',
        'This deployment is read-only; managed instructions cannot be refreshed here.')]);
    }
    auditToolCall('maad_instructions', args);
    if (isDryRun()) return dryRunResponse('maad_instructions', args);

    const plan = planRefresh(projectRoot, { force: args.force });
    const planView = {
      engineVersion: engineVersion(),
      refresh: plan.refresh,
      skippedModified: plan.skippedModified,
      skippedUnmanaged: plan.skippedUnmanaged,
      current: plan.current.map(s => s.relPath),
    };
    if (args.dryRun) {
      return successResponse({ ...planView, dryRun: true, written: [] }, 'maad_instructions');
    }
    const written = applyRefresh(projectRoot, plan);
    // Land the refresh as its own commit — auditable, revertible. Best-effort:
    // a non-git project still gets the files.
    let committed = false;
    if (written.length > 0) {
      try {
        const { GitLayer } = await import('../../git/index.js');
        const git = new GitLayer(projectRoot);
        if (await git.isRepo()) {
          const sg = git.getSimpleGit();
          await sg.add(written);
          await sg.commit(`maad:instructions — refresh managed instructions to ${engineVersion()}`);
          committed = true;
        }
      } catch { /* best-effort */ }
    }
    return successResponse({ ...planView, dryRun: false, written, committed }, 'maad_instructions');
  }));

  return 5;
}
