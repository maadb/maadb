import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docType } from '../../src/types.js';
import { FakeEmbeddingProvider } from '../../src/engine/semantic/providers/fake.js';

// End-to-end through a real engine with semantic on + an injected fake provider:
// write → block FTS-index + enqueue → worker embeds → vec/fts searchable → delete clears.
const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-semantic-index');

const provider = new FakeEmbeddingProvider(32);
let engine: MaadEngine;

beforeAll(async () => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, maxRetries: 10, retryDelay: 200 });
  cpSync(FIXTURE_SRC, TEMP_ROOT, { recursive: true });
  const backendDir = path.join(TEMP_ROOT, '_backend');
  if (existsSync(backendDir)) rmSync(backendDir, { recursive: true, maxRetries: 10, retryDelay: 200 });

  engine = new MaadEngine();
  const res = await engine.init(TEMP_ROOT, { semantic: true, embeddingProvider: provider });
  expect(res.ok).toBe(true);
  await engine.indexAll({ force: true });
  await engine.flushSemanticIndex();
});

afterAll(async () => {
  engine.close();
  await new Promise(r => setTimeout(r, 100));
  try {
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch { /* Windows handle lag — non-fatal */ }
});

describe('semantic index — end to end', () => {
  it('indexAll populated the per-block index and the worker embedded it', () => {
    const sem = engine.getBackend().semantic();
    expect(sem).not.toBeNull();
    const stats = sem!.stats();
    expect(stats.ready).toBe(true);
    expect(stats.vecReady).toBe(true);
    expect(stats.indexedBlocks).toBeGreaterThan(0);
    expect(stats.queueDepth).toBe(0);                 // worker fully drained
    expect(stats.embeddedBlocks).toBe(stats.indexedBlocks);
  });

  it('reindex --embeddings rebuilds the index; semanticHealth reports caught-up', async () => {
    const r = await engine.reindex({ embeddings: true });
    expect(r.ok).toBe(true);
    const h = engine.semanticHealth();
    expect(h.enabled).toBe(true);
    expect(h.provider).toBe('fake');
    expect(h.vecReady).toBe(true);
    expect(h.queueDepth).toBe(0);
    expect(h.embeddedBlocks).toBe(h.indexedBlocks);
    expect(h.indexedBlocks).toBeGreaterThan(0);
  });

  it('a created doc becomes lexically + vector searchable after flush', async () => {
    const created = await engine.createDocument(
      docType('client'),
      { name: 'Quantum Co', status: 'prospect', tags: ['startup'] },
      'This client builds quantum widgets for industrial robotics.',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await engine.flushSemanticIndex();

    const sem = engine.getBackend().semantic()!;
    const fts = sem.searchFts('quantum widgets', 10, true);
    expect(fts.some(h => h.docId === created.value.docId)).toBe(true);

    const [qv] = await provider.embed(['quantum widgets robotics'], 'query');
    const vec = sem.searchVec(qv!, 10);
    expect(vec.some(h => h.docId === created.value.docId)).toBe(true);
  });

  it('hard delete removes the doc from both legs', async () => {
    const created = await engine.createDocument(
      docType('client'),
      { name: 'Ephemeral Co', status: 'prospect' },
      'A doc about transient zeppelins that will be deleted.',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await engine.flushSemanticIndex();

    const sem = engine.getBackend().semantic()!;
    expect(sem.searchFts('zeppelins', 10, false).length).toBeGreaterThan(0);

    const del = await engine.deleteDocument(created.value.docId, 'hard');
    expect(del.ok).toBe(true);
    expect(sem.searchFts('zeppelins', 10, false).length).toBe(0);
  });

  it('updating a doc re-embeds its new body (stale block text gone)', async () => {
    const created = await engine.createDocument(
      docType('client'),
      { name: 'Mutable Co', status: 'prospect' },
      'Original body mentioning aardvarks.',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await engine.flushSemanticIndex();
    const sem = engine.getBackend().semantic()!;
    expect(sem.searchFts('aardvarks', 10, false).length).toBeGreaterThan(0);

    const upd = await engine.updateDocument(created.value.docId, undefined, 'Rewritten body mentioning pangolins.');
    expect(upd.ok).toBe(true);
    await engine.flushSemanticIndex();
    expect(sem.searchFts('aardvarks', 10, false).length).toBe(0);
    expect(sem.searchFts('pangolins', 10, false).some(h => h.docId === created.value.docId)).toBe(true);
  });
});
