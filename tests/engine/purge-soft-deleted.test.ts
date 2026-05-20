// ============================================================================
// 0.7.10 — engine.purgeSoftDeleted coverage. Hard-deletes soft-deleted
// records whose updated_at predates a retention threshold.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync } from 'node:fs';
import { simpleGit } from 'simple-git';
import { MaadEngine } from '../../src/engine.js';
import { docId as toDocId, filePath as toFilePath, schemaRef as toSchemaRef, docType as toDocType } from '../../src/types.js';
import type { DocumentRecord } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-purge');

let engine: MaadEngine;

async function createTestClient(id: string, name = id) {
  const r = await engine.createDocument('client' as never, { name, status: 'active' }, undefined, id);
  expect(r.ok).toBe(true);
}

/** Soft-delete a doc via the engine, then backdate its updated_at in the index
 * so it falls past whatever retention threshold the test wants to apply. The
 * on-disk _deleted_<id>.md file already exists from the soft-delete, so the
 * cemetery is realistic. */
async function softDeleteAndBackdate(id: string, updatedAtIso: string) {
  await engine.deleteDocument(toDocId(id), 'soft');
  const cur = engine.getBackend();
  // Read the just-soft-deleted record by direct SQL fallback through any
  // path that includes deleted=1 rows. findSoftDeletedBefore with a future
  // threshold returns everything.
  const rows = cur.findSoftDeletedBefore('9999-12-31T00:00:00.000Z', 10000);
  const found = rows.find(r => r.docId === id);
  if (!found) throw new Error(`Test setup error: just-soft-deleted ${id} not in cemetery`);
  const backdated: DocumentRecord = {
    docId: toDocId(found.docId),
    docType: toDocType(found.docType),
    schemaRef: toSchemaRef(found.schemaRef),
    filePath: toFilePath(found.filePath),
    fileHash: found.fileHash,
    version: found.version,
    deleted: true,
    indexedAt: found.indexedAt,
    updatedAt: updatedAtIso,
  };
  cur.putDocument(backdated);
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

describe('engine.purgeSoftDeleted', () => {
  it('purges soft-deleted records older than the threshold and leaves recent ones alone', async () => {
    await createTestClient('cli-old-1');
    await createTestClient('cli-old-2');
    await createTestClient('cli-recent');

    // Two backdated 60 days ago; one freshly soft-deleted.
    const oldIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    await softDeleteAndBackdate('cli-old-1', oldIso);
    await softDeleteAndBackdate('cli-old-2', oldIso);
    await engine.deleteDocument(toDocId('cli-recent'), 'soft');

    // Threshold: 30 days ago. Should match the two old ones, not the recent one.
    const thresholdIso = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const result = await engine.purgeSoftDeleted(thresholdIso, 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.scanned).toBe(2);
    expect(result.value.purged.length).toBe(2);
    expect(result.value.failed.length).toBe(0);
    expect(result.value.writeDurable).toBe(true);
    expect(result.value.retentionThresholdIso).toBe(thresholdIso);
    const purgedIds = result.value.purged.map(p => p.docId).sort();
    expect(purgedIds).toEqual(['cli-old-1', 'cli-old-2']);

    // Files are gone, including the _deleted_ prefixed ones.
    expect(existsSync(path.join(TEMP_ROOT, 'clients', '_deleted_cli-old-1.md'))).toBe(false);
    expect(existsSync(path.join(TEMP_ROOT, 'clients', '_deleted_cli-old-2.md'))).toBe(false);

    // Recent soft-delete still in the cemetery — file present, row marked deleted.
    expect(existsSync(path.join(TEMP_ROOT, 'clients', '_deleted_cli-recent.md'))).toBe(true);
  });

  it('reports scanned > purged.length when the cemetery exceeds maxRecords', async () => {
    const oldIso = new Date('2020-01-01').toISOString();
    for (let i = 0; i < 5; i++) {
      await createTestClient(`cli-buried-${i}`);
      await softDeleteAndBackdate(`cli-buried-${i}`, oldIso);
    }

    // Cap at 3 — scanned should report all 5, purged just 3.
    const result = await engine.purgeSoftDeleted(new Date().toISOString(), 3);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scanned).toBe(5);
    expect(result.value.purged.length).toBe(3);

    // Two records still in the cemetery for a follow-up call to handle.
    const remaining = engine.getBackend().findSoftDeletedBefore('9999-12-31T00:00:00.000Z', 100);
    expect(remaining.length).toBe(2);
  });

  it('returns scanned:0 when the cemetery is empty for the threshold', async () => {
    const result = await engine.purgeSoftDeleted(new Date().toISOString(), 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scanned).toBe(0);
    expect(result.value.purged.length).toBe(0);
    expect(result.value.writeDurable).toBe(true);
  });

  it('does not touch non-soft-deleted records under any threshold', async () => {
    await createTestClient('cli-live');
    const result = await engine.purgeSoftDeleted(new Date().toISOString(), 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scanned).toBe(0);
    expect(engine.getBackend().getDocument(toDocId('cli-live'))).not.toBeNull();
    expect(existsSync(path.join(TEMP_ROOT, 'clients', 'cli-live.md'))).toBe(true);
  });

  it('produces a single commit per purge call', async () => {
    await createTestClient('cli-old-a');
    await createTestClient('cli-old-b');
    const oldIso = new Date('2020-01-01').toISOString();
    await softDeleteAndBackdate('cli-old-a', oldIso);
    await softDeleteAndBackdate('cli-old-b', oldIso);

    const before = (await simpleGit(TEMP_ROOT).log()).total;
    const result = await engine.purgeSoftDeleted(new Date().toISOString(), 100);
    expect(result.ok).toBe(true);
    const after = await simpleGit(TEMP_ROOT).log();
    expect(after.total - before).toBe(1);
    expect(after.latest?.message).toContain('Purged 2 soft-deleted');
  });
});
