import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { MaadEngine } from '../../src/engine.js';
import { docId, docType } from '../../src/types.js';
import { atomicCreate } from '../../src/engine/journal.js';
import { EnginePool } from '../../src/instance/pool.js';
import { SessionRegistry } from '../../src/instance/session.js';
import { synthesizeLegacyInstance } from '../../src/instance/config.js';
import type { InstanceCtx } from '../../src/mcp/ctx.js';
import * as writeTools from '../../src/mcp/tools/write.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/simple-crm');

let root: string;
let engine: MaadEngine;
const extraDirs: string[] = [];

function clientPath(id: string): string {
  return path.join(root, 'clients', `${id}.md`);
}

function parseResponse(response: { content: Array<{ type: string; text: string }> }): {
  ok: boolean;
  errors?: Array<{ code: string; message: string }>;
} {
  return JSON.parse(response.content[0]!.text) as {
    ok: boolean;
    errors?: Array<{ code: string; message: string }>;
  };
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'maad-write-boundary-'));
  cpSync(FIXTURE, root, { recursive: true });
  const backend = path.join(root, '_backend');
  if (existsSync(backend)) rmSync(backend, { recursive: true, force: true });

  engine = new MaadEngine();
  const initialized = await engine.init(root);
  expect(initialized.ok).toBe(true);
  await engine.indexAll({ force: true });
});

afterEach(async () => {
  engine.close();
  await new Promise(resolve => setTimeout(resolve, 25));
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows handles */ }
  while (extraDirs.length > 0) {
    const dir = extraDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows handles */ }
  }
});

describe('caller-owned fields cannot mutate record identity', () => {
  it.each(['doc_id', 'doc_type', 'schema'])('rejects reserved field %s on direct create', async field => {
    const result = await engine.createDocument(
      docType('client'),
      { name: 'Identity Test', status: 'active', [field]: 'caller-value' },
      undefined,
      `cli-reserved-${field.replace('_', '-')}`,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('FRONTMATTER_GUARD');
  });

  it.each(['doc_id', 'doc_type', 'schema'])('rejects reserved field %s on direct update without touching the file', async field => {
    const file = clientPath('cli-acme');
    const before = readFileSync(file, 'utf-8');

    const result = await engine.updateDocument(docId('cli-acme'), { [field]: 'caller-value' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('FRONTMATTER_GUARD');
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });

  it('rejects reserved fields per record in bulk create and bulk update', async () => {
    const created = await engine.bulkCreate([
      { docType: 'client', docId: 'cli-bulk-safe', fields: { name: 'Safe', status: 'active' } },
      { docType: 'client', docId: 'cli-bulk-id', fields: { name: 'Bad ID', status: 'active', doc_id: 'other' } },
      { docType: 'client', docId: 'cli-bulk-type', fields: { name: 'Bad Type', status: 'active', doc_type: 'case' } },
      { docType: 'client', docId: 'cli-bulk-schema', fields: { name: 'Bad Schema', status: 'active', schema: 'case.v1' } },
    ]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.succeeded.map(entry => entry.docId)).toEqual(['cli-bulk-safe']);
    expect(created.value.failed).toHaveLength(3);
    for (const failure of created.value.failed) expect(failure.error).toContain('FRONTMATTER_GUARD');

    const before = readFileSync(clientPath('cli-acme'), 'utf-8');
    const updated = await engine.bulkUpdate([
      { docId: 'cli-acme', fields: { schema: 'client.v99' } },
    ]);
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.succeeded).toHaveLength(0);
    expect(updated.value.failed[0]!.error).toContain('engine-owned');
    expect(readFileSync(clientPath('cli-acme'), 'utf-8')).toBe(before);
  });

  it('refuses to update or repair a record whose stored identity no longer matches its index row', async () => {
    const file = clientPath('cli-acme');
    const poisoned = readFileSync(file, 'utf-8').replace('doc_id: cli-acme', 'doc_id: cli-other');
    writeFileSync(file, poisoned, 'utf-8');

    const update = await engine.updateDocument(docId('cli-acme'), { status: 'inactive' });
    expect(update.ok).toBe(false);
    if (!update.ok) expect(update.errors[0]!.code).toBe('FRONTMATTER_GUARD');
    const deletion = await engine.deleteDocument(docId('cli-acme'), 'hard');
    expect(deletion.ok).toBe(false);
    if (!deletion.ok) expect(deletion.errors[0]!.code).toBe('FRONTMATTER_GUARD');

    const repair = await engine.repairWhere(undefined, docType('client'), ['fix_schema_drift'], 10);
    expect(repair.ok).toBe(true);
    if (!repair.ok) return;
    expect(repair.value.succeeded).toHaveLength(0);
    expect(repair.value.failed[0]!.code).toBe('REPAIR_REQUIRES_MIGRATION');
    expect(readFileSync(file, 'utf-8')).toBe(poisoned);
  });
});

describe('create publication is exclusive', () => {
  it('does not overwrite an existing Markdown file that is absent from SQLite', async () => {
    const directFile = clientPath('cli-unindexed-direct');
    const bulkFile = clientPath('cli-unindexed-bulk');
    writeFileSync(directFile, 'external direct content\n', 'utf-8');
    writeFileSync(bulkFile, 'external bulk content\n', 'utf-8');

    const direct = await engine.createDocument(
      docType('client'),
      { name: 'Direct Collision', status: 'active' },
      undefined,
      'cli-unindexed-direct',
    );
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.errors[0]!.code).toBe('DUPLICATE_DOC_ID');
    expect(readFileSync(directFile, 'utf-8')).toBe('external direct content\n');

    const bulk = await engine.bulkCreate([
      { docType: 'client', docId: 'cli-unindexed-bulk', fields: { name: 'Bulk Collision', status: 'active' } },
    ]);
    expect(bulk.ok).toBe(true);
    if (!bulk.ok) return;
    expect(bulk.value.succeeded).toHaveLength(0);
    expect(bulk.value.failed[0]!.error).toContain('DUPLICATE_DOC_ID');
    expect(readFileSync(bulkFile, 'utf-8')).toBe('external bulk content\n');
  });

  it('allows exactly one publisher when two exclusive creates race', async () => {
    const target = path.join(root, 'race.md');
    const settled = await Promise.allSettled([
      atomicCreate(target, 'first'),
      atomicCreate(target, 'second'),
    ]);

    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(['first', 'second']).toContain(readFileSync(target, 'utf-8'));
  });

  it('falls back to an exclusive direct write when hard links are unsupported', async () => {
    const fs = await import('node:fs/promises');
    const target = path.join(root, 'fallback.md');
    const unsupported = Object.assign(new Error('links unsupported'), { code: 'ENOTSUP' });

    await atomicCreate(target, 'fallback content', {
      writeFile: fs.writeFile,
      unlink: fs.unlink,
      link: async () => { throw unsupported; },
    });

    expect(readFileSync(target, 'utf-8')).toBe('fallback content');
    await expect(atomicCreate(target, 'must not replace', {
      writeFile: fs.writeFile,
      unlink: fs.unlink,
      link: async () => { throw unsupported; },
    })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(target, 'utf-8')).toBe('fallback content');
  });
});

describe('realpath containment', () => {
  it('rejects a write when a registered directory is replaced by an outward symlink', async () => {
    const clients = path.join(root, 'clients');
    rmSync(clients, { recursive: true, force: true });

    const outside = mkdtempSync(path.join(tmpdir(), 'maad-write-outside-'));
    extraDirs.push(outside);
    symlinkSync(outside, clients, process.platform === 'win32' ? 'junction' : 'dir');

    const result = await engine.createDocument(
      docType('client'),
      { name: 'Escaped', status: 'active' },
      undefined,
      'cli-escaped',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]!.code).toBe('PATH_OUTSIDE_PROJECT');
    expect(existsSync(path.join(outside, 'cli-escaped.md'))).toBe(false);
  });
});

describe('MCP write handlers preserve the engine boundary', () => {
  it('rejects reserved fields through create and update tools', async () => {
    engine.close();

    const instance = synthesizeLegacyInstance(root, 'admin');
    const ctx: InstanceCtx = {
      instance,
      pool: new EnginePool(instance),
      sessions: new SessionRegistry(instance),
      tokens: null,
    };
    const server = new McpServer({ name: 'write-boundary-test', version: '0.0.0' });
    const handlers = new Map<string, (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>>();
    // Capture the registered public handlers without starting a transport.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (server as any).registerTool = (name: string, _definition: unknown, handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>) => {
      handlers.set(name, handler);
    };
    writeTools.register(server, ctx);

    try {
      const create = await handlers.get('maad_create')!(
        {
          docType: 'client',
          docId: 'cli-mcp-reserved',
          fields: { name: 'MCP Reserved', status: 'active', doc_id: 'cli-other' },
        },
        { sessionId: 'write-boundary-session' },
      );
      const createBody = parseResponse(create);
      expect(createBody.ok).toBe(false);
      expect(createBody.errors?.[0]?.code).toBe('FRONTMATTER_GUARD');

      const before = readFileSync(clientPath('cli-acme'), 'utf-8');
      const update = await handlers.get('maad_update')!(
        { docId: 'cli-acme', fields: { schema: 'client.v99' } },
        { sessionId: 'write-boundary-session' },
      );
      const updateBody = parseResponse(update);
      expect(updateBody.ok).toBe(false);
      expect(updateBody.errors?.[0]?.code).toBe('FRONTMATTER_GUARD');
      expect(readFileSync(clientPath('cli-acme'), 'utf-8')).toBe(before);
    } finally {
      await ctx.pool.closeAll();
    }
  });
});
