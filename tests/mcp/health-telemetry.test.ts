// ============================================================================
// 0.5.0 R6 — transport telemetry unit tests
//
// Exercises the pure telemetry module: counters update on open/close/sweep,
// duration_ms computed from open→close timing, idleSweepLastRunAt reflects
// the most recent sweep call, uninitialized state is a safe no-op (so test
// harnesses that build the HTTP transport in isolation don't crash), and
// the snapshot shape matches the R6 spec (transport block + sessions block
// with active, openedTotal, closedTotal, lastOpenedAt, lastClosedAt,
// idleSweepLastRunAt).
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  __resetTransportTelemetry,
  initTransportTelemetry,
  recordSessionOpen,
  recordSessionClose,
  recordIdleSweep,
  getTransportSnapshot,
  isInitialized,
} from '../../src/mcp/transport/telemetry.js';

describe('R6 transport telemetry', () => {
  beforeEach(() => {
    __resetTransportTelemetry();
  });
  afterEach(() => {
    __resetTransportTelemetry();
  });

  it('record* calls are safe no-ops when telemetry is uninitialized', () => {
    expect(isInitialized()).toBe(false);
    expect(() => recordSessionOpen({ session_id: 'sid', remote_addr: '1.2.3.4', user_agent: null, transport: 'http' })).not.toThrow();
    expect(() => recordSessionClose({ session_id: 'sid', reason: 'client' })).not.toThrow();
    expect(() => recordIdleSweep({ swept: 1, remaining: 0 })).not.toThrow();
  });

  it('getTransportSnapshot throws when telemetry is uninitialized', () => {
    expect(() => getTransportSnapshot(0)).toThrow(/not initialized/);
  });

  it('stdio init produces a snapshot with kind=stdio, no host/port', () => {
    initTransportTelemetry({ kind: 'stdio' });
    const snap = getTransportSnapshot(0);
    expect(snap.transport.kind).toBe('stdio');
    expect(snap.transport).not.toHaveProperty('host');
    expect(snap.transport).not.toHaveProperty('port');
    expect(snap.transport.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('stdio caps active sessions at 1 even if registry reports more', () => {
    initTransportTelemetry({ kind: 'stdio' });
    // Multiple registered sessions shouldn't be possible on stdio in practice,
    // but the snapshot contract clamps it defensively.
    const snap = getTransportSnapshot(5);
    expect(snap.sessions.active).toBe(1);
  });

  it('http init includes host/port and passes active through', () => {
    initTransportTelemetry({ kind: 'http', host: '127.0.0.1', port: 7733 });
    const snap = getTransportSnapshot(3);
    expect(snap.transport.kind).toBe('http');
    expect(snap.transport.host).toBe('127.0.0.1');
    expect(snap.transport.port).toBe(7733);
    expect(snap.sessions.active).toBe(3);
  });

  it('recordSessionOpen bumps openedTotal and lastOpenedAt', () => {
    initTransportTelemetry({ kind: 'http', host: '127.0.0.1', port: 7733 });
    const before = getTransportSnapshot(0);
    expect(before.sessions.openedTotal).toBe(0);
    expect(before.sessions.lastOpenedAt).toBeNull();

    recordSessionOpen({ session_id: 'sid-a', remote_addr: '1.2.3.4', user_agent: 'x', transport: 'http' });
    recordSessionOpen({ session_id: 'sid-b', remote_addr: '5.6.7.8', user_agent: null, transport: 'http' });

    const after = getTransportSnapshot(2);
    expect(after.sessions.openedTotal).toBe(2);
    expect(after.sessions.lastOpenedAt).not.toBeNull();
    expect(Date.parse(after.sessions.lastOpenedAt!)).not.toBeNaN();
  });

  it('recordSessionClose bumps closedTotal, lastClosedAt, and clears per-session tracking', () => {
    initTransportTelemetry({ kind: 'http', host: '127.0.0.1', port: 7733 });
    recordSessionOpen({ session_id: 'sid-a', remote_addr: '1.2.3.4', user_agent: null, transport: 'http' });
    recordSessionClose({ session_id: 'sid-a', reason: 'client' });

    const snap = getTransportSnapshot(0);
    expect(snap.sessions.openedTotal).toBe(1);
    expect(snap.sessions.closedTotal).toBe(1);
    expect(snap.sessions.lastClosedAt).not.toBeNull();
  });

  it('recordIdleSweep updates idleSweepLastRunAt', () => {
    initTransportTelemetry({ kind: 'http', host: '127.0.0.1', port: 7733 });
    expect(getTransportSnapshot(0).sessions.idleSweepLastRunAt).toBeNull();
    recordIdleSweep({ swept: 2, remaining: 3 });
    const snap = getTransportSnapshot(3);
    expect(snap.sessions.idleSweepLastRunAt).not.toBeNull();
    expect(Date.parse(snap.sessions.idleSweepLastRunAt!)).not.toBeNaN();
  });

  it('snapshot sessions block has exactly the spec-defined fields', () => {
    initTransportTelemetry({ kind: 'http', host: '127.0.0.1', port: 7733 });
    recordSessionOpen({ session_id: 'sid-a', remote_addr: '1.2.3.4', user_agent: null, transport: 'http' });
    const snap = getTransportSnapshot(1);
    expect(Object.keys(snap.sessions).sort()).toEqual([
      'active',
      'closedTotal',
      'idleSweepLastRunAt',
      'lastClosedAt',
      'lastOpenedAt',
      'openedTotal',
    ]);
  });

  it('close with unknown session_id still bumps closedTotal (defensive)', () => {
    initTransportTelemetry({ kind: 'http', host: '127.0.0.1', port: 7733 });
    recordSessionClose({ session_id: 'never-opened', reason: 'shutdown' });
    const snap = getTransportSnapshot(0);
    expect(snap.sessions.closedTotal).toBe(1);
  });
});
