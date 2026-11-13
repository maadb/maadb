// ============================================================================
// 0.23.0 — findDocuments without the total count, and per-item
// expectedVersion on bulkUpdate.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import { mkdtemp, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docId, docType } from '../../src/types.js';
import { SqliteBackend } from '../../src/backend/sqlite/index.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');

let root: string;
let engine: MaadEngine;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'maad-gaps-'));
  await cp(FIXTURE_SRC, root, { recursive: true });
  engine = new MaadEngine();
  const init = await engine.init(root);
  expect(init.ok).toBe(true);
  await engine.indexAll({ force: true });
  // Five more clients so paging has something to page over.
  for (let i = 1; i <= 5; i++) {
    const created = await engine.createDocument(docType('client'), { name: `Fictional ${i}`, status: 'active' }, undefined, `cli-fict-${i}`);
    expect(created.ok).toBe(true);
  }
});

afterAll(async () => {
  engine.close();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
});

describe('findDocuments includeTotal', () => {
  it('default keeps total and adds hasMore', () => {
    const r = engine.findDocuments({ docType: docType('client'), limit: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.total).toBe(6);
    expect(r.value.results).toHaveLength(2);
    expect(r.value.hasMore).toBe(true);
  });

  it('includeTotal:false skips the count and reports hasMore', () => {
    const count = vi.spyOn(SqliteBackend.prototype, 'countDocuments');
    try {
      const r = engine.findDocuments({ docType: docType('client'), limit: 2, sortBy: 'doc_id', sortOrder: 'asc' }, { includeTotal: false });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(count).not.toHaveBeenCalled();
      expect('total' in r.value).toBe(false);
      expect(r.value.results).toHaveLength(2);
      expect(r.value.hasMore).toBe(true);
    } finally {
      count.mockRestore();
    }
  });

  it('pages match the counted query and hasMore turns false on the last page', () => {
    const counted = engine.findDocuments({ docType: docType('client'), limit: 50, sortBy: 'doc_id', sortOrder: 'asc' });
    expect(counted.ok).toBe(true);
    if (!counted.ok) return;
    const seen: string[] = [];
    let offset = 0;
    for (;;) {
      const page = engine.findDocuments({ docType: docType('client'), limit: 4, offset, sortBy: 'doc_id', sortOrder: 'asc' }, { includeTotal: false });
      expect(page.ok).toBe(true);
      if (!page.ok) return;
      seen.push(...page.value.results.map(r => r.docId as string));
      offset += page.value.results.length;
      if (!page.value.hasMore) break;
    }
    expect(seen).toEqual(counted.value.results.map(r => r.docId as string));
    expect(seen).toHaveLength(6);
  });

  it('still projects fields and reports filter warnings', () => {
    const r = engine.findDocuments(
      { docType: docType('client'), filters: { status: 'active', no_such_field: 'x' } as never, fields: ['name'], limit: 1 },
      { includeTotal: false },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.filterWarnings?.[0]?.field).toBe('no_such_field');
  });

  it('limit 0 returns no rows and says whether any exist', () => {
    const r = engine.findDocuments({ docType: docType('client'), limit: 0 }, { includeTotal: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.results).toHaveLength(0);
    expect(r.value.hasMore).toBe(true);
  });
});

describe('bulkUpdate expectedVersion', () => {
  async function versionOf(id: string): Promise<number> {
    const got = await engine.getDocument(docId(id), 'hot');
    if (!got.ok) throw new Error(`get ${id}`);
    return got.value.version;
  }

  it('applies items whose version matches and fails only the stale one', async () => {
    const v1 = await versionOf('cli-fict-1');
    const v2 = await versionOf('cli-fict-2');

    const r = await engine.bulkUpdate([
      { docId: 'cli-fict-1', fields: { status: 'inactive' }, expectedVersion: v1 },
      { docId: 'cli-fict-2', fields: { status: 'inactive' }, expectedVersion: v2 + 7 },
      { docId: 'cli-fict-3', fields: { status: 'inactive' } },
    ]);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.succeeded.map(s => s.docId)).toEqual(['cli-fict-1', 'cli-fict-3']);
    expect(r.value.failed).toHaveLength(1);
    const failed = r.value.failed[0]!;
    expect(failed.index).toBe(1);
    expect(failed.code).toBe('VERSION_CONFLICT');
    expect(failed.details).toEqual({ expected: v2 + 7, actual: v2 });

    // The stale item left the file and index untouched.
    expect(await versionOf('cli-fict-2')).toBe(v2);
    const file = readFileSync(path.join(root, 'clients', 'cli-fict-2.md'), 'utf-8');
    expect(file).toContain('status: active');
    expect(await versionOf('cli-fict-1')).toBe(v1 + 1);
  });

  it('a second item for the same record checks the version left by the first', async () => {
    const v = await versionOf('cli-fict-4');
    const r = await engine.bulkUpdate([
      { docId: 'cli-fict-4', fields: { status: 'inactive' }, expectedVersion: v },
      { docId: 'cli-fict-4', fields: { status: 'active' }, expectedVersion: v },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.succeeded).toHaveLength(1);
    expect(r.value.failed[0]?.code).toBe('VERSION_CONFLICT');
    expect(r.value.failed[0]?.details).toEqual({ expected: v, actual: v + 1 });
  });

  it('validation failures carry their code too', async () => {
    const r = await engine.bulkUpdate([{ docId: 'nope-404', fields: { status: 'active' } }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.failed[0]?.code).toBe('FILE_NOT_FOUND');
    expect(r.value.failed[0]?.error).toContain('not found');
  });
});
