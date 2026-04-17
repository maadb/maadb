// ============================================================================
// 0.5.0 R6 — GET /healthz unauthenticated liveness contract
//
// Contract:
//   - 200 {"ok":true} when process is live
//   - 503 {"ok":false, errors:[{code:"SHUTTING_DOWN"}]} during drain
//   - No bearer required (routed BEFORE auth middleware)
//   - Body contains no internal state (no project names, doc counts,
//     transport details, session counts) on either path
//   - Hardening headers applied (nosniff + no-store)
//   - Only /healthz + GET — other methods/paths fall through to /mcp handler
//   - Not exposed under stdio — tested indirectly via transport selection
// ============================================================================

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRequire } from 'node:module';
import { startHttpTransport, type HttpTransportHandle } from '../../src/mcp/transport/http.js';
import { SessionRegistry } from '../../src/instance/session.js';
import type { InstanceConfig } from '../../src/instance/config.js';
import { __resetShutdownState, beginShutdown } from '../../src/mcp/shutdown.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

const GOOD_TOKEN = 'healthz-test-token-32-chars-a1b2c3';

function makeSessions(): SessionRegistry {
  const instance: InstanceConfig = { name: 'test', source: 'file', projects: [] };
  return new SessionRegistry(instance);
}

function makeFactory(): () => McpServer {
  return () => new McpServer({ name: 'maad-test', version: pkg.version });
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

async function start(overrides: Partial<Parameters<typeof startHttpTransport>[0]> = {}): Promise<{ handle: HttpTransportHandle; port: number }> {
  const handle = await startHttpTransport(baseOpts(overrides));
  const addr = handle.httpServer.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  return { handle, port: addr.port };
}

describe('R6 /healthz — liveness probe', () => {
  let active: HttpTransportHandle | null = null;

  beforeEach(() => {
    __resetShutdownState();
  });

  afterEach(async () => {
    if (active) {
      try { await active.close(); } catch { /* best-effort */ }
      active = null;
    }
    __resetShutdownState();
  });

  it('returns 200 {ok:true} when process is live — no bearer required', async () => {
    const { handle, port } = await start();
    active = handle;
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('still returns 200 when auth is enabled and no Authorization header is sent', async () => {
    const { handle, port } = await start({ authToken: GOOD_TOKEN });
    active = handle;
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    // Auth must NOT run for /healthz — orchestrators shouldn't need the secret.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 503 SHUTTING_DOWN during drain', async () => {
    const { handle, port } = await start();
    active = handle;

    // Begin shutdown with a fake exit + stubbed pool/rate-limiter so the drain
    // loop completes immediately; state flips to draining then exiting.
    const target = {
      pool: { totalWriteQueueDepth: () => 0, closeAll: async () => {} } as unknown as Parameters<typeof beginShutdown>[0]['pool'],
      rateLimiter: { totalInFlight: () => 0 } as unknown as Parameters<typeof beginShutdown>[0]['rateLimiter'],
    };
    const shutdown = beginShutdown(target, { exit: () => {}, shutdownTimeoutMs: 100 });

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors?.[0]?.code).toBe('SHUTTING_DOWN');

    await shutdown;
  });

  it('applies hardening headers on the success path', async () => {
    const { handle, port } = await start();
    active = handle;
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toContain('application/json');
    await res.text();
  });

  it('applies hardening headers on the 503 SHUTTING_DOWN path', async () => {
    const { handle, port } = await start();
    active = handle;
    const target = {
      pool: { totalWriteQueueDepth: () => 0, closeAll: async () => {} } as unknown as Parameters<typeof beginShutdown>[0]['pool'],
      rateLimiter: { totalInFlight: () => 0 } as unknown as Parameters<typeof beginShutdown>[0]['rateLimiter'],
    };
    const shutdown = beginShutdown(target, { exit: () => {}, shutdownTimeoutMs: 100 });

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');

    await shutdown;
  });

  it('response body contains no internal state — only {ok:...} and errors', async () => {
    const { handle, port } = await start({
      // Pollute registry so active count would show up if leaked.
      sessions: (() => { const s = makeSessions(); s.create('leakable'); return s; })(),
    });
    active = handle;

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    const body = await res.json() as Record<string, unknown>;
    // Keys should only be `ok` (success). No project/transport/session fields.
    expect(Object.keys(body).sort()).toEqual(['ok']);
  });

  it('non-GET on /healthz falls through to /mcp handling — returns 404 NOT_FOUND path or 400', async () => {
    const { handle, port } = await start();
    active = handle;
    // POST /healthz is not a liveness probe; it hits the 404 NOT_FOUND branch
    // for unknown paths (auth runs first and passes with valid bearer).
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${GOOD_TOKEN}` },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.errors?.[0]?.code).toBe('NOT_FOUND');
  });
});
