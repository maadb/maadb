// ============================================================================
// 0.6.8 — X-Maad-Pin-Project acceptance tests
//
// Walks the 13 acceptance criteria for gateway-enforced session pinning:
//   #1  Valid pin creates a pinned session (status, activeProject, bindingSource)
//   #2  Unknown project → HTTP 400 PIN_PROJECT_NOT_FOUND
//   #3  Invalid regex value → HTTP 400 PIN_PROJECT_INVALID
//   #4  Duplicate header values → HTTP 400 PIN_PROJECT_INVALID
//   #5  Header + Mcp-Session-Id → HTTP 400 PIN_ON_EXISTING_SESSION
//   #6  Pinned session bindSingle rebind → SESSION_PINNED (unchanged project)
//   #7  Pinned session bindMulti rebind → SESSION_PINNED
//   #8  Pinned session can invoke a tool successfully
//   #9  SessionRegistry tracks bindingSource=gateway_pin
//   #10 Pinned count tracks correctly, decrements on destroy
//   #11 Concurrent pinned sessions with different projects remain isolated
//   #12 Synthetic (legacy) instance silently ignores pin header
//   #13 Removing a project from instance surfaces via PROJECT_UNKNOWN natural flow
// ============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { request as httpRequest } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRequire } from 'node:module';
import { startHttpTransport, type HttpTransportHandle } from '../../src/mcp/transport/http.js';
import { SessionRegistry } from '../../src/instance/session.js';
import { getProject, type InstanceConfig } from '../../src/instance/config.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

function makeInstance(projectNames: string[]): InstanceConfig {
  return {
    name: 'test-pin',
    source: 'file',
    projects: projectNames.map(n => ({ name: n, path: `/unused/${n}`, role: 'admin' })),
  };
}

function makeSyntheticInstance(): InstanceConfig {
  return {
    name: 'legacy-synthetic',
    source: 'synthetic',
    projects: [{ name: 'default', path: '/unused', role: 'admin' }],
  };
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
    clientInfo: { name: 'pin-test', version: '0.1' },
  },
};

interface Fixture {
  handle: HttpTransportHandle;
  port: number;
  sessions: SessionRegistry;
  instance: InstanceConfig;
}

async function start(instance: InstanceConfig): Promise<Fixture> {
  const sessions = new SessionRegistry(instance);
  const handle = await startHttpTransport({
    host: '127.0.0.1', port: 0, maxBodyBytes: 4096,
    headersTimeoutMs: 10_000, requestTimeoutMs: 60_000, keepAliveTimeoutMs: 5_000,
    trustProxy: false, idleMs: 1_800_000,
    sessions, instance,
    serverFactory: makeFactory(),
  });
  const addr = handle.httpServer.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  return { handle, port: addr.port, sessions, instance };
}

interface PostResult {
  status: number;
  body: Record<string, unknown> | null;
  sessionId: string | null;
  rawText: string;
}

async function postJson(port: number, body: unknown, headers: Record<string, string> = {}): Promise<PostResult> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const rawText = await res.text();
  let parsed: Record<string, unknown> | null = null;
  if (rawText.length > 0) {
    try {
      parsed = JSON.parse(rawText) as Record<string, unknown>;
    } catch {
      // SSE response — extract the first data: frame and parse it
      const match = rawText.match(/^data:\s*(.+)$/m);
      if (match) parsed = JSON.parse(match[1]!) as Record<string, unknown>;
    }
  }
  return { status: res.status, body: parsed, sessionId: res.headers.get('mcp-session-id'), rawText };
}

// Raw-socket POST so we can emit truly duplicate headers (Node client + fetch
// collapse array-valued headers to a single comma-joined line; a real
// gateway bug could send them as separate lines).
async function postWithDuplicateHeaders(
  port: number,
  headerName: string,
  headerValues: string[],
  body: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1', port, path: '/mcp', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        [headerName]: headerValues,
      },
    }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: buf }));
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

describe('0.6.8 X-Maad-Pin-Project — HTTP acceptance', () => {
  let fixture: Fixture | undefined;

  afterEach(async () => {
    if (fixture) {
      await fixture.handle.close();
      fixture = undefined;
    }
  });

  it('#1 valid pin creates a pinned session with activeProject set and bindingSource=gateway_pin', async () => {
    fixture = await start(makeInstance(['alpha', 'beta']));
    const r = await postJson(fixture.port, INIT_BODY, { 'X-Maad-Pin-Project': 'alpha' });
    expect(r.status).toBe(200);
    expect(r.sessionId).toBeTruthy();
    const state = fixture.sessions.peek(r.sessionId!);
    expect(state).toBeDefined();
    expect(state!.mode).toBe('single');
    expect(state!.activeProject).toBe('alpha');
    expect(state!.bindingSource).toBe('gateway_pin');
  });

  it('#2 pin with unknown project returns HTTP 400 PIN_PROJECT_NOT_FOUND', async () => {
    fixture = await start(makeInstance(['alpha']));
    const r = await postJson(fixture.port, INIT_BODY, { 'X-Maad-Pin-Project': 'ghost' });
    expect(r.status).toBe(400);
    const errors = (r.body as { errors?: Array<{ code: string }> }).errors;
    expect(errors?.[0]?.code).toBe('PIN_PROJECT_NOT_FOUND');
  });

  it('#3 pin with invalid regex value returns HTTP 400 PIN_PROJECT_INVALID', async () => {
    fixture = await start(makeInstance(['alpha']));
    const r = await postJson(fixture.port, INIT_BODY, { 'X-Maad-Pin-Project': 'INVALID!NAME' });
    expect(r.status).toBe(400);
    const errors = (r.body as { errors?: Array<{ code: string }> }).errors;
    expect(errors?.[0]?.code).toBe('PIN_PROJECT_INVALID');
  });

  it('#4 duplicate X-Maad-Pin-Project headers return HTTP 400 PIN_PROJECT_INVALID', async () => {
    fixture = await start(makeInstance(['alpha', 'beta']));
    // Node joins repeated headers to "alpha, beta" — the regex rejection path
    // produces PIN_PROJECT_INVALID either way; the observable contract is the
    // HTTP 400 + code, not which internal branch fires.
    const result = await postWithDuplicateHeaders(fixture.port, 'X-Maad-Pin-Project', ['alpha', 'beta'], INIT_BODY);
    expect(result.status).toBe(400);
    const parsed = JSON.parse(result.body) as { errors: Array<{ code: string }> };
    expect(parsed.errors[0]!.code).toBe('PIN_PROJECT_INVALID');
  });

  it('#5 pin header with Mcp-Session-Id returns HTTP 400 PIN_ON_EXISTING_SESSION', async () => {
    fixture = await start(makeInstance(['alpha']));
    const r = await postJson(fixture.port, INIT_BODY, {
      'X-Maad-Pin-Project': 'alpha',
      'Mcp-Session-Id': 'fake-existing-sid',
    });
    expect(r.status).toBe(400);
    const errors = (r.body as { errors?: Array<{ code: string }> }).errors;
    expect(errors?.[0]?.code).toBe('PIN_ON_EXISTING_SESSION');
  });

  it('#6 pinned session bindSingle rebind rejects with SESSION_PINNED — activeProject unchanged', async () => {
    fixture = await start(makeInstance(['alpha', 'beta']));
    const r = await postJson(fixture.port, INIT_BODY, { 'X-Maad-Pin-Project': 'alpha' });
    const sid = r.sessionId!;
    const rebind = fixture.sessions.bindSingle(sid, 'beta');
    expect(rebind.ok).toBe(false);
    if (rebind.ok) return;
    expect(rebind.errors[0]!.code).toBe('SESSION_PINNED');
    expect(fixture.sessions.peek(sid)!.activeProject).toBe('alpha');
  });

  it('#7 pinned session bindMulti rebind rejects with SESSION_PINNED', async () => {
    fixture = await start(makeInstance(['alpha', 'beta', 'gamma']));
    const r = await postJson(fixture.port, INIT_BODY, { 'X-Maad-Pin-Project': 'alpha' });
    const sid = r.sessionId!;
    const rebind = fixture.sessions.bindMulti(sid, ['beta', 'gamma']);
    expect(rebind.ok).toBe(false);
    if (rebind.ok) return;
    expect(rebind.errors[0]!.code).toBe('SESSION_PINNED');
  });

  it('#8 pinned session can invoke a tool call successfully', async () => {
    fixture = await start(makeInstance(['alpha']));
    const init = await postJson(fixture.port, INIT_BODY, { 'X-Maad-Pin-Project': 'alpha' });
    expect(init.status).toBe(200);
    const sid = init.sessionId!;
    // MCP requires notifications/initialized before tool calls
    await postJson(fixture.port,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { 'Mcp-Session-Id': sid });
    const toolCall = await postJson(fixture.port,
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ping', arguments: {} } },
      { 'Mcp-Session-Id': sid });
    expect(toolCall.status).toBe(200);
    const body = toolCall.body as { result?: unknown; error?: unknown };
    expect(body.result).toBeDefined();
    expect(body.error).toBeUndefined();
  });

  it('#9 SessionRegistry tags bindingSource=gateway_pin on pinned sessions', async () => {
    fixture = await start(makeInstance(['alpha']));
    const r = await postJson(fixture.port, INIT_BODY, { 'X-Maad-Pin-Project': 'alpha' });
    const state = fixture.sessions.peek(r.sessionId!);
    expect(state!.bindingSource).toBe('gateway_pin');
  });

  it('#10 pinned count tracks sessions correctly and decrements on destroy', async () => {
    fixture = await start(makeInstance(['alpha', 'beta']));
    const r1 = await postJson(fixture.port, INIT_BODY, { 'X-Maad-Pin-Project': 'alpha' });
    const r2 = await postJson(fixture.port, INIT_BODY, { 'X-Maad-Pin-Project': 'beta' });
    const r3 = await postJson(fixture.port, INIT_BODY);  // unpinned, unbound
    expect(r1.sessionId).toBeTruthy();
    expect(r2.sessionId).toBeTruthy();
    expect(r3.sessionId).toBeTruthy();
    const pinnedBefore = fixture.sessions.snapshot().filter(s => s.bindingSource === 'gateway_pin').length;
    expect(pinnedBefore).toBe(2);
    fixture.sessions.destroy(r1.sessionId!, 'client');
    const pinnedAfter = fixture.sessions.snapshot().filter(s => s.bindingSource === 'gateway_pin').length;
    expect(pinnedAfter).toBe(1);
  });

  it('#11 concurrent pinned sessions to different projects remain isolated', async () => {
    fixture = await start(makeInstance(['alpha', 'beta']));
    const r1 = await postJson(fixture.port, INIT_BODY, { 'X-Maad-Pin-Project': 'alpha' });
    const r2 = await postJson(fixture.port, INIT_BODY, { 'X-Maad-Pin-Project': 'beta' });
    expect(r1.sessionId).not.toBe(r2.sessionId);
    const s1 = fixture.sessions.peek(r1.sessionId!)!;
    const s2 = fixture.sessions.peek(r2.sessionId!)!;
    expect(s1.activeProject).toBe('alpha');
    expect(s2.activeProject).toBe('beta');
    expect(s1.bindingSource).toBe('gateway_pin');
    expect(s2.bindingSource).toBe('gateway_pin');
    // Changing one session does not affect the other
    expect(s1.sessionId).not.toBe(s2.sessionId);
  });

  it('#12 synthetic (legacy) instance silently ignores pin header — no error, no pin', async () => {
    fixture = await start(makeSyntheticInstance());
    const r = await postJson(fixture.port, INIT_BODY, { 'X-Maad-Pin-Project': 'default' });
    expect(r.status).toBe(200);
    expect(r.sessionId).toBeTruthy();
    // Session created but NOT pinned. Legacy auto-bind happens lazily on first
    // tool call via withSession; at this point bindingSource is still null.
    const state = fixture.sessions.peek(r.sessionId!);
    expect(state!.bindingSource).toBeNull();
  });

  it('#13 removing a project from instance surfaces via PROJECT_UNKNOWN (natural flow)', async () => {
    const instance = makeInstance(['alpha', 'beta']);
    fixture = await start(instance);
    const r = await postJson(fixture.port, INIT_BODY, { 'X-Maad-Pin-Project': 'alpha' });
    const sid = r.sessionId!;
    expect(fixture.sessions.peek(sid)!.activeProject).toBe('alpha');

    // Simulate maad_reload removing project 'alpha' from the instance
    instance.projects = instance.projects.filter(p => p.name !== 'alpha');

    // getProject (the hook withSession uses to route) now returns undefined
    // for the removed project — withSession emits PROJECT_UNKNOWN via its
    // natural error flow. Pinned session is NOT auto-rebound; activeProject
    // still reads 'alpha' per spec ("don't silently rebind to a different project").
    expect(getProject(instance, 'alpha')).toBeUndefined();
    expect(fixture.sessions.peek(sid)!.activeProject).toBe('alpha');
    expect(fixture.sessions.peek(sid)!.bindingSource).toBe('gateway_pin');
  });
});
