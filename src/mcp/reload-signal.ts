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
    void performInstanceReload(ctx, 'sighup').then((result) => {
      if (!result.ok) {
        const first = result.errors[0];
        getOpsLog().warn(
          {
            event: 'sighup_reload_failed',
            code: first?.code,
            message: first?.message,
          },
          'sighup_reload_failed',
        );
      }
    });
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
