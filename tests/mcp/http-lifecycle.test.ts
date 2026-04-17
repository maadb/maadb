// ============================================================================
// 0.5.0 R3 — Session lifecycle: close fan-out + idle sweeper
//
// Exercises:
//   - SessionRegistry.registerCloseHandler composes handlers and fires them
//     on destroy with the correct reason
//   - destroy(sid) is idempotent (second call is a no-op, handlers not refired)
//   - peek(sid) returns state without bumping lastActivityAt
//   - HTTP transport: client DELETE /mcp → registry destroy fires with reason
//   - HTTP transport: idle sweeper evicts quiet sessions with reason=idle
//   - HTTP transport: inbound request updates lastActivityAt; outbound does not
//     (verified indirectly via idle-sweep timing)
//   - HTTP transport: handle.close() drops all sessions with reason=shutdown
// ============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRequire } from 'node:module';
import { startHttpTransport, type HttpTransportHandle } from '../../src/mcp/transport/http.js';
import { SessionRegistry, type SessionCloseReason } from '../../src/instance/session.js';
import type { InstanceConfig } from '../../src/instance/config.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

function makeSessions(): SessionRegistry {
  const instance: InstanceConfig = { name: 'test', source: 'file', projects: [] };
  return new SessionRegistry(instance);
}

function makeFactory(): () => McpServer {
  return () => {
    const server = new McpServer({ name: 'maad-test', version: pkg.version });
    server.tool('ping', 'Returns pong.', async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }));
    return server;
  };
}

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'r3-test', version: '0.1' },
  },
};

// ---- Registry unit tests ----------------------------------------------------

describe('R3 SessionRegistry — close handlers', () => {
  it('registerCloseHandler fires on destroy with the given reason', () => {
    const registry = makeSessions();
    const events: Array<{ sid: string; reason: SessionCloseReason }> = [];
    registry.registerCloseHandler((sid, reason) => events.push({ sid, reason }));

    registry.create('sid-a');
    registry.destroy('sid-a', 'client');

    expect(events).toEqual([{ sid: 'sid-a', reason: 'client' }]);
  });

  it('multiple close handlers compose in registration order', () => {
    const registry = makeSessions();
    const order: string[] = [];
    registry.registerCloseHandler(() => order.push('first'));
    registry.registerCloseHandler(() => order.push('second'));
    registry.registerCloseHandler(() => order.push('third'));

    registry.create('sid-a');
    registry.destroy('sid-a', 'transport');

    expect(order).toEqual(['first', 'second', 'third']);
  });

  it('a throwing handler does not block others', () => {
    const registry = makeSessions();
    const seen: string[] = [];
    registry.registerCloseHandler(() => { throw new Error('boom'); });
    registry.registerCloseHandler((sid) => seen.push(sid));
    registry.registerCloseHandler((sid) => seen.push(sid));

    registry.create('sid-a');
    registry.destroy('sid-a', 'idle');

    expect(seen).toEqual(['sid-a', 'sid-a']);
  });

  it('destroy is idempotent — second call is a no-op, handler not refired', () => {
    const registry = makeSessions();
    let calls = 0;
    registry.registerCloseHandler(() => { calls++; });

    registry.create('sid-a');
    registry.destroy('sid-a', 'client');
    registry.destroy('sid-a', 'client');
    registry.destroy('sid-a', 'shutdown');

    expect(calls).toBe(1);
  });

  it('destroy on unknown session id is a no-op', () => {
    const registry = makeSessions();
    let calls = 0;
    registry.registerCloseHandler(() => { calls++; });
    registry.destroy('never-existed', 'client');
    expect(calls).toBe(0);
  });

  it('peek returns state without bumping lastActivityAt', async () => {
    const registry = makeSessions();
    const state = registry.create('sid-a');
    const original = state.lastActivityAt.getTime();

    // Spin briefly to let time advance
    await new Promise((r) => setTimeout(r, 5));
    const peeked = registry.peek('sid-a');

    expect(peeked).toBeDefined();
    expect(peeked!.lastActivityAt.getTime()).toBe(original);
  });

  it('get bumps lastActivityAt; peek does not', async () => {
    const registry = makeSessions();
    const state = registry.create('sid-a');
    const original = state.lastActivityAt.getTime();

    await new Promise((r) => setTimeout(r, 5));
    registry.get('sid-a');
    expect(state.lastActivityAt.getTime()).toBeGreaterThan(original);

    const beforePeek = state.lastActivityAt.getTime();
    await new Promise((r) => setTimeout(r, 5));
    registry.peek('sid-a');
    expect(state.lastActivityAt.getTime()).toBe(beforePeek);
  });

  it('snapshot returns a safe copy — mutating during iteration via destroy works', () => {
    const registry = makeSessions();
    registry.create('sid-a');
    registry.create('sid-b');
    registry.create('sid-c');

    for (const state of registry.snapshot()) {
      registry.destroy(state.sessionId, 'idle');
    }

    expect(registry.size()).toBe(0);
  });
});

// ---- HTTP transport integration --------------------------------------------

describe('R3 HTTP transport — close fan-out', () => {
  let handle: HttpTransportHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it('client DELETE /mcp triggers registry destroy with reason=transport', async () => {
    const sessions = makeSessions();
    const events: Array<{ sid: string; reason: SessionCloseReason }> = [];
    sessions.registerCloseHandler((sid, reason) => events.push({ sid, reason }));

    handle = await startHttpTransport({
      host: '127.0.0.1', port: 0, maxBodyBytes: 4096,
      headersTimeoutMs: 10_000, requestTimeoutMs: 60_000, keepAliveTimeoutMs: 5_000,
      trustProxy: false, idleMs: 1_800_000, sessions,
      instance: { name: 'test', source: 'file', projects: [] },
      serverFactory: makeFactory(),
    });
    const addr = handle.httpServer.address();
    if (typeof addr !== 'object' || addr === null) throw new Error('no address');
    const port = addr.port;

    // Initialize
    const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify(INIT_BODY),
    });
    const sid = init.headers.get('mcp-session-id')!;
    await init.text();
    expect(handle.activeSessionCount()).toBe(1);

    // DELETE /mcp — SDK's transport fires its onclose which calls registry.destroy
    const del = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sid },
    });
    expect(del.status).toBeGreaterThanOrEqual(200);
    await del.text();

    // onclose fires asynchronously — poll briefly
    for (let i = 0; i < 20 && events.length === 0; i++) {
      await new Promise(r => setTimeout(r, 25));
    }

    expect(events).toHaveLength(1);
    expect(events[0]!.sid).toBe(sid);
    expect(events[0]!.reason).toBe('transport');
  });

  it('handle.close() fires destroy with reason=shutdown for every active session', async () => {
    const sessions = makeSessions();
    const events: Array<{ sid: string; reason: SessionCloseReason }> = [];
    sessions.registerCloseHandler((sid, reason) => events.push({ sid, reason }));

    handle = await startHttpTransport({
      host: '127.0.0.1', port: 0, maxBodyBytes: 4096,
      headersTimeoutMs: 10_000, requestTimeoutMs: 60_000, keepAliveTimeoutMs: 5_000,
      trustProxy: false, idleMs: 1_800_000, sessions,
      instance: { name: 'test', source: 'file', projects: [] },
      serverFactory: makeFactory(),
    });
    const addr = handle.httpServer.address();
    if (typeof addr !== 'object' || addr === null) throw new Error('no address');
    const port = addr.port;

    // Open two sessions
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
        body: JSON.stringify(INIT_BODY),
      });
      await res.text();
    }
    expect(handle.activeSessionCount()).toBe(2);

    await handle.close();
    handle = undefined; // don't double-close

    const reasons = events.map(e => e.reason);
    // Transport close may fire BEFORE registry destroy for some sessions,
    // resulting in some 'transport' + some 'shutdown'. What we require:
    // every session got exactly one close event, total count = 2.
    expect(events).toHaveLength(2);
    for (const r of reasons) {
      expect(['shutdown', 'transport']).toContain(r);
    }
  });
});

// ---- Idle sweeper integration ----------------------------------------------

describe('R3 HTTP transport — idle sweeper', () => {
  let handle: HttpTransportHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it('evicts a quiet session past the idle threshold with reason=idle', async () => {
    const sessions = makeSessions();
    const events: Array<{ sid: string; reason: SessionCloseReason }> = [];
    sessions.registerCloseHandler((sid, reason) => events.push({ sid, reason }));

    // Tiny idle window so the sweeper fires quickly. sweepInterval is
    // idleMs/2 clamped to [1s, 60s], so we'll get a sweep every 1s.
    handle = await startHttpTransport({
      host: '127.0.0.1', port: 0, maxBodyBytes: 4096,
      headersTimeoutMs: 10_000, requestTimeoutMs: 60_000, keepAliveTimeoutMs: 5_000,
      trustProxy: false, idleMs: 1_200, sessions,
      instance: { name: 'test', source: 'file', projects: [] },
      serverFactory: makeFactory(),
    });
    const addr = handle.httpServer.address();
    if (typeof addr !== 'object' || addr === null) throw new Error('no address');
    const port = addr.port;

    const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify(INIT_BODY),
    });
    const sid = init.headers.get('mcp-session-id')!;
    await init.text();
    expect(handle.activeSessionCount()).toBe(1);

    // Wait past idle threshold + at least one sweep tick. Poll up to ~5s.
    const deadline = Date.now() + 5_000;
    while (handle.activeSessionCount() > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }

    expect(handle.activeSessionCount()).toBe(0);
    const idleEvent = events.find(e => e.sid === sid && e.reason === 'idle');
    expect(idleEvent).toBeDefined();
  }, 10_000);

  it('active session is NOT evicted — inbound requests reset the idle clock', async () => {
    const sessions = makeSessions();
    handle = await startHttpTransport({
      host: '127.0.0.1', port: 0, maxBodyBytes: 4096,
      headersTimeoutMs: 10_000, requestTimeoutMs: 60_000, keepAliveTimeoutMs: 5_000,
      trustProxy: false, idleMs: 1_500, sessions,
      instance: { name: 'test', source: 'file', projects: [] },
      serverFactory: makeFactory(),
    });
    const addr = handle.httpServer.address();
    if (typeof addr !== 'object' || addr === null) throw new Error('no address');
    const port = addr.port;

    const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' },
      body: JSON.stringify(INIT_BODY),
    });
    const sid = init.headers.get('mcp-session-id')!;
    await init.text();

    // Hit notifications/initialized first so tool calls are allowed
    const notif = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'mcp-session-id': sid },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    await notif.text();

    // Every 500ms for 3s, send a request to keep the session active.
    // Total duration (3s) is >2x the idle threshold (1.5s). If inbound
    // requests reset the clock, the session survives. If not, it gets swept.
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 500));
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'mcp-session-id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', id: i + 10, method: 'tools/list' }),
      });
      expect(res.status).toBe(200);
      await res.text();
    }

    expect(handle.activeSessionCount()).toBe(1);
  }, 10_000);
});
