import { describe, it, expect, vi } from 'vitest';
import { scopeFixture } from '../performance/scope-fixture.js';
import { semanticSearch } from '../../src/engine/semantic/search.js';
import type { SemanticIndex } from '../../src/engine/semantic/types.js';
import { docId } from '../../src/types.js';

// Deliberately implements only the original interface: no scope or coverage
// extensions and a four-argument FTS function. This also acts as a type fixture.
function legacyIndex(source: SemanticIndex): SemanticIndex {
  return {
    isReady: () => source.isReady(),
    isVecReady: () => source.isVecReady(),
    ensureVecTable: (dim, model) => source.ensureVecTable(dim, model),
    putBlockText: (id, blocks) => source.putBlockText(id, blocks),
    deleteDoc: id => source.deleteDoc(id),
    enqueueAll: () => source.enqueueAll(),
    takeEmbedBatch: limit => source.takeEmbedBatch(limit),
    putBlockEmbeddings: rows => source.putBlockEmbeddings(rows),
    searchVec: (vector, k) => source.searchVec(vector, k),
    searchFts: (query, k, snippet, ids) => source.searchFts(query, k, snippet, ids),
    getBlockText: (id, ordinal) => source.getBlockText(id, ordinal),
    recordFailure: n => source.recordFailure(n),
    stats: () => source.stats(),
  };
}

describe('legacy semantic backend compatibility', () => {
  it('rejects requested scopes before invoking a legacy method that would ignore them', async () => {
    const f = scopeFixture(1);
    try {
      f.add('private', 'uniqueneedle', 'note', 'private');
      const legacy = legacyIndex(f.sem);
      const fts = vi.spyOn(legacy, 'searchFts');
      const vec = vi.spyOn(legacy, 'searchVec');
      const embed = vi.spyOn(f.ctx.embeddingProvider!, 'embed');
      vi.spyOn(f.backend, 'semantic').mockReturnValue(legacy);
      for (const mode of ['exact', 'hybrid', 'semantic'] as const) {
        for (const scope of [{ filters: { access: 'public' } }, { docType: 'note' }]) {
          const r = await semanticSearch(f.ctx, { query: 'uniqueneedle', mode, ...scope });
          expect(r.ok).toBe(false);
          if (r.ok) throw new Error('scope unexpectedly accepted');
          expect(r.errors[0]?.code).toBe('SEMANTIC_DISABLED');
        }
      }
      expect(fts).not.toHaveBeenCalled();
      expect(vec).not.toHaveBeenCalled();
      expect(embed).not.toHaveBeenCalled();
    } finally { f.close(); }
  });

  it('preserves unscoped exact and vector retrieval, without inventing coverage', async () => {
    const f = scopeFixture(1);
    try {
      f.add('deleted', 'uniqueneedle');
      f.sem.putBlockEmbeddings(f.sem.takeEmbedBatch(10).map(b => ({ ...b, vector: new Float32Array([1, 0]) })));
      f.backend.putDocument({ ...f.backend.getDocument(docId('deleted'))!, deleted: true });
      const legacy = legacyIndex(f.sem);
      const fts = vi.spyOn(legacy, 'searchFts');
      const embed = vi.spyOn(f.ctx.embeddingProvider!, 'embed');
      vi.spyOn(f.backend, 'semantic').mockReturnValue(legacy);
      const exact = await semanticSearch(f.ctx, { query: 'uniqueneedle', mode: 'exact' });
      expect(exact.ok && exact.value.results.map(h => h.docId)).toEqual(['old']);
      expect(exact.ok && exact.value.limitations).toBeUndefined();
      expect(fts).toHaveBeenCalledExactlyOnceWith('uniqueneedle', 50, true);
      expect(embed).not.toHaveBeenCalled();
      for (const mode of ['hybrid', 'semantic'] as const) {
        const r = await semanticSearch(f.ctx, { query: 'uniqueneedle', mode });
        expect(r.ok && r.value.results.map(h => h.docId)).toEqual(['old']);
        expect(r.ok && r.value.limitations).toEqual(['embeddings_coverage_unknown']);
        expect(r.ok && r.value.degraded).toBeUndefined();
      }
    } finally { f.close(); }
  });

  it('supports scoped exact with only the FTS extension and rejects incomplete vector capabilities', async () => {
    const f = scopeFixture(1);
    try {
      f.add('private', 'uniqueneedle', 'note', 'private');
      const partial = legacyIndex(f.sem);
      partial.searchFtsScoped = (q, k, snippet, scope) => f.sem.searchFtsScoped!(q, k, snippet, scope);
      vi.spyOn(f.backend, 'semantic').mockReturnValue(partial);
      const query = { query: 'uniqueneedle', filters: { access: 'public' } };
      const exact = await semanticSearch(f.ctx, { ...query, mode: 'exact' });
      expect(exact.ok && exact.value.results.map(h => h.docId)).toEqual(['old']);
      for (const mode of ['hybrid', 'semantic'] as const) {
        const r = await semanticSearch(f.ctx, { ...query, mode });
        expect(r.ok).toBe(false);
        if (r.ok) throw new Error('partial scope unexpectedly accepted');
        expect(r.errors[0]?.code).toBe('SEMANTIC_DISABLED');
      }
      delete partial.searchFtsScoped;
      partial.filterDocIds = (ids, scope) => f.sem.filterDocIds!(ids, scope);
      const vectorOnly = await semanticSearch(f.ctx, { ...query, mode: 'semantic' });
      expect(vectorOnly.ok).toBe(false);
    } finally { f.close(); }
  });

  it('treats pending detection as independent optional coverage with the exact supplied scope', async () => {
    const f = scopeFixture(1);
    try {
      const adapter = legacyIndex(f.sem);
      adapter.searchFtsScoped = (q, k, snippet, scope) => f.sem.searchFtsScoped!(q, k, snippet, scope);
      adapter.filterDocIds = (ids, scope) => f.sem.filterDocIds!(ids, scope);
      vi.spyOn(f.backend, 'semantic').mockReturnValue(adapter);
      const query = { query: 'uniqueneedle', mode: 'hybrid' as const, docType: 'note', filters: { access: 'public' } };
      const unknown = await semanticSearch(f.ctx, query);
      expect(unknown.ok && unknown.value.limitations).toEqual(['embeddings_coverage_unknown']);
      adapter.hasPendingEmbeddings = vi.fn(scope => f.sem.hasPendingEmbeddings!(scope));
      const pending = await semanticSearch(f.ctx, query);
      expect(pending.ok && pending.value.limitations).toEqual(['embeddings_pending']);
      expect(adapter.hasPendingEmbeddings).toHaveBeenCalledWith({ docType: 'note', filters: { access: [{ op: 'eq', value: 'public' }] } });
      f.sem.putBlockEmbeddings(f.sem.takeEmbedBatch(10).map(b => ({ ...b, vector: new Float32Array([1, 0]) })));
      const complete = await semanticSearch(f.ctx, query);
      expect(complete.ok && complete.value.limitations).toBeUndefined();
    } finally { f.close(); }
  });
});
