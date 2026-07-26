// ============================================================================
// 0.7.0 Scoped Auth — HTTP middleware + boot enforcement tests
//
// Replaces the 0.5.0 R2 tests for the shared-secret legacy path (which was
// hard-removed in 0.7.0). Covers:
//   - resolveToken: valid, missing, malformed, unknown hash, revoked, expired
//   - checkHttpAuthAtBoot: missing file + legacy env, missing file alone,
//     empty registry, healthy registry
//   - HTTP transport auth enforcement with registry-backed bearers
//   - 401 precedes 404 (unauth can't enumerate session IDs)
//   - No token leak in pino ops log
// ============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import pino from 'pino';
import { createRequire } from 'node:module';
import type { IncomingMessage } from 'node:http';
import { startHttpTransport, type HttpTransportHandle } from '../../src/mcp/transport/http.js';
import { resolveToken, checkHttpAuthAtBoot } from '../../src/mcp/transport/auth.js';
import { initLogging } from '../../src/logging.js';
import { SessionRegistry } from '../../src/instance/session.js';
import type { InstanceConfig } from '../../src/instance/config.js';
import { TokenStore } from '../../src/auth/token-store.js';
import { makeTokenFixture, type TokenFixture } from '../support/token-fixture.js';

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
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'r2-test', version: '0.1' } },
};

function fakeReq(authHeader?: string | string[]): IncomingMessage {
  const headers: Record<string, string | string[] | undefined> = {};
  if (authHeader !== undefined) headers['authorization'] = authHeader;
  return { headers } as unknown as IncomingMessage;
}

// ---- Unit tests: resolveToken -----------------------------------------------

describe('0.7.0 resolveToken — pure validator over TokenStore', () => {
  let fixture: TokenFixture | null = null;
  afterEach(async () => { if (fixture) { await fixture.cleanup(); fixture = null; } });

  it('accepts a valid bearer and returns the TokenRecord', async () => {
    fixture = await makeTokenFixture();
    const res = resolveToken(fakeReq(`Bearer ${fixture.plaintext}`), fixture.store);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.record.id).toBe(fixture.record.id);
    expect(res.record.role).toBe('admin');
  });

  it('returns reason:"missing" for absent Authorization header', async () => {
    fixture = await makeTokenFixture();
    const res = resolveToken(fakeReq(undefined), fixture.store);
    expect(res).toEqual({ ok: false, reason: 'missing' });
  });

  it('returns reason:"missing" for non-Bearer schemes', async () => {
    fixture = await makeTokenFixture();
    const res = resolveToken(fakeReq(`Basic ${fixture.plaintext}`), fixture.store);
    expect(res).toEqual({ ok: false, reason: 'missing' });
  });

  it('accepts lowercase "bearer" scheme (HTTP is case-insensitive)', async () => {
    fixture = await makeTokenFixture();
    const res = resolveToken(fakeReq(`bearer ${fixture.plaintext}`), fixture.store);
    expect(res.ok).toBe(true);
  });

  it('returns reason:"malformed" for well-schemed but wrong-format bearers', async () => {
    fixture = await makeTokenFixture();
    const res = resolveToken(fakeReq('Bearer not-in-maad-pat-format'), fixture.store);
    expect(res).toEqual({ ok: false, reason: 'malformed' });
  });

  it('returns reason:"unknown" for correctly-formatted bearer not in registry', async () => {
    fixture = await makeTokenFixture();
    const res = resolveToken(fakeReq('Bearer maad_pat_' + 'f'.repeat(32)), fixture.store);
    expect(res).toEqual({ ok: false, reason: 'unknown' });
  });

  it('returns reason:"revoked" for a token that exists but has revokedAt set', async () => {
    fixture = await makeTokenFixture();
    await fixture.store.revoke(fixture.record.id);
    const res = resolveToken(fakeReq(`Bearer ${fixture.plaintext}`), fixture.store);
    expect(res).toEqual({ ok: false, reason: 'revoked' });
  });

  it('returns reason:"expired" for a token whose expiresAt is in the past', async () => {
    fixture = await makeTokenFixture();
    // Issue a short-lived token via a fresh fixture
    const expired = await fixture.store.issue({
      role: 'admin',
      projects: [{ name: '*' }],
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(expired.ok).toBe(true);
    if (!expired.ok) return;
    const res = resolveToken(fakeReq(`Bearer ${expired.value.plaintext}`), fixture.store);
    expect(res).toEqual({ ok: false, reason: 'expired' });
  });

  it('returns reason:"missing" for array-valued Authorization header', async () => {
    fixture = await makeTokenFixture();
    const res = resolveToken(fakeReq(['Bearer x', 'Bearer y']), fixture.store);
    expect(res).toEqual({ ok: false, reason: 'missing' });
  });
});

// ---- Unit tests: checkHttpAuthAtBoot ---------------------------------------

describe('0.7.0 checkHttpAuthAtBoot — boot enforcement', () => {
  let fixture: TokenFixture | null = null;
  afterEach(async () => { if (fixture) { await fixture.cleanup(); fixture = null; } });

  it('passes when tokens.yaml exists and has ≥1 active entry', async () => {
    fixture = await makeTokenFixture();
    const err = checkHttpAuthAtBoot(fixture.store, true, undefined);
    expect(err).toBeNull();
  });

  it('refuses with LEGACY_BEARER_REMOVED when tokens.yaml is absent AND MAAD_AUTH_TOKEN is set', async () => {
    // Empty store (no file)
    const loaded = await TokenStore.load('/tmp/does-not-exist-maad-auth-boot');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const err = checkHttpAuthAtBoot(loaded.value, false, 'stale-shared-secret-value');
    expect(err).toMatch(/^LEGACY_BEARER_REMOVED/);
    expect(err).toContain('removed in 0.7.0');
    expect(err).toContain('maad auth issue-token');
  });

  it('refuses with TOKENS_FILE_MISSING when tokens.yaml is absent AND no legacy env', async () => {
    const loaded = await TokenStore.load('/tmp/does-not-exist-maad-auth-boot-2');
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const err = checkHttpAuthAtBoot(loaded.value, false, undefined);
    expect(err).toMatch(/^TOKENS_FILE_MISSING/);
    expect(err).toContain('maad auth issue-token');
  });

  it('refuses with TOKENS_FILE_EMPTY when tokens.yaml exists but has no active entries', async () => {
    fixture = await makeTokenFixture();
    await fixture.store.revoke(fixture.record.id);
    const err = checkHttpAuthAtBoot(fixture.store, true, undefined);
    expect(err).toMatch(/^TOKENS_FILE_EMPTY/);
  });
});

// ---- Integration tests: live transport with registry-backed auth -----------

async function startAuthed(fixture: TokenFixture): Promise<{ handle: HttpTransportHandle; port: number }> {
  const instance: InstanceConfig = { name: 'test', source: 'file', projects: [] };
  const handle = await startHttpTransport({
    host: '127.0.0.1', port: 0, maxBodyBytes: 4096,
    headersTimeoutMs: 10_000, requestTimeoutMs: 60_000, keepAliveTimeoutMs: 5_000,
    trustProxy: false, idleMs: 1_800_000,
    sessions: makeSessions(),
    instance,
    tokens: fixture.store,
    serverFactory: makeFactory(),
  });
  const addr = handle.httpServer.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  return { handle, port: addr.port };
}

describe('0.7.0 HTTP transport — auth enforcement', () => {
  let fixture: TokenFixture | null = null;
  let handle: HttpTransportHandle | undefined;

  afterEach(async () => {
    if (handle) { await handle.close(); handle = undefined; }
    if (fixture) { await fixture.cleanup(); fixture = null; }
  });

  it('accepts request with valid Bearer token (initialize → 200)', async () => {
    fixture = await makeTokenFixture();
    const started = await startAuthed(fixture);
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${fixture.plaintext}`,
      },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('rejects missing Authorization header → 401 UNAUTHORIZED with no token leak', async () => {
    fixture = await makeTokenFixture();
    const started = await startAuthed(fixture);
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.errors[0].code).toBe('UNAUTHORIZED');
    expect(JSON.stringify(body)).not.toContain(fixture.plaintext);
  });

  it('rejects a malformed bearer → 401 (no hint about registry membership)', async () => {
    fixture = await makeTokenFixture();
    const started = await startAuthed(fixture);
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer definitely-not-the-right-token-123456',
      },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown but well-formed token → 401', async () => {
    fixture = await makeTokenFixture();
    const started = await startAuthed(fixture);
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer maad_pat_${'0'.repeat(32)}`,
      },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(401);
  });

  it('rejects revoked token → 401', async () => {
    fixture = await makeTokenFixture();
    await fixture.store.revoke(fixture.record.id);
    const started = await startAuthed(fixture);
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${fixture.plaintext}`,
      },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(401);
  });

  it('401 precedes 404: unauth request to unknown session id returns 401 not 404', async () => {
    fixture = await makeTokenFixture();
    const started = await startAuthed(fixture);
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'mcp-session-id': 'does-not-exist-and-no-auth',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('authenticated request to unknown session id still returns 404 SESSION_NOT_FOUND', async () => {
    fixture = await makeTokenFixture();
    const started = await startAuthed(fixture);
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${fixture.plaintext}`,
        'mcp-session-id': 'does-not-exist',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.errors[0].code).toBe('SESSION_NOT_FOUND');
  });

  it('401 response carries hardening headers (nosniff + no-store)', async () => {
    fixture = await makeTokenFixture();
    const started = await startAuthed(fixture);
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

// ---- Log hygiene ----------------------------------------------------------

describe('0.7.0 log hygiene — tokens do not leak into pino output', () => {
  let fixture: TokenFixture | null = null;
  let handle: HttpTransportHandle | undefined;

  afterEach(async () => {
    if (handle) { await handle.close(); handle = undefined; }
    if (fixture) { await fixture.cleanup(); fixture = null; }
    initLogging();
  });

  it('a failed-auth request does not leak the presented bearer into the log stream', async () => {
    const chunks: string[] = [];
    const memStream = { write(chunk: string): boolean { chunks.push(chunk); return true; } };
    initLogging({ opsDestination: memStream as unknown as pino.DestinationStream });

    fixture = await makeTokenFixture();
    const started = await startAuthed(fixture);
    handle = started.handle;

    const presented = 'maad_pat_' + 'd'.repeat(32);   // valid format but not in registry
    await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${presented}`,
      },
      body: JSON.stringify(INIT_BODY),
    });

    const log = chunks.join('');
    expect(log).not.toContain(presented);
    expect(log).not.toContain(fixture.plaintext);
    expect(log).toMatch(/auth_failure/);
  });
});
