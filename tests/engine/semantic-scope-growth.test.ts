import { describe, it, expect, vi } from 'vitest';
import { scopeFixture } from '../performance/scope-fixture.js';
import { semanticSearch } from '../../src/engine/semantic/search.js';
import { docId, docType } from '../../src/types.js';

const scope = { docType: 'note', filters: { access: 'public', amount: { op: 'between', value: [10, 15] } } };

describe('scope eligibility beyond 2000 documents', () => {
  it('finds old evidence independently of indexing order, with exact zero model calls', async () => {
    const f = scopeFixture(2105, { inMemory: true });
    try {
      const embed = vi.spyOn(f.ctx.embeddingProvider!, 'embed');
      // Reproduce the former candidate exclusion using the original capped backend query.
      expect(f.backend.findDocuments({ docType: docType('note'), limit: 2000 }).map(d => d.docId)).not.toContain('old');
      const query = { query: 'uniqueneedle', mode: 'exact' as const, ...scope };
      const first = await semanticSearch(f.ctx, query);
      expect(first.ok && first.value.results.map(h => h.docId)).toEqual(['old']);
      f.add('old', 'uniqueneedle foundational decision', 'note', 'public', '2030-01-01');
      expect(await semanticSearch(f.ctx, query)).toEqual(first);
      for (const text of ['', '!!!', 'absenttoken']) {
        const empty = await semanticSearch(f.ctx, { ...query, query: text });
        expect(empty.ok && empty.value.results).toEqual([]);
      }
      expect(embed).not.toHaveBeenCalled();
      f.add('private', 'uniqueneedle', 'note', 'private');
      f.add('other-type', 'uniqueneedle', 'task');
      expect(await semanticSearch(f.ctx, query)).toEqual(first);
      for (const filters of [{ access: 'missing' }, { amount: { op: 'gt', value: 20 } }]) {
        const r = await semanticSearch(f.ctx, { ...query, filters });
        expect(r.ok && r.value.results).toEqual([]);
      }
      f.backend.putDocument({ ...f.backend.getDocument(docId('old'))!, deleted: true });
      const deleted = await semanticSearch(f.ctx, query);
      expect(deleted.ok && deleted.value.results).toEqual([]);
      f.backend.removeDocument(docId('old'));
      expect(await semanticSearch(f.ctx, query)).toEqual(deleted);
    } finally { f.close(); }
  });

  it('keeps older vector evidence eligible and discloses saturation on a full page', async () => {
    const f = scopeFixture(2105, { inMemory: true });
    try {
      const batch = f.sem.takeEmbedBatch(3000);
      f.sem.putBlockEmbeddings(batch.map(b => ({ ...b,
        vector: new Float32Array(b.docId === 'old' ? [1, 0] : [0, 1]),
      })));
      const r = await semanticSearch(f.ctx, { query: 'anything', mode: 'semantic', k: 1, ...scope });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('search failed');
      expect(r.value.results.map(h => h.docId)).toEqual(['old']);
      expect(r.value.total).toBe(1);
      expect(r.value.degraded).toBe('scope_truncated');
      expect(r.value.limitations).toContain('vector_candidate_pool_saturated');
      f.add('private', 'secret', 'note', 'private');
      const pending = f.sem.takeEmbedBatch(1);
      f.sem.putBlockEmbeddings(pending.map(b => ({ ...b, vector: new Float32Array([1, 0]) })));
      const isolated = await semanticSearch(f.ctx, { query: 'anything', mode: 'semantic', k: 10, ...scope });
      expect(isolated.ok && isolated.value.results.some(h => h.docId === 'private')).toBe(false);
    } finally { f.close(); }
  });

  it('discloses an empty scoped vector page when out-of-scope neighbors fill the budget', async () => {
    const f = scopeFixture(1002, { inMemory: true });
    try {
      for (const b of f.sem.takeEmbedBatch(2000)) {
        if (b.docId !== 'old') f.backend.putFieldIndex(docId(b.docId), [
          { name: 'access', value: 'private', numericValue: null, type: 'string' },
        ]);
      }
      f.sem.putBlockEmbeddings(f.sem.takeEmbedBatch(2000).map(b => ({ ...b,
        vector: new Float32Array(b.docId === 'old' ? [0, 1] : [1, 0]),
      })));
      const r = await semanticSearch(f.ctx, {
        query: 'uniqueneedle', mode: 'semantic', k: 1, docType: 'note', filters: { access: 'public' },
      });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('search failed');
      expect(r.value.results).toEqual([]);
      expect(r.value.limitations).toEqual(['vector_candidate_pool_saturated']);
      const lexical = await semanticSearch(f.ctx, { query: 'uniqueneedle', mode: 'exact', ...scope });
      expect(lexical.ok && lexical.value.results.map(h => h.docId)).toEqual(['old']);
    } finally { f.close(); }
  });

  it('shares multi-value inequality semantics and scopes pending-embedding metadata', async () => {
    const f = scopeFixture(1, { inMemory: true });
    try {
      f.backend.putFieldIndex(docId('old'), [
        { name: 'access', value: 'public', numericValue: null, type: 'string' },
        { name: 'access', value: 'private', numericValue: null, type: 'string' },
      ]);
      const filter = { access: { op: 'neq' as const, value: 'private' } };
      expect(f.backend.findDocuments({ filters: filter })).toEqual([]);
      const r = await semanticSearch(f.ctx, { query: 'uniqueneedle', mode: 'hybrid', filters: filter });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('search failed');
      expect(r.value.results).toEqual([]);
      expect(r.value.limitations).toBeUndefined();
      expect(f.sem.searchFts('uniqueneedle', 10, true, [])).toEqual([]);
    } finally { f.close(); }
  });

  it('reports simultaneous fallback, lexical saturation and pending embeddings', async () => {
    const f = scopeFixture(80, { inMemory: true });
    try {
      vi.spyOn(f.ctx.embeddingProvider!, 'embed').mockRejectedValue(new Error('offline'));
      const r = await semanticSearch(f.ctx, { query: 'routine', mode: 'hybrid', k: 1, ...scope });
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error('search failed');
      expect(r.value.degraded).toBe('embed_failed');
      expect(r.value.limitations).toEqual(['embed_failed', 'lexical_candidate_pool_saturated', 'embeddings_pending']);
      expect(r.value.total).toBe(1);
    } finally { f.close(); }
  });
});
