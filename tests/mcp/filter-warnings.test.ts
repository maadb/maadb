// ============================================================================
// filterWarnings must reach MCP callers. maad_query rebuilds its result to strip
// filePath and hydrate depth, so a field missed there never leaves the server.
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EnginePool } from '../../src/instance/pool.js';
import { SessionRegistry } from '../../src/instance/session.js';
import type { InstanceCtx } from '../../src/mcp/ctx.js';
import { MaadEngine } from '../../src/engine.js';
import { register as registerRead } from '../../src/mcp/tools/read.js';
import { register as registerCleanup } from '../../src/mcp/tools/cleanup.js';
import { setGuardrailConfig } from '../../src/mcp/guardrails.js';
import { initRateLimiter } from '../../src/mcp/rate-limit.js';
import { docType } from '../../src/types.js';

const sid = 'filter-warnings-test';
const expected = [{ field: 'nope', reason: 'undeclared' }];
let root: string;
let engine: MaadEngine;
let client: Client;
let server: McpServer;

async function call(name: string, input: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: input });
  return JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'filter-warnings-mcp-'));
  mkdirSync(path.join(root, '_registry')); mkdirSync(path.join(root, '_schema'));
  writeFileSync(path.join(root, '_registry/object_types.yaml'), 'types:\n  note:\n    path: notes\n    id_prefix: nt\n    schema: note.v1\n');
  writeFileSync(path.join(root, '_schema/note.v1.yaml'), 'type: note\nversion: 1\nrequired: [title]\nfields:\n  title:\n    type: string\n    index: true\n  hours:\n    type: number\n    index: true\n  parent:\n    type: ref\n    target: note\n    index: true\n');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: root, windowsHide: true });
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'noreply');
  git('config', 'core.autocrlf', 'false'); git('add', '.'); git('commit', '-m', 'Fixture');
  const instance = { name: 'example', source: 'file' as const, projects: [{ name: 'one', path: root, role: 'admin' as const }] };
  const ctx: InstanceCtx = { instance, pool: new EnginePool(instance), sessions: new SessionRegistry(instance), tokens: null };
  ctx.sessions.create(sid); expect(ctx.sessions.bindSingle(sid, 'one').ok).toBe(true);
  engine = new MaadEngine(); expect((await engine.init(root, { semantic: false })).ok).toBe(true);
  expect((await engine.createDocument(docType('note'), { title: 'one', hours: 10 }, 'one')).ok).toBe(true);
  (ctx.pool as unknown as { engines: Map<string, MaadEngine> }).engines.set('one', engine);
  initRateLimiter({ disabled: true }); setGuardrailConfig({});
  server = new McpServer({ name: 'test', version: '1' });
  registerRead(server, ctx);
  registerCleanup(server, ctx);
  client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  serverTransport.sessionId = sid;
  await server.connect(serverTransport); await client.connect(clientTransport);
});

afterAll(async () => {
  initRateLimiter({}); setGuardrailConfig({});
  await client.close(); await server.close();
  engine.close();
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* Windows may hold handles briefly */ }
});

describe('filterWarnings over MCP', () => {
  it('maad_query returns them with filePath stripped', async () => {
    const body = await call('maad_query', { docType: 'note', filters: { nope: 'x' } });
    expect(body.ok, JSON.stringify(body)).toBe(true);
    expect(body.data.filterWarnings).toEqual(expected);
  });

  it('maad_query returns them with filePath kept', async () => {
    const body = await call('maad_query', { docType: 'note', filters: { nope: 'x' }, includeFilePath: true });
    expect(body.data.filterWarnings).toEqual(expected);
  });

  it('maad_query returns them after depth hydration', async () => {
    // A warning on one filter must survive even when other filters still match rows.
    const body = await call('maad_query', { docType: 'note', filters: { hours: { op: 'neq', value: 'abc' } }, depth: 'cold' });
    expect(body.data.results).toHaveLength(1);
    expect(body.data.filterWarnings).toEqual([{ field: 'hours', reason: 'not_numeric' }]);
  });

  it('maad_aggregate, maad_join and maad_verify return them', async () => {
    const aggregated = await call('maad_aggregate', { docType: 'note', groupBy: 'title', filters: { nope: 'x' } });
    expect(aggregated.data.filterWarnings).toEqual(expected);
    const joined = await call('maad_join', { docType: 'note', refs: ['parent'], filters: { nope: 'x' } });
    expect(joined.data.filterWarnings).toEqual(expected);
    const counted = await call('maad_verify', { mode: 'count', docType: 'note', expectedCount: 0, filters: { nope: 'x' } });
    expect(counted.data.filterWarnings).toEqual(expected);
  });

  it('the delete and repair previews show them before anything changes', async () => {
    const filters = { hours: { op: 'neq', value: 'abc' } };
    const warned = [{ field: 'hours', reason: 'not_numeric' }];
    const deleting = await call('maad_delete_where', { docType: 'note', filters });
    expect(deleting.data?.totalAffected, JSON.stringify(deleting)).toBe(1);
    expect(deleting.data.filterWarnings).toEqual(warned);
    const repairing = await call('maad_repair_where', { docType: 'note', filters, repairTypes: ['prune_orphan_refs'] });
    expect(repairing.data.filterWarnings).toEqual(warned);
    const clean = await call('maad_delete_where', { docType: 'note', filters: { hours: 10 } });
    expect(clean.data.filterWarnings).toBeUndefined();
  });

  it('maad_query compares a numeric string by the field type', async () => {
    const body = await call('maad_query', { docType: 'note', filters: { hours: { op: 'gte', value: '9' } } });
    expect(body.data.total).toBe(1);
    expect(body.data.filterWarnings).toBeUndefined();
  });
});
