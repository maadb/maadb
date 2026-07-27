// ============================================================================
// HTTP session principal binding — cross-token session reuse is rejected,
// and revocation / rotation / expiry terminate bound sessions.
//
// Covers:
//   - A second valid principal (admin or reader) presenting another
//     principal's session id gets 404 SESSION_NOT_FOUND — wire-identical to
//     an unknown session, on POST, GET (SSE), and DELETE
//   - The rightful principal keeps working after a mismatch attempt
//   - evictInvalidTokenSessions tears down sessions bound to revoked /
//     rotated / expired tokens (registry close fan-out fires reason=auth)
//   - excludeSessionId skips exactly one session, once
//   - Sweeper backstop evicts without an explicit call
//   - Live SSE stream ends on eviction
//   - tokens-undefined bypass mode is unaffected
//   - session_principal_mismatch is logged with token ids, never plaintext
// ============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import pino from 'pino';
import { createRequire } from 'node:module';
import { startHttpTransport, type HttpTransportHandle } from '../../src/mcp/transport/http.js';
import { initLogging } from '../../src/logging.js';
import { SessionRegistry, type SessionCloseReason } from '../../src/instance/session.js';
import type { InstanceConfig } from '../../src/instance/config.js';
import { makeTokenFixture, type TokenFixture } from '../support/token-fixture.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

const INIT_BODY = {
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'binding-test', version: '0.1' } },
};

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

interface Started {
  handle: HttpTransportHandle;
  port: number;
  sessions: SessionRegistry;
  closeEvents: Array<{ sid: string; reason: SessionCloseReason }>;
}

async function start(fixture: TokenFixture | null, opts: { idleMs?: number } = {}): Promise<Started> {
  const instance: InstanceConfig = { name: 'test', source: 'file', projects: [] };
  const sessions = makeSessions();
  const closeEvents: Array<{ sid: string; reason: SessionCloseReason }> = [];
  sessions.registerCloseHandler((sid, reason) => { closeEvents.push({ sid, reason }); });
  const handle = await startHttpTransport({
    host: '127.0.0.1', port: 0, maxBodyBytes: 4096,
    headersTimeoutMs: 10_000, requestTimeoutMs: 60_000, keepAliveTimeoutMs: 5_000,
    trustProxy: false, idleMs: opts.idleMs ?? 1_800_000,
    sessions,
    instance,
    tokens: fixture?.store,
    serverFactory: makeFactory(),
  });
  const addr = handle.httpServer.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  return { handle, port: addr.port, sessions, closeEvents };
}

function authHeaders(bearer?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (bearer !== undefined) headers['Authorization'] = `Bearer ${bearer}`;
  return headers;
}

async function initSession(port: number, bearer?: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: authHeaders(bearer),
    body: JSON.stringify(INIT_BODY),
  });
  expect(res.status).toBe(200);
  const sid = res.headers.get('mcp-session-id');
  expect(sid).toBeTruthy();
  await res.text();
  return sid!;
}

async function callToolsList(port: number, sid: string, bearer?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { ...authHeaders(bearer), 'mcp-session-id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/list' }),
  });
}

describe('HTTP session principal binding — cross-token reuse rejection', () => {
  let fixture: TokenFixture | null = null;
  let started: Started | undefined;

  afterEach(async () => {
    if (started) { await started.handle.close(); started = undefined; }
    if (fixture) { await fixture.cleanup(); fixture = null; }
  });

  it('a second admin token cannot use another principal\'s session id (POST)', async () => {
    fixture = await makeTokenFixture();
    const other = await fixture.store.issue({ role: 'admin', projects: [{ name: '*' }] });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    started = await start(fixture);

    const sid = await initSession(started.port, fixture.plaintext);
    const res = await callToolsList(started.port, sid, other.value.plaintext);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.errors[0].code).toBe('SESSION_NOT_FOUND');
  });

  it('a reader token cannot use an admin-created session id', async () => {
    fixture = await makeTokenFixture();   // admin
    const reader = await fixture.store.issue({ role: 'reader', projects: [{ name: '*' }] });
    expect(reader.ok).toBe(true);
    if (!reader.ok) return;
    started = await start(fixture);

    const sid = await initSession(started.port, fixture.plaintext);
    const res = await callToolsList(started.port, sid, reader.value.plaintext);
    expect(res.status).toBe(404);
    await res.text();
  });

  it('mismatch response is wire-identical to an unknown session', async () => {
    fixture = await makeTokenFixture();
    const other = await fixture.store.issue({ role: 'admin', projects: [{ name: '*' }] });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    started = await start(fixture);

    const sid = await initSession(started.port, fixture.plaintext);
    const mismatch = await callToolsList(started.port, sid, other.value.plaintext);
    const unknown = await callToolsList(started.port, 'no-such-session-id', other.value.plaintext);
    expect(mismatch.status).toBe(unknown.status);
    expect(await mismatch.text()).toBe(await unknown.text());
  });

  it('GET (SSE attach) with a different principal is rejected 404', async () => {
    fixture = await makeTokenFixture();
    const other = await fixture.store.issue({ role: 'admin', projects: [{ name: '*' }] });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    started = await start(fixture);

    const sid = await initSession(started.port, fixture.plaintext);
    const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'GET',
      headers: { 'Accept': 'text/event-stream', 'Authorization': `Bearer ${other.value.plaintext}`, 'mcp-session-id': sid },
    });
    expect(res.status).toBe(404);
    await res.text();
  });

  it('DELETE with a different principal is rejected and the session survives', async () => {
    fixture = await makeTokenFixture();
    const other = await fixture.store.issue({ role: 'admin', projects: [{ name: '*' }] });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    started = await start(fixture);

    const sid = await initSession(started.port, fixture.plaintext);
    const del = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${other.value.plaintext}`, 'mcp-session-id': sid },
    });
    expect(del.status).toBe(404);
    await del.text();
    expect(started.handle.activeSessionCount()).toBe(1);

    // Rightful principal still works after the hijack attempt.
    const owner = await callToolsList(started.port, sid, fixture.plaintext);
    expect(owner.status).toBe(200);
    await owner.text();
  });

  it('the bound principal keeps full access (control case)', async () => {
    fixture = await makeTokenFixture();
    started = await start(fixture);
    const sid = await initSession(started.port, fixture.plaintext);
    const res = await callToolsList(started.port, sid, fixture.plaintext);
    expect(res.status).toBe(200);
    await res.text();
  });

  it('tokens-undefined bypass mode still routes sessions (no principal to compare)', async () => {
    started = await start(null);
    const sid = await initSession(started.port);
    const res = await callToolsList(started.port, sid);
    expect(res.status).toBe(200);
    await res.text();
  });
});

describe('HTTP session principal binding — revocation / rotation / expiry teardown', () => {
  let fixture: TokenFixture | null = null;
  let started: Started | undefined;

  afterEach(async () => {
    if (started) { await started.handle.close(); started = undefined; }
    if (fixture) { await fixture.cleanup(); fixture = null; }
  });

  it('revoke + evict destroys the bound session with reason=auth; old bearer gets 401', async () => {
    fixture = await makeTokenFixture();
    started = await start(fixture);
    const sid = await initSession(started.port, fixture.plaintext);

    const revoked = await fixture.store.revoke(fixture.record.id);
    expect(revoked.ok).toBe(true);
    const evicted = started.handle.evictInvalidTokenSessions();
    expect(evicted).toBe(1);
    expect(started.handle.activeSessionCount()).toBe(0);
    expect(started.closeEvents).toContainEqual({ sid, reason: 'auth' });

    // Old bearer cannot execute another call — middleware 401s before routing.
    const res = await callToolsList(started.port, sid, fixture.plaintext);
    expect(res.status).toBe(401);
    await res.text();
  });

  it('rotate: old session dies, new bearer cannot resume the old session id', async () => {
    fixture = await makeTokenFixture();
    started = await start(fixture);
    const sid = await initSession(started.port, fixture.plaintext);

    const rotated = await fixture.store.rotate(fixture.record.id);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(started.handle.evictInvalidTokenSessions()).toBe(1);

    // Old plaintext: revoked → 401. New plaintext + old sid: session is gone → 404.
    const oldBearer = await callToolsList(started.port, sid, fixture.plaintext);
    expect(oldBearer.status).toBe(401);
    await oldBearer.text();
    const newBearer = await callToolsList(started.port, sid, rotated.value.plaintext);
    expect(newBearer.status).toBe(404);
    await newBearer.text();

    // New bearer starts a fresh session normally.
    const freshSid = await initSession(started.port, rotated.value.plaintext);
    expect(freshSid).not.toBe(sid);
  });

  it('expired token sessions are evicted with reason=expired', async () => {
    fixture = await makeTokenFixture();
    const shortLived = await fixture.store.issue({
      role: 'admin',
      projects: [{ name: '*' }],
      expiresAt: new Date(Date.now() + 400).toISOString(),
    });
    expect(shortLived.ok).toBe(true);
    if (!shortLived.ok) return;
    started = await start(fixture);

    await initSession(started.port, shortLived.value.plaintext);
    expect(started.handle.evictInvalidTokenSessions()).toBe(0);   // still valid

    await new Promise(r => setTimeout(r, 600));
    expect(started.handle.evictInvalidTokenSessions()).toBe(1);
    expect(started.handle.activeSessionCount()).toBe(0);
  });

  it('excludeSessionId defers exactly that session to the next sweep', async () => {
    fixture = await makeTokenFixture();
    started = await start(fixture);
    const sidA = await initSession(started.port, fixture.plaintext);
    const sidB = await initSession(started.port, fixture.plaintext);
    expect(started.handle.activeSessionCount()).toBe(2);

    await fixture.store.revoke(fixture.record.id);
    expect(started.handle.evictInvalidTokenSessions(sidA)).toBe(1);
    expect(started.handle.activeSessionCount()).toBe(1);
    expect(started.closeEvents).toContainEqual({ sid: sidB, reason: 'auth' });

    // The excluded session is not immune — the next unexcluded pass takes it.
    expect(started.handle.evictInvalidTokenSessions()).toBe(1);
    expect(started.handle.activeSessionCount()).toBe(0);
  });

  it('sweeper backstop evicts revoked-token sessions without an explicit call', async () => {
    fixture = await makeTokenFixture();
    started = await start(fixture, { idleMs: 3_000 });   // sweep tick ≈ 1.5s
    await initSession(started.port, fixture.plaintext);

    await fixture.store.revoke(fixture.record.id);
    const deadline = Date.now() + 5_000;
    while (started.handle.activeSessionCount() > 0 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100));
    }
    expect(started.handle.activeSessionCount()).toBe(0);
    expect(started.closeEvents.some(e => e.reason === 'auth')).toBe(true);
  }, 10_000);

  it('a live SSE stream ends when its session is evicted', async () => {
    fixture = await makeTokenFixture();
    started = await start(fixture);
    const sid = await initSession(started.port, fixture.plaintext);

    const sse = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'GET',
      headers: { 'Accept': 'text/event-stream', 'Authorization': `Bearer ${fixture.plaintext}`, 'mcp-session-id': sid },
    });
    expect(sse.status).toBe(200);
    const reader = sse.body!.getReader();

    await fixture.store.revoke(fixture.record.id);
    expect(started.handle.evictInvalidTokenSessions()).toBe(1);

    // The stream must terminate — read() resolves done (or rejects on abrupt
    // socket close, which equally proves termination). Guard with a timeout so
    // a leaked-open stream fails fast instead of hanging the suite.
    const terminated = await Promise.race([
      reader.read().then(() => true, () => true),
      new Promise<false>(r => setTimeout(() => r(false), 4_000)),
    ]);
    expect(terminated).toBe(true);
  }, 10_000);
});

describe('HTTP session principal binding — log hygiene', () => {
  let fixture: TokenFixture | null = null;
  let started: Started | undefined;

  afterEach(async () => {
    if (started) { await started.handle.close(); started = undefined; }
    if (fixture) { await fixture.cleanup(); fixture = null; }
    initLogging();
  });

  it('mismatch logs session_principal_mismatch with token ids and no plaintext', async () => {
    const chunks: string[] = [];
    const memStream = { write(chunk: string): boolean { chunks.push(chunk); return true; } };
    initLogging({ opsDestination: memStream as unknown as pino.DestinationStream });

    fixture = await makeTokenFixture();
    const other = await fixture.store.issue({ role: 'admin', projects: [{ name: '*' }] });
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    started = await start(fixture);

    const sid = await initSession(started.port, fixture.plaintext);
    const res = await callToolsList(started.port, sid, other.value.plaintext);
    expect(res.status).toBe(404);
    await res.text();

    const log = chunks.join('');
    expect(log).toMatch(/session_principal_mismatch/);
    expect(log).toContain(fixture.record.id);
    expect(log).toContain(other.value.record.id);
    expect(log).not.toContain(fixture.plaintext);
    expect(log).not.toContain(other.value.plaintext);
  });

  it('eviction logs session_token_evicted with the reason', async () => {
    const chunks: string[] = [];
    const memStream = { write(chunk: string): boolean { chunks.push(chunk); return true; } };
    initLogging({ opsDestination: memStream as unknown as pino.DestinationStream });

    fixture = await makeTokenFixture();
    started = await start(fixture);
    await initSession(started.port, fixture.plaintext);
    await fixture.store.revoke(fixture.record.id);
    started.handle.evictInvalidTokenSessions();

    const log = chunks.join('');
    expect(log).toMatch(/session_token_evicted/);
    expect(log).toContain('"reason":"revoked"');
    expect(log).not.toContain(fixture.plaintext);
  });
});
