// ============================================================================
// Reload orchestrator shared by maad_instance_reload and SIGHUP. It reloads
// instance config and tokens from disk with independent failure handling.
//
// Both call sites (tool handler, SIGHUP handler) invoke this with a `source`
// string that flows into the audit event so operators can tell apart
// operator-initiated reloads from OS-signal reloads.
//
// Instance diff mutations are rejected before eviction, and its reference
// swap happens only after the pool finishes. Token state swaps only after a
// successful token parse. A failure on either side does not undo the other.
// ============================================================================

import type { Result } from '../errors.js';
import { ok, singleErr } from '../errors.js';
import type { InstanceCtx } from './ctx.js';
import { loadInstance, type InstanceConfig } from '../instance/config.js';
import { getOpsLog, logInstanceReload, logInstanceReloadProgress } from '../logging.js';

export type InstanceReloadSource = 'tool' | 'sighup';

export interface InstanceReloadResult {
  source: InstanceReloadSource;
  projectsAdded: string[];
  projectsRemoved: string[];
  sessionsCancelled: string[];
  sessionsPruned: string[];
  durationMs: number;
}

export interface InstanceReloadOptions {
  /** Keep the invoking HTTP session alive long enough to carry the response. */
  excludeSessionId?: string;
}

/**
 * Reload the instance config and token registry from their recorded files.
 * The returned Result describes the instance-config outcome; token failures
 * are logged and do not roll back a successful instance reload.
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
  options: InstanceReloadOptions = {},
): Promise<Result<InstanceReloadResult>> {
  const instanceResult = await reloadInstanceConfig(ctx, source);

  // Token reload is independent of the instance result. A failure on either
  // side must not prevent the other reload from taking effect.
  if (ctx.tokens != null) {
    applyTokensReload(ctx, source, await ctx.tokens.reload(), options.excludeSessionId);
  }

  return instanceResult;
}

export type TokensReloadSource = InstanceReloadSource | 'watch';

/**
 * Log a token-registry reload and, on success, tear down sessions bound to
 * tokens that are no longer active. Shared by explicit reloads and the
 * tokens.yaml change watcher. A failed reload leaves the previous registry in
 * place and evicts nothing.
 */
export function applyTokensReload(
  ctx: InstanceCtx,
  source: TokensReloadSource,
  result: Result<{ total: number; active: number }>,
  excludeSessionId?: string,
): void {
  if (!result.ok) {
    const first = result.errors[0];
    getOpsLog().warn(
      { event: 'tokens_reload_failed', source, code: first?.code, message: first?.message },
      'tokens_reload_failed',
    );
    return;
  }
  getOpsLog().info(
    { event: 'tokens_reload', source, total: result.value.total, active: result.value.active },
    'tokens_reload',
  );
  ctx.onTokensChanged?.(excludeSessionId);
}

async function reloadInstanceConfig(
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
