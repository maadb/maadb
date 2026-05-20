// ============================================================================
// 0.7.10 — engine.bulkDelete coverage. Mirrors the backup.test.ts pattern:
// fresh project copy per test, real engine + git repo, exercises engine
// methods directly. The MCP wrapper (cleanup.ts) is a thin dispatch verified
// by kinds.test.ts and the cleanup-cap unit tests.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { MaadEngine } from '../../src/engine.js';
import { docId as toDocId } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-bulk-delete');

let engine: MaadEngine;

async function createTestClient(id: string, name = id) {
  const r = await engine.createDocument('client' as never, { name, status: 'active' }, undefined, id);
  expect(r.ok).toBe(true);
}

beforeEach(async () => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true });
  cpSync(FIXTURE_SRC, TEMP_ROOT, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}_backend`) && !src.includes(`${path.sep}.git`),
  });

  const setupGit = simpleGit(TEMP_ROOT);
  await setupGit.init();
  await setupGit.addConfig('user.email', 'test@example.com');
  await setupGit.addConfig('user.name', 'test');
  await setupGit.add('.').commit('test fixture init');

  engine = new MaadEngine();
  const result = await engine.init(TEMP_ROOT);
  expect(result.ok).toBe(true);
  await engine.indexAll({ force: true });

  await createTestClient('cli-a');
  await createTestClient('cli-b');
  await createTestClient('cli-c');
});

afterEach(async () => {
  engine.close();
  await new Promise(r => setTimeout(r, 100));
  try {
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch {
    // Windows may briefly hold a db handle — non-fatal.
  }
});

describe('engine.bulkDelete — soft mode', () => {
  it('soft-deletes the requested docIds in a single commit and reports per-record results', async () => {
    const before = await simpleGit(TEMP_ROOT).log();
    const beforeCommits = before.total;

    const result = await engine.bulkDelete(['cli-a', 'cli-b'], 'soft');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalRequested).toBe(2);
    expect(result.value.succeeded.length).toBe(2);
    expect(result.value.failed.length).toBe(0);
    expect(result.value.writeDurable).toBe(true);
    const ids = result.value.succeeded.map(s => s.docId).sort();
    expect(ids).toEqual(['cli-a', 'cli-b']);
    expect(result.value.succeeded.every(s => s.mode === 'soft')).toBe(true);

    // Documents are gone from the standard read path (deleted=0 filter)
    expect(engine.getBackend().getDocument(toDocId('cli-a'))).toBeNull();
    expect(engine.getBackend().getDocument(toDocId('cli-b'))).toBeNull();
    // Third record untouched
    expect(engine.getBackend().getDocument(toDocId('cli-c'))).not.toBeNull();

    // Exactly one new commit landed for the whole batch (atomicity).
    const after = await simpleGit(TEMP_ROOT).log();
    expect(after.total - beforeCommits).toBe(1);
    expect(after.latest?.message).toContain('soft');
    expect(after.latest?.message).toContain('2 records');
  });

  it('renames files with the _deleted_ prefix on disk', async () => {
    await engine.bulkDelete(['cli-a'], 'soft');
    const entries = await readdir(path.join(TEMP_ROOT, 'clients'));
    expect(entries.find(e => e === '_deleted_cli-a.md')).toBeDefined();
    expect(entries.find(e => e === 'cli-a.md')).toBeUndefined();
  });

  it('collects per-record failures without aborting the batch', async () => {
    const result = await engine.bulkDelete(['cli-a', 'cli-nonexistent', 'cli-b'], 'soft');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.succeeded.length).toBe(2);
    expect(result.value.failed.length).toBe(1);
    expect(result.value.failed[0]!.docId).toBe('cli-nonexistent');
    expect(result.value.failed[0]!.error.toLowerCase()).toContain('not found');
    // The two valid records still soft-delete
    expect(engine.getBackend().getDocument(toDocId('cli-a'))).toBeNull();
    expect(engine.getBackend().getDocument(toDocId('cli-b'))).toBeNull();
  });
});

describe('engine.bulkDelete — hard mode', () => {
  it('hard-deletes the requested docIds, removing files and index rows', async () => {
    const result = await engine.bulkDelete(['cli-a', 'cli-b'], 'hard');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.succeeded.every(s => s.mode === 'hard')).toBe(true);
    expect(result.value.writeDurable).toBe(true);

    expect(existsSync(path.join(TEMP_ROOT, 'clients', 'cli-a.md'))).toBe(false);
    expect(existsSync(path.join(TEMP_ROOT, 'clients', 'cli-b.md'))).toBe(false);
    expect(existsSync(path.join(TEMP_ROOT, 'clients', '_deleted_cli-a.md'))).toBe(false);
    expect(engine.getBackend().getDocument(toDocId('cli-a'))).toBeNull();
    expect(engine.getBackend().getDocument(toDocId('cli-b'))).toBeNull();
  });

  it('produces a single commit with hard detail for the batch', async () => {
    const before = (await simpleGit(TEMP_ROOT).log()).total;
    await engine.bulkDelete(['cli-a', 'cli-b'], 'hard');
    const after = await simpleGit(TEMP_ROOT).log();
    expect(after.total - before).toBe(1);
    expect(after.latest?.message).toContain('hard');
    expect(after.latest?.message).toContain('2 records');
  });
});

describe('engine.bulkDelete — empty inputs', () => {
  it('handles an empty docIds array as a no-op with zero commit', async () => {
    const before = (await simpleGit(TEMP_ROOT).log()).total;
    const result = await engine.bulkDelete([], 'soft');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalRequested).toBe(0);
    expect(result.value.succeeded.length).toBe(0);
    expect(result.value.failed.length).toBe(0);
    const after = (await simpleGit(TEMP_ROOT).log()).total;
    expect(after - before).toBe(0);
  });

  it('all-missing inputs produce no commit and only failures', async () => {
    const before = (await simpleGit(TEMP_ROOT).log()).total;
    const result = await engine.bulkDelete(['nope-1', 'nope-2'], 'soft');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.succeeded.length).toBe(0);
    expect(result.value.failed.length).toBe(2);
    const after = (await simpleGit(TEMP_ROOT).log()).total;
    expect(after - before).toBe(0);
  });
});
