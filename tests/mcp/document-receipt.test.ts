import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EnginePool } from '../../src/instance/pool.js';
import { SessionRegistry } from '../../src/instance/session.js';
import { MaadEngine } from '../../src/engine/index.js';
import type { InstanceCtx } from '../../src/mcp/ctx.js';
import { withEngine } from '../../src/mcp/with-session.js';
import { successResponse } from '../../src/mcp/response.js';
import { documentReceiptInput, register } from '../../src/mcp/tools/document-receipt.js';
import { getMinRoleForTool } from '../../src/mcp/roles.js';
import { getKindForTool } from '../../src/mcp/kinds.js';
import type { TokenRecord } from '../../src/auth/types.js';
import type { TokenStore } from '../../src/auth/token-store.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

let root: string;
let ctx: InstanceCtx;
let engine: MaadEngine;
const args = { contract: 'document-persistence-v1', docType: 'note', docId: 'n-1' };
const extra = { sessionId: 'receipt-test' };
const parse = (response: { content: Array<{ text: string }> }) => JSON.parse(response.content[0]!.text);
const call = (handler: Parameters<typeof withEngine>[4] = () => successResponse({ secret: 'content' }), overrides = {}) =>
  withEngine(ctx, extra, 'maad_document_receipt', { ...args, ...overrides }, handler).then(parse);
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'receipt-mcp-'));
  const instance = { name: 'example', source: 'file' as const, projects: [{ name: 'one', path: root, role: 'reader' as const }] };
  ctx = { instance, pool: new EnginePool(instance), sessions: new SessionRegistry(instance), tokens: null };
  ctx.sessions.create(extra.sessionId);
  expect(ctx.sessions.bindSingle(extra.sessionId, 'one').ok).toBe(true);
  engine = new MaadEngine();
  vi.spyOn(engine, 'isReceiptReady').mockReturnValue(true);
  vi.spyOn(engine, 'close').mockResolvedValue();
  (ctx.pool as unknown as { engines: Map<string, MaadEngine> }).engines.set('one', engine);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  const relative = path.relative(tmpdir(), root);
  expect(relative && !relative.startsWith('..') && !path.isAbsolute(relative)).toBeTruthy();
  rmSync(root, { recursive: true, force: true });
});

describe('receipt MCP admission and lifetime', () => {
  it('registers a strict reader tool with no repair path', async () => {
    const server = new McpServer({ name: 'test', version: '1' });
    expect(register(server, ctx)).toBe(1);
    expect(getMinRoleForTool('maad_document_receipt')).toBe('reader');
    expect(getKindForTool('maad_document_receipt')).toBe('read');
    expect(documentReceiptInput.safeParse({ ...args, path: 'forbidden' }).success).toBe(false);
    expect(documentReceiptInput.safeParse({ ...args, expectedContentDigest: 'A'.repeat(64) }).success).toBe(false);
    const load = vi.spyOn(ctx.pool, 'get');
    expect((await call()).ok).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(ctx.pool.refcountFor('one')).toBe(0);
  });
  it('rejects a different explicit project, missing roles, and unloaded engines', async () => {
    expect((await call(undefined, { project: 'two' })).errors[0].code).toBe('PROJECT_NOT_WHITELISTED');
    ctx.sessions.peek(extra.sessionId)!.effectiveRoles.clear();
    expect((await call()).errors[0].code).toBe('PROJECT_NOT_WHITELISTED');
    ctx.sessions.peek(extra.sessionId)!.effectiveRoles.set('one', 'reader');
    (ctx.pool as unknown as { engines: Map<string, MaadEngine> }).engines.clear();
    expect((await call()).errors[0].code).toBe('RECEIPT_ENGINE_NOT_READY');
  });
  it('requires binding even in synthetic mode and does not create a session', async () => {
    ctx.instance.source = 'synthetic';
    ctx.sessions.destroy(extra.sessionId);
    expect((await call()).errors[0].code).toBe('SESSION_UNBOUND');
    expect(ctx.sessions.peek(extra.sessionId)).toBeUndefined();
  });
  it('uses the existing multi-project whitelist without binding new projects', async () => {
    const state = ctx.sessions.peek(extra.sessionId)!;
    state.mode = 'multi'; state.whitelist = ['one']; delete state.activeProject;
    expect((await call()).errors[0].code).toBe('PROJECT_REQUIRED');
    expect((await call(undefined, { project: 'other' })).errors[0].code).toBe('PROJECT_NOT_WHITELISTED');
    expect((await call(undefined, { project: 'one' })).ok).toBe(true);
  });
  it('rejects session or project-access loss after awaited reads without content', async () => {
    const result = await call(async () => {
      await Promise.resolve();
      ctx.sessions.peek(extra.sessionId)!.effectiveRoles.clear();
      return successResponse({ secret: 'content' });
    });
    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
  });
  it.each(['revoked', 'removed', 'expired', 'forbidden'] as const)('checks current token %s after reads', async action => {
    const token = { id: 'tok-test', hash: 'hash-test', role: 'reader', projects: [{ name: 'one' }], createdAt: '2026-01-01T00:00:00Z' } as TokenRecord;
    ctx.sessions.peek(extra.sessionId)!.token = token;
    let current: TokenRecord | undefined = token;
    ctx.tokens = { lookupByHash: () => current } as unknown as TokenStore;
    const result = await call(async () => {
      await Promise.resolve();
      if (action === 'removed') current = undefined;
      if (action === 'revoked') current = { ...token, revokedAt: new Date().toISOString() };
      if (action === 'expired') current = { ...token, expiresAt: '2000-01-01T00:00:00Z' };
      if (action === 'forbidden') current = { ...token, projects: [] };
      return successResponse({ secret: 'content' });
    });
    expect(result.ok).toBe(false);
    expect(result.data).toBeUndefined();
  });
  it('keeps reference alive after timeout until handler termination and fences eviction', async () => {
    vi.stubEnv('MAAD_REQUEST_TIMEOUT_MS', '15');
    let finish!: () => void;
    const gate = new Promise<void>(r => { finish = r; });
    let signal: AbortSignal | undefined;
    const pending = call(async context => { signal = context.signal; await gate; return successResponse({ secret: 'content' }); });
    const timedOut = await pending;
    expect(timedOut.errors[0].code).toBe('REQUEST_TIMEOUT');
    expect(signal?.aborted).toBe(true);
    expect(ctx.pool.refcountFor('one')).toBe(1);
    const evicted = ctx.pool.evict('one');
    expect(engine.close).not.toHaveBeenCalled();
    finish(); await evicted;
    expect(engine.close).toHaveBeenCalledTimes(1);
    expect(ctx.pool.refcountFor('one')).toBe(0);
  });
  it('rejects content if reload starts while observation is awaiting', async () => {
    const result = await call(async () => {
      await Promise.resolve(); ctx.pool.tryBeginReload();
      return successResponse({ secret: 'content' });
    });
    expect(result.errors[0].code).toBe('RECEIPT_ENGINE_NOT_READY');
    expect(result.data).toBeUndefined();
  });
  it('applies cancellation and the smaller configured complete-envelope cap', async () => {
    const controller = new AbortController(); controller.abort();
    const cancelled = await withEngine(ctx, { ...extra, signal: controller.signal }, 'maad_document_receipt', args,
      () => successResponse({ secret: 'content' }));
    expect(parse(cancelled).errors[0].code).toBe('REQUEST_TIMEOUT');
    vi.stubEnv('MAAD_CONTRACT_RESPONSE_MAX_BYTES', '100');
    const large = await call(() => successResponse({ text: 'x'.repeat(200) }));
    expect(large.errors[0].code).toBe('RESPONSE_TOO_LARGE');
    vi.stubEnv('MAAD_CONTRACT_RESPONSE_MAX_BYTES', '2000000');
    const capped = await call(() => successResponse({ text: 'x'.repeat(1024 * 1024) }));
    expect(capped.errors[0].code).toBe('RESPONSE_TOO_LARGE');
  });
});
