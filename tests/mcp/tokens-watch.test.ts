// ============================================================================
// tokens.yaml change detection — out-of-process revocations take effect
// without a restart or SIGHUP (the Windows path).
//
//   - TokenStore.reloadIfChanged: detects external edits, ignores its own
//     writes, keeps prior state on an invalid file, retries on the next edit.
//   - startTokensWatch over HTTP: a revocation written by another process
//     cuts off the bound session and the bearer with no reload call.
// ============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRequire } from 'node:module';
import { writeFile, readFile } from 'node:fs/promises';
import { startHttpTransport, type HttpTransportHandle } from '../../src/mcp/transport/http.js';
import { SessionRegistry, type SessionCloseReason } from '../../src/instance/session.js';
import type { InstanceConfig } from '../../src/instance/config.js';
import { EnginePool } from '../../src/instance/pool.js';
import type { InstanceCtx } from '../../src/mcp/ctx.js';
import { TokenStore } from '../../src/auth/token-store.js';
import { startTokensWatch } from '../../src/mcp/tokens-watch.js';
import { makeTokenFixture, type TokenFixture } from '../support/token-fixture.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };

async function writerFor(fixture: TokenFixture): Promise<TokenStore> {
  const loaded = await TokenStore.load(fixture.tmpRoot);
  if (!loaded.ok) throw new Error('writer load failed');
  return loaded.value;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}

describe('TokenStore.reloadIfChanged', () => {
  let fixture: TokenFixture | null = null;
  afterEach(async () => { if (fixture) { await fixture.cleanup(); fixture = null; } });

  it('reports no change when tokens.yaml is untouched', async () => {
    fixture = await makeTokenFixture();
    expect(await fixture.store.reloadIfChanged()).toEqual({ changed: false });
  });

  it('picks up a revocation written by another process, then settles', async () => {
    fixture = await makeTokenFixture();
    const revoked = await (await writerFor(fixture)).revoke(fixture.record.id);
    expect(revoked.ok).toBe(true);
    expect(fixture.store.lookupById(fixture.record.id)?.revokedAt).toBeUndefined();

    const check = await fixture.store.reloadIfChanged();
    expect(check.changed).toBe(true);
    if (!check.changed) return;
    expect(check.result.ok).toBe(true);
    expect(fixture.store.lookupById(fixture.record.id)?.revokedAt).toBeDefined();

    expect(await fixture.store.reloadIfChanged()).toEqual({ changed: false });
  });

  it("does not treat the store's own writes as external changes", async () => {
    fixture = await makeTokenFixture();
    const issued = await fixture.store.issue({ role: 'reader', projects: [{ name: '*' }] });
    expect(issued.ok).toBe(true);
    expect(await fixture.store.reloadIfChanged()).toEqual({ changed: false });
  });

  it('keeps the previous registry on an invalid file and retries after the next edit', async () => {
    fixture = await makeTokenFixture();
    const good = await readFile(fixture.store.path(), 'utf8');
    await writeFile(fixture.store.path(), 'tokens: [invalid', 'utf8');

    const bad = await fixture.store.reloadIfChanged();
    expect(bad.changed).toBe(true);
    if (!bad.changed) return;
    expect(bad.result.ok).toBe(false);
    expect(fixture.store.lookupById(fixture.record.id)).toBeDefined();
    // Reported once, not on every check.
    expect(await fixture.store.reloadIfChanged()).toEqual({ changed: false });

    await writeFile(fixture.store.path(), `${good}\n`, 'utf8');
    const fixed = await fixture.store.reloadIfChanged();
    expect(fixed.changed).toBe(true);
    if (!fixed.changed) return;
    expect(fixed.result.ok).toBe(true);
  });
});

describe('startTokensWatch', () => {
  let fixture: TokenFixture | null = null;
  let handle: HttpTransportHandle | null = null;
  let stop: (() => void) | null = null;

  afterEach(async () => {
    stop?.(); stop = null;
    if (handle) { await handle.close(); handle = null; }
    if (fixture) { await fixture.cleanup(); fixture = null; }
  });

  it('is a no-op when disabled with 0', async () => {
    fixture = await makeTokenFixture();
    const instance: InstanceConfig = { name: 'test', source: 'file', projects: [] };
    const ctx: InstanceCtx = {
      instance, pool: new EnginePool(instance), sessions: new SessionRegistry(instance), tokens: fixture.store,
    };
    let changed = 0;
    ctx.onTokensChanged = () => { changed++; };
    stop = startTokensWatch(ctx, 0);
    await (await writerFor(fixture)).revoke(fixture.record.id);
    await new Promise(r => setTimeout(r, 150));
    expect(changed).toBe(0);
    expect(fixture.store.lookupById(fixture.record.id)?.revokedAt).toBeUndefined();
  });

  it('cuts off a session whose token is revoked out of process, with no reload call', async () => {
    fixture = await makeTokenFixture();
    const instance: InstanceConfig = { name: 'test', source: 'file', projects: [] };
    const sessions = new SessionRegistry(instance);
    const closeEvents: Array<{ sid: string; reason: SessionCloseReason }> = [];
    sessions.registerCloseHandler((sid, reason) => { closeEvents.push({ sid, reason }); });
    handle = await startHttpTransport({
      host: '127.0.0.1', port: 0, maxBodyBytes: 4096,
      headersTimeoutMs: 10_000, requestTimeoutMs: 60_000, keepAliveTimeoutMs: 5_000,
      trustProxy: false, idleMs: 1_800_000,
      sessions, instance, tokens: fixture.store,
      serverFactory: () => new McpServer({ name: 'maad-watch-test', version: pkg.version }),
    });
    const addr = handle.httpServer.address();
    if (typeof addr !== 'object' || addr === null) throw new Error('no address');
    const url = `http://127.0.0.1:${addr.port}/mcp`;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': `Bearer ${fixture.plaintext}`,
    };

    const ctx: InstanceCtx = { instance, pool: new EnginePool(instance), sessions, tokens: fixture.store };
    const h = handle;
    ctx.onTokensChanged = (exclude?: string) => { h.evictInvalidTokenSessions(exclude); };
    stop = startTokensWatch(ctx, 25);

    const init = await fetch(url, {
      method: 'POST', headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'watch-test', version: '0.1' } },
      }),
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get('mcp-session-id');
    await init.text();
    expect(sid).toBeTruthy();
    expect(handle.activeSessionCount()).toBe(1);

    // Another process revokes the token (e.g. `maad auth revoke-token`).
    await (await writerFor(fixture)).revoke(fixture.record.id);

    await waitFor(() => handle!.activeSessionCount() === 0);
    expect(closeEvents).toContainEqual({ sid, reason: 'auth' });

    const after = await fetch(url, {
      method: 'POST', headers: { ...headers, 'mcp-session-id': sid! },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(after.status).toBe(401);
    await after.text();
  });
});
