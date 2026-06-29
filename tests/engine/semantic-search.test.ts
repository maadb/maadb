import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docType, type DocId } from '../../src/types.js';
import { FakeEmbeddingProvider } from '../../src/engine/semantic/providers/fake.js';
import type { EmbeddingProvider } from '../../src/engine/semantic/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');

async function freshEngine(tag: string, opts?: Parameters<MaadEngine['init']>[1]): Promise<{ engine: MaadEngine; root: string }> {
  const root = path.resolve(__dirname, `../fixtures/_temp-sem-${tag}`);
  if (existsSync(root)) rmSync(root, { recursive: true, maxRetries: 10, retryDelay: 200 });
  cpSync(FIXTURE_SRC, root, { recursive: true });
  const backendDir = path.join(root, '_backend');
  if (existsSync(backendDir)) rmSync(backendDir, { recursive: true, maxRetries: 10, retryDelay: 200 });
  const engine = new MaadEngine();
  const res = await engine.init(root, opts);
  expect(res.ok).toBe(true);
  return { engine, root };
}

function cleanup(engine: MaadEngine, root: string) {
  engine.close();
  try { if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* */ }
}

describe('maad_semantic_search — modes & fusion', () => {
  let engine: MaadEngine;
  let root: string;
  const ids: Record<string, DocId> = {};

  beforeAll(async () => {
    ({ engine, root } = await freshEngine('search', { semantic: true, embeddingProvider: new FakeEmbeddingProvider(64) }));
    const mk = async (name: string, status: string, body: string) => {
      const r = await engine.createDocument(docType('client'), { name, status }, body);
      expect(r.ok).toBe(true);
      if (r.ok) return r.value.docId;
      throw new Error('create failed');
    };
    ids['robotics'] = await mk('Acme Robotics', 'active', 'We manufacture autonomous warehouse robots and logistics automation machinery.');
    ids['fintech'] = await mk('Bluefin Capital', 'prospect', 'A venture firm investing in fintech and payments startups across Europe.');
    ids['health'] = await mk('Cedar Health', 'active', 'Telemedicine platform connecting patients with doctors for remote zebra consultations.');
    await engine.flushSemanticIndex();
  });
  afterAll(() => cleanup(engine, root));

  it('rejects an invalid mode', async () => {
    const r = await engine.semanticSearch({ query: 'robots', mode: 'fuzzy' as 'exact' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]!.code).toBe('INVALID_MODE');
  });

  it('exact mode finds lexical matches and returns a snippet', async () => {
    const r = await engine.semanticSearch({ query: 'warehouse robots', mode: 'exact' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.mode).toBe('exact');
    expect(r.value.results.some(h => h.docId === ids['robotics'])).toBe(true);
    expect(r.value.results[0]!.snippet.length).toBeGreaterThan(0);
  });

  it('semantic mode ranks the token-overlapping doc first', async () => {
    const r = await engine.semanticSearch({ query: 'warehouse automation machinery', mode: 'semantic', k: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.results[0]!.docId).toBe(ids['robotics']);
    expect(r.value.degraded).toBeUndefined();
  });

  it('hybrid mode fuses both legs (RRF)', async () => {
    const r = await engine.semanticSearch({ query: 'fintech payments', mode: 'hybrid', k: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.results.some(h => h.docId === ids['fintech'])).toBe(true);
  });

  it('scope filter narrows to matching docs only', async () => {
    // "consultations" is unique to the health doc (status=active).
    const r = await engine.semanticSearch({ query: 'consultations', mode: 'exact', filters: { status: 'prospect' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.results.some(h => h.docId === ids['health'])).toBe(false); // health is active, filtered out
  });

  it('soft-deleted docs are excluded from results', async () => {
    const del = await engine.deleteDocument(ids['health']!, 'soft');
    expect(del.ok).toBe(true);
    const r = await engine.semanticSearch({ query: 'zebra', mode: 'exact' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.results.some(h => h.docId === ids['health'])).toBe(false);
  });
});

describe('maad_semantic_search — disabled', () => {
  it('returns SEMANTIC_DISABLED when semantic is off', async () => {
    const { engine, root } = await freshEngine('off'); // no semantic
    try {
      const r = await engine.semanticSearch({ query: 'anything', mode: 'exact' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]!.code).toBe('SEMANTIC_DISABLED');
    } finally { cleanup(engine, root); }
  });
});

describe('maad_semantic_search — degraded (no provider)', () => {
  it('semantic mode falls back to lexical with degraded flag', async () => {
    const { engine, root } = await freshEngine('noprov', { semantic: true }); // enabled, no provider
    try {
      const c = await engine.createDocument(docType('client'), { name: 'Lex Co', status: 'active' }, 'lexical only fallback test about platypus.');
      expect(c.ok).toBe(true);
      await engine.flushSemanticIndex();
      const r = await engine.semanticSearch({ query: 'platypus', mode: 'semantic' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.degraded).toBe('no_vector_provider');
      expect(r.value.results.length).toBeGreaterThan(0); // lexical leg still works
    } finally { cleanup(engine, root); }
  });
});

describe('maad_semantic_search — exact touches no model', () => {
  it('exact mode succeeds even when the provider throws on embed', async () => {
    const throwing: EmbeddingProvider = {
      id: 'throwing', model: 'boom', dim: 8,
      embed: async () => { throw new Error('model unavailable'); },
    };
    const { engine, root } = await freshEngine('throwing', { semantic: true, embeddingProvider: throwing });
    try {
      const c = await engine.createDocument(docType('client'), { name: 'Quokka Inc', status: 'active' }, 'a doc about quokkas and exact retrieval.');
      expect(c.ok).toBe(true);
      // worker will fail to embed (provider throws) — fts still populated.
      const exact = await engine.semanticSearch({ query: 'quokkas', mode: 'exact' });
      expect(exact.ok).toBe(true);
      if (exact.ok) expect(exact.value.results.length).toBeGreaterThan(0); // no model needed
      // semantic mode tries to embed, fails, degrades to lexical (no throw).
      const sem = await engine.semanticSearch({ query: 'quokkas', mode: 'semantic' });
      expect(sem.ok).toBe(true);
      if (sem.ok) expect(sem.value.degraded).toBe('embed_failed');
    } finally { cleanup(engine, root); }
  });
});
