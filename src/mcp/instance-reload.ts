// ============================================================================
// Instance reload orchestrator — shared by maad_instance_reload tool and the
// SIGHUP handler. Re-parses the instance config from disk, delegates the diff
// + eviction to EnginePool.reloadInstance, then propagates the new config to
// SessionRegistry and cancels / prunes sessions whose projects were removed.
//
// Both call sites (tool handler, SIGHUP handler) invoke this with a `source`
// string that flows into the audit event so operators can tell apart
// operator-initiated reloads from OS-signal reloads.
//
// Failure modes never leave the runtime half-applied: diff mutations are
// detected + rejected before any eviction, and the instance ref swap happens
// only after the pool has finished its part.
// ============================================================================

import type { Result } from '../errors.js';
import { ok, singleErr } from '../errors.js';
import type { InstanceCtx } from './ctx.js';
import { loadInstance, type InstanceConfig } from '../instance/config.js';
import { logInstanceReload, logInstanceReloadProgress } from '../logging.js';

export type InstanceReloadSource = 'tool' | 'sighup';

export interface InstanceReloadResult {
  source: InstanceReloadSource;
  projectsAdded: string[];
  projectsRemoved: string[];
  sessionsCancelled: string[];
  sessionsPruned: string[];
  durationMs: number;
}

/**
 * Run a full instance reload from the config file recorded on the live
 * InstanceConfig. Emits progress + audit log lines around the critical steps.
 *
 * Error codes that flow back to the caller (tool wraps them as MCP responses):
 *   - INSTANCE_RELOAD_SYNTHETIC  (synthetic instance, no config file)
 *   - INSTANCE_RELOAD_IN_PROGRESS (another reload is active)
 *   - INSTANCE_RELOAD_FAILED     (parse error, file read error, etc.)
 *   - INSTANCE_MUTATION_UNSUPPORTED (existing project path/role changed)
 */
export async function performInstanceReload(
  ctx: InstanceCtx,
  source: InstanceReloadSource,
): Promise<Result<InstanceReloadResult>> {
  const startedAt = Date.now();

  // Acquire the reload slot FIRST, before any I/O — otherwise concurrent
  // callers can both pass the in-progress check while one is still parsing
  // its yaml. tryBeginReload also handles the synthetic-instance fast path
  // so both checks live in one place.
  const begin = ctx.pool.tryBeginReload();
  if (!begin.ok) {
    const message = begin.code === 'INSTANCE_RELOAD_SYNTHETIC'
      ? 'Synthetic (legacy --project) instances cannot be reloaded. Start the server with --instance <path> to enable reload.'
      : 'Another instance reload is already running. Retry once it completes.';
    return singleErr(begin.code, message);
  }

  // From here on, every return path must call ctx.pool.endReload to release
  // the slot and record success/failure stats.
  let outcome: { ok: true; diff: { added: string[]; removed: string[] } } | { ok: false } = { ok: false };
  try {
    const configPath = ctx.instance.configPath;
    if (!configPath) {
      // Defense: file-source instances should always carry configPath. Treat
      // missing as a failed reload rather than a silent no-op.
      return singleErr('INSTANCE_RELOAD_FAILED',
        'Instance has source="file" but no configPath recorded; cannot re-parse.');
    }

    logInstanceReloadProgress({ source, phase: 'start' });

    // Re-parse the config file. Parse errors leave the running instance intact.
    const loaded = await loadInstance(configPath);
    if (!loaded.ok) {
      const first = loaded.errors[0];
      const detail = loaded.errors.map(e => `${e.code}: ${e.message}`).join('; ');
      logInstanceReloadProgress({
        source,
        phase: 'failed',
        code: first?.code ?? 'INSTANCE_RELOAD_FAILED',
        message: detail,
        durationMs: Date.now() - startedAt,
      });
      return singleErr('INSTANCE_RELOAD_FAILED',
        `Failed to load instance config from ${configPath}: ${detail}`);
    }
    const newInstance: InstanceConfig = loaded.value;

    // Pool applies the diff: mutation check + eviction of removed engines.
    const diffResult = await ctx.pool.applyDiff(newInstance);
    if (!diffResult.ok) {
      const first = diffResult.errors[0];
      logInstanceReloadProgress({
        source,
        phase: 'failed',
        code: first?.code ?? 'INSTANCE_RELOAD_FAILED',
        message: first?.message ?? 'Apply diff failed',
        durationMs: Date.now() - startedAt,
      });
      return diffResult;
    }
    const diff = diffResult.value;

    // Propagate the new config to downstream refs that hold their own copy.
    ctx.instance = newInstance;
    ctx.sessions.setInstance(newInstance);

    // Session fallout: single-mode sessions on removed projects → cancelled;
    // multi-mode sessions → whitelist pruned (cancelled only if it drains).
    const cancelled: string[] = [];
    const pruned: string[] = [];
    for (const name of diff.removed) {
      cancelled.push(...ctx.sessions.cancelByProject(name));
      const { prunedSessions, cancelledSessions } = ctx.sessions.pruneProjectFromWhitelist(name);
      pruned.push(...prunedSessions);
      cancelled.push(...cancelledSessions);
    }

    const durationMs = Date.now() - startedAt;

    logInstanceReload({
      source,
      projectsAdded: diff.added.length,
      projectsRemoved: diff.removed.length,
      projectsAddedNames: diff.added,
      projectsRemovedNames: diff.removed,
      sessionsCancelled: cancelled.length,
      sessionsPruned: pruned.length,
      durationMs,
    });
    logInstanceReloadProgress({
      source,
      phase: 'complete',
      projectsAdded: diff.added.length,
      projectsRemoved: diff.removed.length,
      durationMs,
    });

    outcome = { ok: true, diff };
    return ok({
      source,
      projectsAdded: diff.added,
      projectsRemoved: diff.removed,
      sessionsCancelled: cancelled,
      sessionsPruned: pruned,
      durationMs,
    });
  } finally {
    ctx.pool.endReload(outcome);
  }
}
