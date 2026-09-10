import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EnginePool } from '../../src/instance/pool.js';
import { SessionRegistry } from '../../src/instance/session.js';
import type { InstanceCtx } from '../../src/mcp/ctx.js';
import type { TokenRecord } from '../../src/auth/types.js';
import type { TokenStore } from '../../src/auth/token-store.js';
import { MaadEngine } from '../../src/engine.js';
import { guardedCreateInput, createContractInput, registerContract, registerWrite } from '../../src/mcp/tools/guarded-create.js';
import { register as registerReceipt } from '../../src/mcp/tools/document-receipt.js';
import { setGuardrailConfig } from '../../src/mcp/guardrails.js';
import { initRateLimiter, getRateLimiter } from '../../src/mcp/rate-limit.js';
import { docId } from '../../src/types.js';
import * as evidence from '../../src/engine/document-receipt.js';
import * as notifications from '../../src/mcp/notifications.js';
import * as logging from '../../src/logging.js';
vi.mock('../../src/engine/document-receipt.js', async original => ({ ...await original<typeof import('../../src/engine/document-receipt.js')>() }));
vi.mock('../../src/mcp/notifications.js', async original => ({ ...await original<typeof import('../../src/mcp/notifications.js')>() }));
vi.mock('../../src/logging.js', async original => ({ ...await original<typeof import('../../src/logging.js')>() }));

let root: string;
let ctx: InstanceCtx;
let engine: MaadEngine;
let client: Client;
let server: McpServer;
let args: Record<string, unknown>;
const sid = 'guarded-test';
const contractArgs = { contract: 'create-contract-v1', docType: 'note' };
const target = () => path.join(root, 'notes/nt-one.md');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const snapshot = () => {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, e.name);
      if (e.isDirectory()) { files[path.relative(root, file) + '/'] = ''; walk(file); }
      else files[path.relative(root, file)] = hash(readFileSync(file).toString('base64'));
    }
  };
  walk(root); return files;
};
async function call(name = 'maad_create_guarded', input = args) {
  const response = await client.callTool({ name, arguments: input });
  const first = (response.content as Array<{ text: string }>)[0]!.text;
  try { return JSON.parse(first); } catch { return { schemaError: first, isError: response.isError }; }
}
async function hold() {
  let release!: () => void; let entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; });
  const pending = engine.runGuardedExclusive(async () => { entered(); await new Promise<void>(r => { release = r; }); });
  await ready; return async () => { release(); await pending; };
}
beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'guarded-mcp-'));
  mkdirSync(path.join(root, '_registry')); mkdirSync(path.join(root, '_schema'));
  writeFileSync(path.join(root, '_registry/object_types.yaml'), 'types:\n  note:\n    path: notes\n    id_prefix: nt\n    schema: note.v1\n');
  writeFileSync(path.join(root, '_schema/note.v1.yaml'), 'type: note\nversion: 1\nrequired: [title]\nfields:\n  title:\n    type: string\n');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: root, windowsHide: true });
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'noreply');
  git('config', 'core.autocrlf', 'false'); git('add', '.'); git('commit', '-m', 'Fixture');
  const instance = { name: 'example', source: 'file' as const, projects: [{ name: 'one', path: root, role: 'writer' as const }] };
  ctx = { instance, pool: new EnginePool(instance), sessions: new SessionRegistry(instance), tokens: null };
  ctx.sessions.create(sid); expect(ctx.sessions.bindSingle(sid, 'one').ok).toBe(true);
  engine = new MaadEngine(); expect((await engine.init(root, { semantic: false })).ok).toBe(true);
  await engine.getDocument(docId('nt-missing'), 'hot');
  (ctx.pool as unknown as { engines: Map<string, MaadEngine> }).engines.set('one', engine);
  initRateLimiter({ disabled: true }); setGuardrailConfig({});
  server = new McpServer({ name: 'test', version: '1' });
  registerContract(server, ctx); registerWrite(server, ctx); registerReceipt(server, ctx);
  client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serverTransport.sessionId = sid;
  await server.connect(serverTransport); await client.connect(clientTransport);
  const contract = await call('maad_create_contract', contractArgs);
  expect(contract.ok, JSON.stringify(contract)).toBe(true);
  // Independent fixed-order document-content-v1 projection, including identity.
  const digest = hash('{"docId":"nt-one","docType":"note","frontmatter":{"doc_id":"nt-one","doc_type":"note","schema":"note.v1","title":"Hello"},"body":""}');
  args = { contract: 'guarded-create-v1', docType: 'note', docId: 'nt-one', fields: { title: 'Hello' }, body: '',
    expectedSchemaDigest: contract.data.schemaDigest, expectedContentDigest: digest, allowedHistoryModes: ['audit'] };
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); setGuardrailConfig({}); initRateLimiter({});
  await client?.close(); await server?.close(); await ctx?.pool.closeAll(); await engine?.close();
  const relative = path.relative(tmpdir(), root);
  expect(relative && !relative.startsWith('..') && !path.isAbsolute(relative)).toBeTruthy();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('guarded MCP schemas, handlers and live admission', () => {
  it('creates through real protocol schema and handler, emits audit and notifications, then returns an exact receipt', async () => {
    const notify = vi.spyOn(notifications, 'notifyWrite'); const audit = vi.spyOn(logging, 'logWriteAudit');
    const get = vi.spyOn(ctx.pool, 'get'); const legacy = vi.spyOn(engine, 'runExclusive');
    const result = await call(); expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.data.contentDigest).toBe(args.expectedContentDigest);
    expect(notify).toHaveBeenCalledTimes(1); expect(audit).toHaveBeenCalledTimes(1);
    expect(get).not.toHaveBeenCalled(); expect(legacy).not.toHaveBeenCalled();
    vi.stubEnv('MAAD_REQUEST_TIMEOUT_MS', '30000');
    const receipt = await call('maad_document_receipt', { contract: 'document-persistence-v1', docType: 'note', docId: 'nt-one', expectedContentDigest: args.expectedContentDigest });
    expect(receipt.data.expectedDigestMatch).toBe(true); expect(ctx.pool.refcountFor('one')).toBe(0);
  });
  it('rejects unknown, absent, invalid and unsupported guard inputs at the real tool boundary', async () => {
    const before = snapshot();
    const invalid = [ { ...args, path: 'elsewhere' }, { ...args, authority: 'writer' }, { ...args, contract: 'guarded-create-v2' },
      { ...args, expectedSchemaDigest: 'A'.repeat(64) }, { ...args, expectedContentDigest: 'bad' },
      { ...args, docId: '../nt-one' }, { ...args, fields: 'json' }, { ...args, fields: null },
      { ...args, allowedHistoryModes: [] }, { ...args, allowedHistoryModes: ['audit', 'audit'] }, { ...args, allowedHistoryModes: ['invalid'] } ];
    for (const key of Object.keys(args)) { const missing = { ...args }; delete missing[key]; invalid.push(missing); }
    for (const input of invalid) {
      expect(guardedCreateInput.safeParse(input).success).toBe(false);
      const result = await call('maad_create_guarded', input); expect(result.isError).toBe(true);
    }
    expect(createContractInput.safeParse({ ...contractArgs, extra: true }).success).toBe(false);
    expect((await call('maad_create_contract', { ...contractArgs, contract: 'unknown' })).isError).toBe(true);
    expect(snapshot()).toEqual(before);
  });
  it.each(['reader', 'unbound', 'unready', 'differentProject'] as const)('rejects %s without initialization', async kind => {
    const before = snapshot(); const get = vi.spyOn(ctx.pool, 'get');
    if (kind === 'reader') ctx.sessions.peek(sid)!.effectiveRoles.set('one', 'reader');
    if (kind === 'unbound') ctx.sessions.destroy(sid);
    if (kind === 'unready') vi.spyOn(engine, 'isReceiptReady').mockReturnValue(false);
    const result = await call('maad_create_guarded', kind === 'differentProject' ? { ...args, project: 'two' } : args);
    expect(result.ok).toBe(false); expect(get).not.toHaveBeenCalled(); expect(snapshot()).toEqual(before);
  });
  it.each(['revoked', 'expired', 'removed', 'downgraded', 'projectRemoved', 'bindingChanged', 'reload', 'engineChanged', 'pathChanged'] as const)('rechecks %s while queued', async kind => {
    const token = { id: 'tok-test', hash: 'test-hash', role: 'writer', projects: [{ name: 'one' }], createdAt: '2026-01-01T00:00:00Z' } as TokenRecord;
    ctx.sessions.peek(sid)!.token = token;
    let current: TokenRecord | undefined = token;
    ctx.tokens = { lookupByHash: () => current } as unknown as TokenStore;
    const release = await hold(); const before = snapshot(); const pending = call();
    await vi.waitFor(() => expect(ctx.pool.refcountFor('one')).toBe(1));
    if (kind === 'revoked') current = { ...token, revokedAt: new Date().toISOString() };
    if (kind === 'expired') current = { ...token, expiresAt: '2000-01-01T00:00:00Z' };
    if (kind === 'removed') current = undefined;
    if (kind === 'downgraded') current = { ...token, role: 'reader' };
    if (kind === 'projectRemoved') ctx.instance.projects.splice(0);
    if (kind === 'bindingChanged') ctx.sessions.peek(sid)!.activeProject = 'two';
    if (kind === 'reload') ctx.pool.tryBeginReload();
    if (kind === 'engineChanged') (ctx.pool as unknown as { engines: Map<string, MaadEngine> }).engines.set('one', new MaadEngine());
    if (kind === 'pathChanged') ctx.instance.projects[0]!.path = path.join(root, 'other');
    await release(); const result = await pending;
    expect(result.ok, kind).toBe(false); expect(snapshot()).toEqual(before); expect(ctx.pool.refcountFor('one')).toBe(0);
  });
  it('rechecks live token after an awaited schema read', async () => {
    const token = { id: 'tok-test', hash: 'test-hash', role: 'writer', projects: [{ name: 'one' }], createdAt: '2026-01-01T00:00:00Z' } as TokenRecord;
    ctx.sessions.peek(sid)!.token = token; ctx.tokens = { lookupByHash: () => token } as unknown as TokenStore;
    const original = evidence.readWorkingReceipt;
    vi.spyOn(evidence, 'readWorkingReceipt').mockImplementation(async (...params) => {
      const bytes = await original(...params); token.revokedAt = new Date().toISOString(); return bytes;
    });
    const before = snapshot(); const result = await call();
    expect(result.errors[0].code).toBe('TOKEN_REVOKED'); expect(snapshot()).toEqual(before);
  });
  it('keeps timed-out queued references until settlement and prevents later publication during eviction', async () => {
    vi.stubEnv('MAAD_REQUEST_TIMEOUT_MS', '20'); initRateLimiter({});
    const release = await hold(); const before = snapshot(); const pending = call();
    const result = await pending; expect(result.errors[0].code).toBe('REQUEST_TIMEOUT');
    expect(ctx.pool.refcountFor('one')).toBe(1); expect(getRateLimiter().inFlightFor(sid)).toBe(1);
    const close = vi.spyOn(engine, 'close'); const eviction = ctx.pool.evict('one'); expect(close).not.toHaveBeenCalled();
    await release();
    // Settlement releases the reference; eviction closes SQLite only afterward.
    await eviction; expect(close).toHaveBeenCalledTimes(1); expect(ctx.pool.refcountFor('one')).toBe(0);
    expect(readdirSync(path.join(root, 'notes'))).toEqual([]);
    expect(before['notes/']).toBe(''); expect(getRateLimiter().inFlightFor(sid)).toBe(0);
  });
  it('supports dry-run and write rate limits without effects', async () => {
    const before = snapshot(); setGuardrailConfig({ dryRun: true });
    expect((await call()).ok).toBe(true); expect(snapshot()).toEqual(before);
    setGuardrailConfig({}); initRateLimiter({ writesPerSec: 0 });
    expect((await call()).errors[0].code).toBe('RATE_LIMITED'); expect(snapshot()).toEqual(before);
  });
  it('caps complete contract responses without truncation', async () => {
    const before = snapshot(); vi.stubEnv('MAAD_RESPONSE_MAX_BYTES', '100');
    const result = await call('maad_create_contract', contractArgs);
    expect(result.errors[0].code).toBe('RESPONSE_TOO_LARGE'); expect(snapshot()).toEqual(before);
  });
  it('reconciles lost acknowledgement after publication by receipt without replay', async () => {
    vi.stubEnv('MAAD_REQUEST_TIMEOUT_MS', '2000');
    let finish!: () => void; const gate = new Promise<void>(r => { finish = r; });
    vi.spyOn(notifications, 'notifyWrite').mockImplementation(async () => { await gate; });
    const create = vi.spyOn(engine, 'createGuarded');
    const result = await call(); expect(result.errors[0].code).toBe('REQUEST_TIMEOUT');
    expect(readFileSync(target(), 'utf8')).toContain('title: Hello'); expect(ctx.pool.refcountFor('one')).toBe(1);
    finish(); await vi.waitFor(() => expect(ctx.pool.refcountFor('one')).toBe(0));
    vi.stubEnv('MAAD_REQUEST_TIMEOUT_MS', '30000');
    const receipt = await call('maad_document_receipt', { contract: 'document-persistence-v1', docType: 'note', docId: 'nt-one', expectedContentDigest: args.expectedContentDigest });
    expect(receipt.data.expectedDigestMatch).toBe(true); expect(create).toHaveBeenCalledTimes(1);
  });
});
