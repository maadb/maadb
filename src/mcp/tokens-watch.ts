// ============================================================================
// tokens.yaml change watcher — HTTP / UDS transports.
//
// Revocations and rotations written by another process (`maad auth
// revoke-token`, a hand edit) must take effect without a restart, including on
// Windows where there is no SIGHUP. Every interval this checks the token file's
// stat signature and reloads only when it changed; sessions bound to tokens
// that are no longer active are then torn down through ctx.onTokensChanged.
//
// Polling (one stat per tick) rather than fs.watch: fs.watch misses atomic
// rename-over writes on some platforms and filesystems, while a stat check is
// portable and bounded. Read-only — opens no files for writing.
// ============================================================================

import type { InstanceCtx } from './ctx.js';
import { applyTokensReload } from './instance-reload.js';
import { getOpsLog } from '../logging.js';

/** Default check interval. Bounds how long an out-of-process revocation can lag. */
export const DEFAULT_TOKENS_POLL_MS = 5_000;

/**
 * Start polling ctx.tokens for on-disk changes. Returns a stop function.
 * `intervalMs <= 0` or a null token store disables the watcher (no-op stop).
 */
export function startTokensWatch(ctx: InstanceCtx, intervalMs: number): () => void {
  const store = ctx.tokens;
  if (store == null || !(intervalMs > 0)) return () => {};

  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (inFlight) return; // a slow reload never overlaps the next tick
    inFlight = true;
    try {
      const check = await store.reloadIfChanged();
      if (check.changed) applyTokensReload(ctx, 'watch', check.result);
    } catch (e) {
      getOpsLog().warn(
        { event: 'tokens_watch_failed', message: e instanceof Error ? e.message : String(e) },
        'tokens_watch_failed',
      );
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
