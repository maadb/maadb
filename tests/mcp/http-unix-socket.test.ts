// ============================================================================
// 0.7.5 — Unix domain socket transport.
//
// Same MCP/HTTP server, bound to a UDS path instead of host:port. Verifies:
//   - Bind succeeds; socket file exists with the configured mode
//   - Stale socket file from a prior crash is unlinked before bind
//   - /healthz over UDS returns {ok:true}
//   - /mcp initialize round-trips over UDS (single-shot smoke; full SDK
//     session-id machinery is exercised in http-transport.test.ts and is
//     transport-agnostic)
//   - close() unlinks the socket file
//
// Skipped on win32 to avoid AF_UNIX path-format inconsistency in CI; the
// deployment target is Linux and the code path is platform-agnostic at the
// node:http layer.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { startHttpTransport, type HttpTransportHandle } from '../../src/mcp/transport/http.js';
import { SessionRegistry } from '../../src/instance/session.js';
import type { InstanceConfig } from '../../src/instance/config.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

const isWindows = process.platform === 'win32';

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

function tempSocketPath(): string {
  const name = `maad-uds-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sock`;
  return path.join(tmpdir(), name);
}

interface UdsResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function postOverUnix(socketPath: string, urlPath: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<UdsResponse> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({
      socketPath,
      path: urlPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(payload),
        ...extraHeaders,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf-8'),
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function getOverUnix(socketPath: string, urlPath: string): Promise<UdsResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ socketPath, path: urlPath, method: 'GET' }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf-8'),
          headers: res.headers,
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'uds-test', version: '0.1' },
  },
};

function parseSseOrJson(text: string): unknown {
  const m = text.match(/^data: (.+)$/m);
  if (m) return JSON.parse(m[1]!);
  return JSON.parse(text);
}

describe.skipIf(isWindows)('Unix-socket transport', () => {
  let handle: HttpTransportHandle | null = null;
  let socketPath: string;

  beforeEach(() => {
    socketPath = tempSocketPath();
  });

  afterEach(async () => {
    if (handle) {
      try { await handle.close(); } catch { /* best-effort */ }
      handle = null;
    }
    if (existsSync(socketPath)) {
      try { unlinkSync(socketPath); } catch { /* best-effort */ }
    }
  });

  it('binds to a Unix socket; socket file exists at the configured path', async () => {
    handle = await startHttpTransport({
      host: '127.0.0.1',
      port: 0,
      socketPath,
      socketMode: 0o660,
      maxBodyBytes: 1024,
      headersTimeoutMs: 10_000,
      requestTimeoutMs: 60_000,
      keepAliveTimeoutMs: 5_000,
      trustProxy: false,
      idleMs: 1_800_000,
      sessions: makeSessions(),
      instance: { name: 'test', source: 'file', projects: [] },
      serverFactory: makeFactory(),
    });

    expect(existsSync(socketPath)).toBe(true);
    const st = statSync(socketPath);
    expect(st.isSocket()).toBe(true);
    // POSIX file-mode bits — chmod was applied. Compare the low 9 bits.
    // (On some FS / mounts the higher bits differ; we only care about r/w/x.)
    expect((st.mode & 0o777)).toBe(0o660);
  });

  it('unlinks a stale socket file from a prior crashed run before bind', async () => {
    // Simulate a leftover socket file from a previous process
    writeFileSync(socketPath, '', { mode: 0o600 });
    expect(existsSync(socketPath)).toBe(true);

    handle = await startHttpTransport({
      host: '127.0.0.1',
      port: 0,
      socketPath,
      maxBodyBytes: 1024,
      headersTimeoutMs: 10_000,
      requestTimeoutMs: 60_000,
      keepAliveTimeoutMs: 5_000,
      trustProxy: false,
      idleMs: 1_800_000,
      sessions: makeSessions(),
      instance: { name: 'test', source: 'file', projects: [] },
      serverFactory: makeFactory(),
    });

    // Bind succeeded; the file at that path is now a real socket, not the
    // stale regular file.
    expect(statSync(socketPath).isSocket()).toBe(true);
  });

  it('/healthz over UDS returns {ok:true}', async () => {
    handle = await startHttpTransport({
      host: '127.0.0.1',
      port: 0,
      socketPath,
      maxBodyBytes: 1024,
      headersTimeoutMs: 10_000,
      requestTimeoutMs: 60_000,
      keepAliveTimeoutMs: 5_000,
      trustProxy: false,
      idleMs: 1_800_000,
      sessions: makeSessions(),
      instance: { name: 'test', source: 'file', projects: [] },
      serverFactory: makeFactory(),
    });

    const res = await getOverUnix(socketPath, '/healthz');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    // Hardening header applied identically to TCP path
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('/mcp initialize round-trips over UDS', async () => {
    handle = await startHttpTransport({
      host: '127.0.0.1',
      port: 0,
      socketPath,
      maxBodyBytes: 4096,
      headersTimeoutMs: 10_000,
      requestTimeoutMs: 60_000,
      keepAliveTimeoutMs: 5_000,
      trustProxy: false,
      idleMs: 1_800_000,
      sessions: makeSessions(),
      instance: { name: 'test', source: 'file', projects: [] },
      serverFactory: makeFactory(),
    });

    const res = await postOverUnix(socketPath, '/mcp', INIT_BODY);
    expect(res.status).toBe(200);
    const parsed = parseSseOrJson(res.body) as { result?: { protocolVersion?: string }; error?: unknown };
    expect(parsed.error).toBeUndefined();
    expect(parsed.result?.protocolVersion).toBeDefined();
    // SDK assigns a session id; surfaced as response header
    expect(res.headers['mcp-session-id']).toBeDefined();
  });

  it('close() unlinks the socket file', async () => {
    handle = await startHttpTransport({
      host: '127.0.0.1',
      port: 0,
      socketPath,
      maxBodyBytes: 1024,
      headersTimeoutMs: 10_000,
      requestTimeoutMs: 60_000,
      keepAliveTimeoutMs: 5_000,
      trustProxy: false,
      idleMs: 1_800_000,
      sessions: makeSessions(),
      instance: { name: 'test', source: 'file', projects: [] },
      serverFactory: makeFactory(),
    });
    expect(existsSync(socketPath)).toBe(true);

    await handle.close();
    handle = null;

    expect(existsSync(socketPath)).toBe(false);
  });
});
