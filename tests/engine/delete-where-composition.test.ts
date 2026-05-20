// ============================================================================
// 0.7.10 — maad_delete_where MCP tool composes engine.findDocuments +
// engine.bulkDelete. The MCP dispatch is verified by kinds.test.ts; the cap
// behavior is verified by cleanup-cap.test.ts; this file verifies the
// engine-level composition the tool wraps: a filter on findDocuments yields
// the docIds, bulkDelete removes exactly those.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync } from 'node:fs';
import { simpleGit } from 'simple-git';
import { MaadEngine } from '../../src/engine.js';
import { docId as toDocId, docType as toDocType } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-delete-where');

let engine: MaadEngine;

async function createClient(id: string, status: string) {
  const r = await engine.createDocument('client' as never, { name: id, status }, undefined, id);
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

  // Three "inactive" + two "active" clients to set up a filter scenario.
  await createClient('cli-old-1', 'inactive');
  await createClient('cli-old-2', 'inactive');
  await createClient('cli-old-3', 'inactive');
  await createClient('cli-live-1', 'active');
  await createClient('cli-live-2', 'active');
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

describe('delete_where composition: findDocuments + bulkDelete', () => {
  it('filter yields the docIds, bulkDelete removes exactly those', async () => {
    const found = engine.findDocuments({ docType: toDocType('client'), filters: { status: 'inactive' } });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.results.length).toBe(3);
    const inactiveIds = found.value.results.map(r => r.docId as string).sort();
    expect(inactiveIds).toEqual(['cli-old-1', 'cli-old-2', 'cli-old-3']);

    const del = await engine.bulkDelete(inactiveIds, 'soft');
    expect(del.ok).toBe(true);
    if (!del.ok) return;
    expect(del.value.succeeded.length).toBe(3);

    // Archived ones gone, actives still there.
    for (const id of inactiveIds) {
      expect(engine.getBackend().getDocument(toDocId(id))).toBeNull();
    }
    expect(engine.getBackend().getDocument(toDocId('cli-live-1'))).not.toBeNull();
    expect(engine.getBackend().getDocument(toDocId('cli-live-2'))).not.toBeNull();
  });

  it('filter that matches nothing yields zero docIds — caller short-circuits without engine.bulkDelete', async () => {
    const found = engine.findDocuments({ docType: toDocType('client'), filters: { status: 'prospect' } });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    expect(found.value.results.length).toBe(0);
    // No engine.bulkDelete call necessary — the MCP tool short-circuits when
    // the would-affect set is empty, returning a writeDurable:true noop.
  });

  it('probe-with-limit pattern detects overflow without scanning the full set', async () => {
    // The MCP tool probes findDocuments({limit: maxRecords + 1}) to detect
    // overflow. Simulate maxRecords=2: we should see 3 rows back (>2) and
    // know to return BULK_LIMIT_EXCEEDED instead of deleting.
    const probe = engine.findDocuments({
      docType: toDocType('client'),
      filters: { status: 'inactive' },
      limit: 3,
    });
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.value.results.length).toBe(3);
    expect(probe.value.results.length).toBeGreaterThan(2); // would trigger BULK_LIMIT_EXCEEDED
  });
});
