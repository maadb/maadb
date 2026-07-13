// ============================================================================
// 0.12.0 Origin validation — MCP Streamable HTTP DNS-rebinding defense
//
// Spec (2025-11-25 §Streamable HTTP Security Warning): servers MUST validate
// the Origin header; a present invalid Origin MUST receive HTTP 403. Absent
// Origin passes — non-browser MCP clients don't send one.
//
// Covers the contract's required cases:
//   1. No-Origin /mcp initialize passes unchanged
//   2. Exact allowlisted Origin passes
//   3. Foreign Origin → 403 before auth (403, not 401) and before session lookup
//   4. Rejection creates no session and doesn't touch existing-session state
//   5. Malformed, duplicated, and `null` Origins → 403
//   6. Empty/omitted allowlist rejects any presented Origin
//   7. /healthz unchanged (check is scoped to /mcp)
//   8. Allowlist parsing: multiple exact origins accepted, invalid config fails
// ============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
import { startHttpTransport, type HttpTransportHandle } from '../../src/mcp/transport/http.js';
import { parseAllowedOrigins, splitOriginList, checkOrigin } from '../../src/mcp/transport/origin.js';
import { SessionRegistry } from '../../src/instance/session.js';
import type { InstanceConfig } from '../../src/instance/config.js';
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
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'origin-test', version: '0.1' } },
};

interface Started { handle: HttpTransportHandle; port: number }

async function startTransport(allowedOrigins?: readonly string[], tokens?: TokenFixture): Promise<Started> {
  const instance: InstanceConfig = { name: 'test', source: 'file', projects: [] };
  const handle = await startHttpTransport({
    host: '127.0.0.1', port: 0, maxBodyBytes: 4096,
    headersTimeoutMs: 10_000, requestTimeoutMs: 60_000, keepAliveTimeoutMs: 5_000,
    trustProxy: false, idleMs: 1_800_000,
    sessions: makeSessions(),
    instance,
    tokens: tokens?.store,
    allowedOrigins,
    serverFactory: makeFactory(),
  });
  const addr = handle.httpServer.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  return { handle, port: addr.port };
}

function initHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    ...extra,
  };
}

async function postInit(port: number, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: initHeaders(extra),
    body: JSON.stringify(INIT_BODY),
  });
}

/** Raw node:http POST that can send a duplicated Origin header (fetch cannot). */
function postInitDuplicateOrigin(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(INIT_BODY);
    const req = httpRequest({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
        // Node sends an array value as repeated header lines.
        'Origin': ['https://a.example.com', 'https://b.example.com'] as unknown as string,
      },
    }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ---- Unit tests: allowlist parsing + header check ---------------------------

describe('0.12.0 parseAllowedOrigins — startup canonicalization', () => {
  it('accepts multiple exact origins and canonicalizes them', () => {
    const res = parseAllowedOrigins(['https://app.example.com', 'http://localhost:3000/', 'HTTPS://Other.Example.COM']);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.origins.has('https://app.example.com')).toBe(true);
    expect(res.origins.has('http://localhost:3000')).toBe(true);
    expect(res.origins.has('https://other.example.com')).toBe(true);
  });

  it('supports comma-separated env lists via splitOriginList', () => {
    const entries = splitOriginList(' https://a.example.com , https://b.example.com ,, ');
    expect(entries).toEqual(['https://a.example.com', 'https://b.example.com']);
    const res = parseAllowedOrigins(entries);
    expect(res.ok).toBe(true);
  });

  it('rejects wildcards, paths, credentials, queries, null, and non-http schemes', () => {
    for (const bad of [
      'https://*.example.com',
      'https://example.com/app',
      'https://user:pw@example.com',
      'https://example.com?x=1',
      'https://example.com#frag',
      'null',
      'ws://example.com',
      'file:///etc',
      'not an origin',
    ]) {
      const res = parseAllowedOrigins([bad]);
      expect(res.ok, `expected '${bad}' to be rejected`).toBe(false);
    }
  });

  it('empty list parses to an empty (deny-all-browser) allowlist', () => {
    const res = parseAllowedOrigins([]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.origins.size).toBe(0);
  });
});

describe('0.12.0 checkOrigin — request-time verdicts', () => {
  const allowed = new Set(['https://app.example.com']);

  it('absent header passes', () => {
    expect(checkOrigin(undefined, allowed)).toBe('absent');
  });

  it('exact match (after canonicalization) is allowed', () => {
    expect(checkOrigin('https://app.example.com', allowed)).toBe('allowed');
    expect(checkOrigin('HTTPS://APP.EXAMPLE.COM', allowed)).toBe('allowed');
  });

  it('unlisted, malformed, null, array, and non-http origins are forbidden', () => {
    expect(checkOrigin('https://evil.example.com', allowed)).toBe('forbidden');
    expect(checkOrigin('not a url', allowed)).toBe('forbidden');
    expect(checkOrigin('null', allowed)).toBe('forbidden');
    expect(checkOrigin(['https://app.example.com', 'https://evil.example.com'], allowed)).toBe('forbidden');
    expect(checkOrigin('chrome-extension://abcdef', allowed)).toBe('forbidden');
    expect(checkOrigin('', allowed)).toBe('forbidden');
  });
});

// ---- Startup validation ------------------------------------------------------

describe('0.12.0 startHttpTransport — allowlist config validation', () => {
  it('fails startup on an invalid configured origin with an actionable message', async () => {
    await expect(startTransport(['https://*.example.com'])).rejects.toThrow(/invalid allowed-origin configuration.*wildcards/s);
  });
});

// ---- Integration: live transport --------------------------------------------

describe('0.12.0 HTTP transport — Origin enforcement on /mcp', () => {
  let handle: HttpTransportHandle | undefined;
  let fixture: TokenFixture | null = null;

  afterEach(async () => {
    if (handle) { await handle.close(); handle = undefined; }
    if (fixture) { await fixture.cleanup(); fixture = null; }
  });

  it('no-Origin initialize passes unchanged (case 1)', async () => {
    const started = await startTransport();
    handle = started.handle;
    const res = await postInit(started.port);
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('exact allowlisted Origin passes (case 2)', async () => {
    const started = await startTransport(['https://app.example.com']);
    handle = started.handle;
    const res = await postInit(started.port, { 'Origin': 'https://app.example.com' });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('foreign Origin → 403 ORIGIN_FORBIDDEN before auth, not 401 (case 3)', async () => {
    fixture = await makeTokenFixture();
    const started = await startTransport(['https://app.example.com'], fixture);
    handle = started.handle;
    // No Authorization header at all: if auth ran first this would be 401.
    const res = await postInit(started.port, { 'Origin': 'https://evil.example.com' });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.errors[0].code).toBe('ORIGIN_FORBIDDEN');
  });

  it('foreign Origin with unknown session ID → 403, not 404 (before session lookup, case 3)', async () => {
    const started = await startTransport(['https://app.example.com']);
    handle = started.handle;
    const res = await postInit(started.port, {
      'Origin': 'https://evil.example.com',
      'Mcp-Session-Id': 'does-not-exist',
    });
    expect(res.status).toBe(403);
  });

  it('rejection creates no session and leaves existing sessions usable (case 4)', async () => {
    const started = await startTransport(['https://app.example.com']);
    handle = started.handle;
    // Establish a legitimate session first.
    const ok = await postInit(started.port);
    expect(ok.status).toBe(200);
    const sid = ok.headers.get('mcp-session-id')!;
    expect(started.handle.activeSessionCount()).toBe(1);

    // Rejected browser request, including one aimed at the real session ID.
    const rejected = await postInit(started.port, { 'Origin': 'https://evil.example.com', 'Mcp-Session-Id': sid });
    expect(rejected.status).toBe(403);
    expect(started.handle.activeSessionCount()).toBe(1);

    // The legitimate session still works.
    const followUp = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: initHeaders({ 'Mcp-Session-Id': sid }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(followUp.status).toBe(200);
  });

  it('malformed, duplicated, and null Origins → 403 (case 5)', async () => {
    const started = await startTransport(['https://app.example.com']);
    handle = started.handle;
    for (const bad of ['not a url', 'null', 'chrome-extension://abc']) {
      const res = await postInit(started.port, { 'Origin': bad });
      expect(res.status, `Origin '${bad}'`).toBe(403);
    }
    const dupStatus = await postInitDuplicateOrigin(started.port);
    expect(dupStatus).toBe(403);
  });

  it('empty/omitted allowlist rejects any presented Origin, even localhost (case 6)', async () => {
    const started = await startTransport();
    handle = started.handle;
    for (const origin of ['https://app.example.com', 'http://localhost:3000', `http://127.0.0.1:${started.port}`]) {
      const res = await postInit(started.port, { 'Origin': origin });
      expect(res.status, `Origin '${origin}'`).toBe(403);
    }
  });

  it('/healthz is unaffected by a foreign Origin (case 7)', async () => {
    const started = await startTransport(['https://app.example.com']);
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/healthz`, {
      headers: { 'Origin': 'https://evil.example.com' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });
});
