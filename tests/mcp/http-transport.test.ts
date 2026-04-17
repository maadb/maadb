// ============================================================================
// 0.5.0 R1 — HTTP transport scaffold tests
//
// Validates the R1 transport scaffold:
//   - Smoke: initialize → tools/list → delete round-trip over HTTP
//   - Timeout enforcement: node:http server timeouts are set from options
//   - Header presence: X-Content-Type-Options: nosniff on every response,
//     Cache-Control: no-store on JSON error responses
//   - Unknown path / unknown session error shapes
//   - Payload size cap (413)
//   - Session ID entropy (128 bits / 22-char base64url)
//   - Clean close path drops all tracked sessions
//
// Auth (R2) and full session-registry fan-out (R3) are explicitly out of
// scope here — those phases get their own test files.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRequire } from 'node:module';
import { startHttpTransport, type HttpTransportHandle } from '../../src/mcp/transport/http.js';
import { SessionRegistry } from '../../src/instance/session.js';
import type { InstanceConfig } from '../../src/instance/config.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

function makeSessions(): SessionRegistry {
  const instance: InstanceConfig = { name: 'test', source: 'file', projects: [] };
  return new SessionRegistry(instance);
}

// Minimal factory — one tool registered so the server advertises `tools`
// capability; tools/list then returns a well-formed `result` with our tool.
// Transport behavior is what's under test; we don't exercise the tool.
function makeFactory(): () => McpServer {
  return () => {
    const server = new McpServer({ name: 'maad-test', version: pkg.version });
    server.tool('ping', 'Returns pong.', async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }));
    return server;
  };
}

// Default test options — small limits so tests run fast, loopback only.
function defaultOpts(overrides: Partial<Parameters<typeof startHttpTransport>[0]> = {}): Parameters<typeof startHttpTransport>[0] {
  return {
    host: '127.0.0.1',
    port: 0, // 0 = OS-assigned free port
    maxBodyBytes: 1024,
    headersTimeoutMs: 10_000,
    requestTimeoutMs: 60_000,
    keepAliveTimeoutMs: 5_000,
    trustProxy: false,
    idleMs: 1_800_000,
    sessions: makeSessions(),
    instance: { name: 'test', source: 'file', projects: [] },
    serverFactory: makeFactory(),
    ...overrides,
  };
}

async function startWithAssignedPort(overrides: Partial<Parameters<typeof startHttpTransport>[0]> = {}): Promise<{ handle: HttpTransportHandle; port: number }> {
  const handle = await startHttpTransport(defaultOpts(overrides));
  const addr = handle.httpServer.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  return { handle, port: addr.port };
}

async function postJson(port: number, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function readSseOrJson(res: Response): Promise<unknown> {
  const text = await res.text();
  // SSE payloads come as 'event: message\ndata: {json}\n\n'
  const m = text.match(/^data: (.+)$/m);
  if (m) return JSON.parse(m[1]!);
  return JSON.parse(text);
}

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'r1-test', version: '0.1' },
  },
};

describe('R1 HTTP transport — lifecycle', () => {
  let handle: HttpTransportHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it('listens on the configured port and returns 404 NOT_FOUND for unknown paths', async () => {
    const started = await startWithAssignedPort();
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/does-not-exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.errors[0].code).toBe('NOT_FOUND');
  });

  it('POST /mcp initialize → 200 + mcp-session-id header + 128-bit CSPRNG session id', async () => {
    const started = await startWithAssignedPort();
    handle = started.handle;

    const res = await postJson(started.port, INIT_BODY);
    expect(res.status).toBe(200);

    const sid = res.headers.get('mcp-session-id');
    expect(sid).toBeTruthy();
    // crypto.randomBytes(16).toString('base64url') → 22 chars, [A-Za-z0-9_-]
    expect(sid!.length).toBe(22);
    expect(sid!).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const body = await readSseOrJson(res);
    expect(body).toMatchObject({ jsonrpc: '2.0', id: 1 });

    expect(handle.activeSessionCount()).toBe(1);
  });

  it('unknown session id → 404 SESSION_NOT_FOUND', async () => {
    const started = await startWithAssignedPort();
    handle = started.handle;

    const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'mcp-session-id': 'this-does-not-exist',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.errors[0].code).toBe('SESSION_NOT_FOUND');
  });

  it('close() drops all tracked sessions', async () => {
    const started = await startWithAssignedPort();
    handle = started.handle;

    const res = await postJson(started.port, INIT_BODY);
    expect(res.status).toBe(200);
    await res.text(); // drain SSE body
    expect(handle.activeSessionCount()).toBe(1);

    await handle.close();
    handle = undefined; // don't double-close in afterEach
    // If the server truly closed, a subsequent connect attempt fails fast.
    await expect(
      fetch(`http://127.0.0.1:${started.port}/mcp`, { method: 'POST' })
    ).rejects.toThrow();
  });
});

describe('R1 HTTP transport — response hardening headers', () => {
  let handle: HttpTransportHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it('X-Content-Type-Options: nosniff on 404 (unknown path)', async () => {
    const started = await startWithAssignedPort();
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/nope`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('X-Content-Type-Options: nosniff on 404 (unknown session)', async () => {
    const started = await startWithAssignedPort();
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'mcp-session-id': 'unknown' },
      body: '{}',
    });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('Cache-Control: no-store on JSON error bodies', async () => {
    const started = await startWithAssignedPort();
    handle = started.handle;
    const res = await fetch(`http://127.0.0.1:${started.port}/nope`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('R1 HTTP transport — body size cap', () => {
  let handle: HttpTransportHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it('rejects body over maxBodyBytes with 413 PAYLOAD_TOO_LARGE', async () => {
    const started = await startWithAssignedPort({ maxBodyBytes: 128 });
    handle = started.handle;
    const oversized = 'x'.repeat(500);
    const res = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: oversized }),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.errors[0].code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('R1 HTTP transport — timeout enforcement', () => {
  let handle: HttpTransportHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it('headersTimeout, requestTimeout, keepAliveTimeout applied from options', async () => {
    const started = await startWithAssignedPort({
      headersTimeoutMs: 7_777,
      requestTimeoutMs: 33_333,
      keepAliveTimeoutMs: 4_444,
    });
    handle = started.handle;
    expect(handle.httpServer.headersTimeout).toBe(7_777);
    expect(handle.httpServer.requestTimeout).toBe(33_333);
    expect(handle.httpServer.keepAliveTimeout).toBe(4_444);
  });

  it('timeouts default to spec values when not overridden', async () => {
    const started = await startWithAssignedPort();
    handle = started.handle;
    expect(handle.httpServer.headersTimeout).toBe(10_000);
    expect(handle.httpServer.requestTimeout).toBe(60_000);
    expect(handle.httpServer.keepAliveTimeout).toBe(5_000);
  });
});

describe('R1 HTTP transport — smoke integration (initialize → tools/list → delete)', () => {
  let handle: HttpTransportHandle | undefined;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = undefined;
    }
  });

  it('full round-trip with a no-tools server factory', async () => {
    const started = await startWithAssignedPort();
    handle = started.handle;

    // 1. initialize
    const initRes = await postJson(started.port, INIT_BODY);
    expect(initRes.status).toBe(200);
    const sid = initRes.headers.get('mcp-session-id')!;
    await initRes.text(); // drain

    // 2. notifications/initialized
    const notifRes = await postJson(
      started.port,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { 'mcp-session-id': sid },
    );
    expect(notifRes.status).toBe(202);
    await notifRes.text();

    // 3. tools/list
    const listRes = await postJson(
      started.port,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'mcp-session-id': sid },
    );
    expect(listRes.status).toBe(200);
    const listBody = await readSseOrJson(listRes) as { result: { tools: unknown[] } };
    expect(listBody.result).toBeDefined();
    expect(Array.isArray(listBody.result.tools)).toBe(true);
    expect(listBody.result.tools).toHaveLength(1);
    expect((listBody.result.tools[0] as { name: string }).name).toBe('ping');

    expect(handle.activeSessionCount()).toBe(1);

    // 4. DELETE /mcp
    const delRes = await fetch(`http://127.0.0.1:${started.port}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sid },
    });
    expect(delRes.status).toBeGreaterThanOrEqual(200);
    expect(delRes.status).toBeLessThan(300);
    await delRes.text();

    // Session should be gone from the transport map after DELETE triggers onclose
    // (onclose may fire asynchronously — poll briefly)
    for (let i = 0; i < 10 && handle.activeSessionCount() > 0; i++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(handle.activeSessionCount()).toBe(0);
  });
});
