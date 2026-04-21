// ============================================================================
// Live notifications — 0.6.11 (fup-2026-035)
//
// Per-session notifier registry + filtered fan-out for `maad_subscribe`. Each
// connected MCP session registers one notifier closure that wraps its
// McpServer's `sendResourceUpdated`. On a durable write (CommitOutcome =
// 'committed'), the MCP tool handler calls `notifyWrite(ctx, event)`, which
// walks every session with an active subscription, matches the filter, and
// fires the notifier.
//
// Durability gate: the write-tool handler skips this call when
// `writeDurable === false` or the underlying commit was a noop. Subscribers
// never see events for non-durable or no-op writes — the whole point of
// shipping 0.6.10 durability first.
//
// Zero-overhead path: `notifyWrite` early-returns when no session has a
// subscription. Cheap Map iteration with a single boolean check per session.
// Sessions without subscriptions pay nothing for the notification path.
// ============================================================================

import type { InstanceCtx } from './ctx.js';
import type { SessionState } from '../instance/session.js';
import { logger } from '../engine/logger.js';

/**
 * Event shape emitted on durable writes. Used both as the payload mapped into
 * MCP's `notifications/resources/updated` and as the match target for
 * per-session filters.
 */
export interface ChangeEvent {
  action: 'create' | 'update' | 'delete';
  docId: string;
  docType: string;
  project: string;
  updatedAt: string;
}

/**
 * Callback that pushes a ChangeEvent to a single MCP session's client. The
 * transport layer (HTTP or stdio) registers this closure when it builds the
 * per-session McpServer. Failures are logged but never thrown — a broken
 * notifier channel must not kill the write that triggered it.
 */
export type Notifier = (event: ChangeEvent) => Promise<void>;

const notifiers = new Map<string, Notifier>();

/**
 * Register a notifier for a session. Called by the transport once the
 * per-session McpServer is connected and ready to emit. Overwrites any
 * prior registration for the same sessionId (transport reconnect path).
 */
export function registerNotifier(sessionId: string, fn: Notifier): void {
  notifiers.set(sessionId, fn);
}

/**
 * Remove a notifier. Called when a session is destroyed (SessionRegistry
 * close handler fans this out). Safe to call with an unknown sessionId.
 */
export function unregisterNotifier(sessionId: string): void {
  notifiers.delete(sessionId);
}

/**
 * Current count of registered notifiers. Used by maad_health telemetry and
 * by zero-overhead fast-path detection in `notifyWrite`.
 */
export function notifierCount(): number {
  return notifiers.size;
}

/**
 * Test hook — drops every registered notifier. Production code never calls
 * this; vitest suites that reuse the process need it between cases.
 */
export function __resetNotifiers(): void {
  notifiers.clear();
}

/**
 * Does this session's subscription filter match the event? Null filter
 * fields mean "accept any." In single-mode sessions, if the subscription's
 * `project` is null, it implicitly matches the session's activeProject.
 * In multi-mode, null matches any project in the whitelist.
 */
function matchesSubscription(state: SessionState, event: ChangeEvent): boolean {
  const sub = state.subscription;
  if (!sub) return false;

  if (sub.docTypes !== null && !sub.docTypes.includes(event.docType)) return false;

  if (sub.project !== null) {
    if (sub.project !== event.project) return false;
  } else {
    // Null project: match the session's visible project scope.
    if (state.mode === 'single' && state.activeProject !== event.project) return false;
    if (state.mode === 'multi' && !(state.whitelist ?? []).includes(event.project)) return false;
  }
  return true;
}

/**
 * Fan-out entry point called by MCP write tool handlers after a successful
 * durable commit. Iterates sessions with subscriptions, matches the filter,
 * and invokes each session's notifier. Zero overhead when no session has a
 * subscription (the count check bypasses the iteration).
 *
 * Caller MUST only invoke this when `writeDurable === true` on the engine
 * result — the durability gate is upstream, not here. Delete operations
 * should pass `action: 'delete'` and the docType recorded before deletion.
 */
export async function notifyWrite(ctx: InstanceCtx, event: ChangeEvent): Promise<void> {
  if (notifiers.size === 0) return; // fast path: nobody listening

  for (const state of ctx.sessions.snapshot()) {
    if (!matchesSubscription(state, event)) continue;
    const fn = notifiers.get(state.sessionId);
    if (!fn) continue;
    try {
      await fn(event);
    } catch (e) {
      // Notifier delivery failure is non-fatal to the write. Log so
      // operators can spot broken transports (disconnected SSE, stale
      // McpServer) — but never propagate the error back to the writer.
      logger.bestEffort('notify', 'deliver',
        `Notifier failed for session ${state.sessionId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
