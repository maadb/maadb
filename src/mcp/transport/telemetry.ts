// ============================================================================
// Transport telemetry — process-level counters surfaced by maad_health.
//
// Holds the transport posture (kind/host/port/startedAt) decided at boot and
// session lifecycle counters fed by the HTTP transport. Stdio initializes the
// transport block with kind=stdio and leaves the session counters at zero —
// stdio is a single implicit session so open/close events aren't emitted.
// ============================================================================

import type { BindingSource, SessionCloseReason } from '../../instance/session.js';
import { getAuditLog, getOpsLog } from '../../logging.js';

export type TransportKind = 'stdio' | 'http';

export interface TransportInfo {
  kind: TransportKind;
  host?: string | undefined;
  port?: number | undefined;
  startedAt: string;
}

export interface SessionCounters {
  openedTotal: number;
  closedTotal: number;
  lastOpenedAt: string | null;
  lastClosedAt: string | null;
  idleSweepLastRunAt: string | null;
}

export interface SessionsBlock extends SessionCounters {
  active: number;
  /**
   * Count of currently-active sessions bound via X-Maad-Pin-Project header
   * (bindingSource === 'gateway_pin'). 0 on stdio and on HTTP deployments
   * that don't use gateway pinning. Operators track this to confirm their
   * gateway is actually applying the pin.
   */
  pinned: number;
}

export interface TransportSnapshot {
  transport: {
    kind: TransportKind;
    host?: string | undefined;
    port?: number | undefined;
    uptimeSeconds: number;
  };
  sessions: SessionsBlock;
}

interface State {
  info: TransportInfo;
  startedAtMs: number;
  counters: SessionCounters;
  openedAtMsBySession: Map<string, number>;
}

let state: State | null = null;

export function initTransportTelemetry(info: {
  kind: TransportKind;
  host?: string | undefined;
  port?: number | undefined;
}): void {
  const now = Date.now();
  state = {
    info: {
      kind: info.kind,
      host: info.host,
      port: info.port,
      startedAt: new Date(now).toISOString(),
    },
    startedAtMs: now,
    counters: {
      openedTotal: 0,
      closedTotal: 0,
      lastOpenedAt: null,
      lastClosedAt: null,
      idleSweepLastRunAt: null,
    },
    openedAtMsBySession: new Map(),
  };
}

/**
 * Test hook — resets telemetry state so each test starts clean.
 */
export function __resetTransportTelemetry(): void {
  state = null;
}


export interface SessionOpenFields {
  session_id: string;
  remote_addr: string;
  user_agent: string | null;
  transport: TransportKind;
  /**
   * 0.6.8 — present when the session was pinned at initialize via the
   * X-Maad-Pin-Project header. Omitted (undefined) when the session was
   * created unbound; a later maad_use_project tool call does NOT emit an
   * additional session_open event (binding_source at session_open captures
   * the gateway-pin signal, not the eventual client bind).
   */
  binding_source?: BindingSource;
}

export function recordSessionOpen(fields: SessionOpenFields): void {
  // Safe no-op when telemetry is uninitialized. Test harnesses exercise the
  // transport in isolation without calling startServer — they shouldn't have
  // to bootstrap telemetry just to run a smoke test.
  if (!state) return;
  const now = Date.now();
  state.counters.openedTotal += 1;
  state.counters.lastOpenedAt = new Date(now).toISOString();
  state.openedAtMsBySession.set(fields.session_id, now);
  getAuditLog().info(fields, 'session_open');
}

export interface SessionCloseFields {
  session_id: string;
  reason: SessionCloseReason;
  duration_ms: number;
}

export function recordSessionClose(args: { session_id: string; reason: SessionCloseReason }): void {
  if (!state) return;
  const now = Date.now();
  const openedAt = state.openedAtMsBySession.get(args.session_id);
  const durationMs = openedAt !== undefined ? now - openedAt : 0;
  if (openedAt !== undefined) state.openedAtMsBySession.delete(args.session_id);
  state.counters.closedTotal += 1;
  state.counters.lastClosedAt = new Date(now).toISOString();
  const fields: SessionCloseFields = {
    session_id: args.session_id,
    reason: args.reason,
    duration_ms: durationMs,
  };
  getAuditLog().info(fields, 'session_close');
}

export interface IdleSweepFields {
  swept: number;
  remaining: number;
}

export function recordIdleSweep(fields: IdleSweepFields): void {
  if (!state) return;
  state.counters.idleSweepLastRunAt = new Date().toISOString();
  getOpsLog().info(fields, 'idle_sweep');
}

export function getTransportSnapshot(activeSessions: number, pinnedSessions = 0): TransportSnapshot {
  if (!state) throw new Error('transport telemetry not initialized');
  const s = state;
  const kind = s.info.kind;
  const uptimeSeconds = Math.max(0, Math.floor((Date.now() - s.startedAtMs) / 1000));
  const transport: TransportSnapshot['transport'] =
    kind === 'http'
      ? { kind, host: s.info.host, port: s.info.port, uptimeSeconds }
      : { kind, uptimeSeconds };
  // Stdio is a single implicit session — cap reported active at 1 regardless
  // of registry state so the contract in the spec holds. Pinned is always 0
  // on stdio (header plumbing is HTTP-only).
  const active = kind === 'stdio' ? Math.min(1, activeSessions) : activeSessions;
  const pinned = kind === 'stdio' ? 0 : pinnedSessions;
  return {
    transport,
    sessions: { active, pinned, ...s.counters },
  };
}

export function isInitialized(): boolean {
  return state !== null;
}
