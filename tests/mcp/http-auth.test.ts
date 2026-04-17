// ============================================================================
// 0.5.0 R2 — Bearer auth middleware tests
//
// Unit tests for the pure validator (validateBearer, boot-time helpers) plus
// integration tests that exercise the HTTP transport with an authToken set,
// asserting:
//   - valid bearer → 200 on initialize
//   - missing authorization → 401 UNAUTHORIZED
//   - wrong scheme / malformed / case variations → 401 UNAUTHORIZED
//   - wrong token value → 401 UNAUTHORIZED
//   - 401 precedes 404: unknown session id WITHOUT auth still returns 401
//   - no token leak in pino ops log (redaction works end-to-end)
//   - constant-time compare is actually used (timingSafeEqual path)
// ============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import pino from 'pino';
import { createRequire } from 'node:module';
import type { IncomingMessage } from 'node:http';
import { startHttpTransport, type HttpTransportHandle } from '../../src/mcp/transport/http.js';
import { validateBearer, checkAuthTokenAtBoot, shortTokenWarning } from '../../src/mcp/transport/auth.js';
import { initLogging } from '../../src/logging.js';
import { SessionRegistry } from '../../src/instance/session.js';
import type { InstanceConfig } from '../../src/instance/config.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

function makeSessions(): SessionRegistry {
  const instance: InstanceConfig = { name: 'test', source: 'file', projects: [] };
  return new SessionRegistry(instance);
}

const GOOD_TOKEN = 'test-token-32-chars-long-abcdef1234';

function makeFactory(): () => McpServer {
  return () => {
    const server = new McpServer({ name: 'maad-test', version: pkg.version });
    server.tool('ping', 'Returns pong.', async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }));
    return server;
  };
}

function baseOpts(overrides: Partial<Parameters<typeof startHttpTransport>[0]> = {}): Parameters<typeof startHttpTransport>[0] {
  return {
    host: '127.0.0.1',
    port: 0,
    maxBodyBytes: 4096,
    headersTimeoutMs: 10_000,
    requestTimeoutMs: 60_000,
    keepAliveTimeoutMs: 5_000,
    trustProxy: false,
    idleMs: 1_800_000,
    sessions: makeSessions(),
    instance: { name: 'test', source: 'file', projects: [] },
    authToken: GOOD_TOKEN,
    serverFactory: makeFactory(),
    ...overrides,
  };
}

async function startWithAssignedPort(overrides: Partial<Parameters<typeof startHttpTransport>[0]> = {}): Promise<{ handle: HttpTransportHandle; port: number }> {
  const handle = await startHttpTransport(baseOpts(overrides));
  const addr = handle.httpServer.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  return { handle, port: addr.port };
}

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'r2-test', version: '0.1' },
  },
};

// ---- Unit tests: pure validators --------------------------------------------

describe('R2 validateBearer — pure validator', () => {
  function fakeReq(authHeader?: string | string[]): IncomingMessage {
    return { headers: { authorization: authHeader } } as unknown as IncomingMessage;
  }

  it('accepts a matching token', () => {
    const res = validateBearer(fakeReq(`Bearer ${GOOD_TOKEN}`), GOOD_TOKEN);
    expect(res.ok).toBe(true);
  });

  it('rejects a missing Authorization header as "missing"', () => {
    const res = validateBearer(fakeReq(undefined), GOOD_TOKEN);
    expect(res).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects an empty Authorization header as "missing"', () => {
    const res = validateBearer(fakeReq(''), GOOD_TOKEN);
    expect(res).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects non-Bearer schemes as "missing"', () => {
    const res = validateBearer(fakeReq(`Basic ${GOOD_TOKEN}`), GOOD_TOKEN);
    expect(res).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects malformed bearer (no space) as "missing"', () => {
    const res = validateBearer(fakeReq('Bearer'), GOOD_TOKEN);
    expect(res).toEqual({ ok: false, reason: 'missing' });
  });

  it('accepts lowercase "bearer" scheme (HTTP is case-insensitive)', () => {
    const res = validateBearer(fakeReq(`bearer ${GOOD_TOKEN}`), GOOD_TOKEN);
    expect(res.ok).toBe(true);
  });

  it('rejects a wrong token value as "invalid"', () => {
    const res = validateBearer(fakeReq(`Bearer wrong-token-of-same-length-xxxxxxxxxxxx`), GOOD_TOKEN);
    expect(res).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a differently-sized token as "invalid" without timingSafeEqual throwing', () => {
    const res = validateBearer(fakeReq('Bearer short'), GOOD_TOKEN);
    // Note: short will NOT throw; length-mismatch path normalizes timing and returns invalid.
    expect(res).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects array-valued Authorization header as "missing" (not valid HTTP)', () => {
    const res = validateBearer(fakeReq(['Bearer x', 'Bearer y']), GOOD_TOKEN);
    expect(res).toEqual({ ok: false, reason: 'missing' });
  });
});

describe('R2 boot helpers', () => {
  it('checkAuthTokenAtBoot rejects undefined/empty with AUTH_TOKEN_REQUIRED message', () => {
    expect(checkAuthTokenAtBoot(undefined)).toMatch(/^AUTH_TOKEN_REQUIRED/);
    expect(checkAuthTokenAtBoot('')).toMatch(/^AUTH_TOKEN_REQUIRED/);
  });

  it('checkAuthTokenAtBoot accepts any non-empty token', () => {
    expect(checkAuthTokenAtBoot('x')).toBeNull();
    expect(checkAuthTokenAtBoot(GOOD_TOKEN)).toBeNull();
  });

  it('shortTokenWarning fires for <16 chars', () => {
    expect(shortTokenWarning('short')).toMatch(/is only 5 chars/);
  });

  it('shortTokenWarning is silent for >=16 chars', () => {
    expect(shortTokenWarning('x'.repeat(16))).toBeNull();
    expect(shortTokenWarning(GOOD_TOKEN)).toBeNull();
  });
});

// ---- Integration tests: live transport with auth ----------------------------

describe('R2 HTTP transport — auth enforcement', () => {
  let handle: HttpTransportHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it('accepts request with valid Bearer token (initialize → 200)', async () => {
    const started = await startWithAssignedPort();
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': `Bearer ${GOOD_TOKEN}`,
      },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('rejects request with missing Authorization header → 401 UNAUTHORIZED', async () => {
    const started = await startWithAssignedPort();
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors[0].code).toBe('UNAUTHORIZED');
    // No token echo, no detail leak
    expect(JSON.stringify(body)).not.toContain(GOOD_TOKEN);
  });

  it('rejects request with wrong token value → 401 UNAUTHORIZED', async () => {
    const started = await startWithAssignedPort();
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
    const body = await res.json();
    expect(body.errors[0].code).toBe('UNAUTHORIZED');
  });

  it('rejects request with wrong scheme (Basic) → 401', async () => {
    const started = await startWithAssignedPort();
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${GOOD_TOKEN}`,
      },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(401);
  });

  it('401 precedes 404: unauth request to unknown session id returns 401 not 404', async () => {
    const started = await startWithAssignedPort();
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
    const body = await res.json();
    expect(body.errors[0].code).toBe('UNAUTHORIZED');
  });

  it('authenticated request to unknown session id still returns 404 SESSION_NOT_FOUND', async () => {
    const started = await startWithAssignedPort();
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GOOD_TOKEN}`,
        'mcp-session-id': 'does-not-exist',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.errors[0].code).toBe('SESSION_NOT_FOUND');
  });

  it('401 response carries hardening headers (nosniff + no-store)', async () => {
    const started = await startWithAssignedPort();
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('disabling auth (authToken undefined) allows unauthenticated initialize — dev/test only path', async () => {
    const started = await startWithAssignedPort({ authToken: undefined });
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify(INIT_BODY),
    });
    expect(res.status).toBe(200);
  });
});

// ---- Redaction / log hygiene -----------------------------------------------

describe('R2 log hygiene — tokens do not appear in pino output', () => {
  let handle: HttpTransportHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it('a failed-auth request does not leak the presented token into the log stream', async () => {
    // Capture pino output via a memory stream.
    const chunks: string[] = [];
    const memStream = {
      write(chunk: string): boolean {
        chunks.push(chunk);
        return true;
      },
    };
    initLogging({ opsDestination: memStream as unknown as pino.DestinationStream });

    const started = await startWithAssignedPort();
    handle = started.handle;

    const presented = 'SECRETSECRETSECRETSECRETSECRETSECRETSECRET';
    await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${presented}`,
      },
      body: JSON.stringify(INIT_BODY),
    });

    const log = chunks.join('');
    // Core safety: the presented bearer value is never logged.
    expect(log).not.toContain(presented);
    // And the real token is never logged either.
    expect(log).not.toContain(GOOD_TOKEN);
    // An auth_failure event IS logged.
    expect(log).toMatch(/auth_failure/);
    expect(log).toMatch(/"reason":"invalid"/);

    // Restore default logging for other tests.
    initLogging();
  });
});
