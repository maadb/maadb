// ============================================================================
// SIGHUP reload signal handler — triggers a full instance reload on POSIX
// systems (systemctl reload, kill -HUP, etc.). Windows has no SIGHUP concept
// at the OS level, so installation is a no-op there — operators on Windows
// use the `maad_instance_reload` MCP tool instead.
//
// The handler defers to `performInstanceReload` with source="sighup". Errors
// are logged to the ops channel but do not crash the process — a failed
// reload leaves the prior instance state intact.
// ============================================================================

import type { InstanceCtx } from './ctx.js';
import { performInstanceReload } from './instance-reload.js';
import { getOpsLog } from '../logging.js';

let signalHandler: NodeJS.SignalsListener | null = null;

/**
 * Install a SIGHUP listener that triggers performInstanceReload. Safe to call
 * once at startup. Windows returns early (no SIGHUP on that platform). Tests
 * skip this — they invoke performInstanceReload directly.
 */
export function installReloadSignalHandler(ctx: InstanceCtx): void {
  if (process.platform === 'win32') {
    // No SIGHUP on Windows. Document in the deploy guides that Windows
    // operators must use the maad_instance_reload MCP tool.
    return;
  }
  if (signalHandler) {
    // Already installed — idempotent for test helpers that reinit.
    return;
  }

  signalHandler = () => {
    // Fire-and-forget — the signal handler itself must return synchronously.
    // Errors land on the ops log via performInstanceReload's internal logging.
    void (async () => {
      const instanceResult = await performInstanceReload(ctx, 'sighup');
      if (!instanceResult.ok) {
        const first = instanceResult.errors[0];
        getOpsLog().warn(
          { event: 'sighup_reload_failed', code: first?.code, message: first?.message },
          'sighup_reload_failed',
        );
      }
      // 0.7.0 — reload tokens.yaml too. Independent of instance reload; a
      // failure here doesn't roll back the instance reload. Captures of
      // ctx.tokens elsewhere (the HTTP transport closure) stay valid because
      // TokenStore.reload mutates the existing instance in-place.
      // Loose null check (`!= null`) catches both null and undefined — test
      // harnesses sometimes pass partial ctx objects without a tokens field.
      if (ctx.tokens != null) {
        const tokensResult = await ctx.tokens.reload();
        if (!tokensResult.ok) {
          const first = tokensResult.errors[0];
          getOpsLog().warn(
            { event: 'sighup_tokens_reload_failed', code: first?.code, message: first?.message },
            'sighup_tokens_reload_failed',
          );
        } else {
          getOpsLog().info(
            { event: 'tokens_reload', total: tokensResult.value.total, active: tokensResult.value.active },
            'tokens_reload',
          );
          // Reload may have revoked/removed tokens that live sessions are
          // bound to — tear those sessions down now rather than on the
          // transport sweeper's next tick.
          ctx.onTokensChanged?.();
        }
      }
    })();
  };
  process.on('SIGHUP', signalHandler);
}

/**
 * Remove the SIGHUP listener. Used by tests between cases and by graceful
 * shutdown to prevent late signals from firing after teardown.
 */
export function uninstallReloadSignalHandler(): void {
  if (signalHandler && process.platform !== 'win32') {
    process.off('SIGHUP', signalHandler);
  }
  signalHandler = null;
}
