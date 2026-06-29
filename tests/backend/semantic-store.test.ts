import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteBackend } from '../../src/backend/sqlite/index.js';
import { toFtsMatch } from '../../src/backend/sqlite/semantic-store.js';
import {
  docId,
  docType,
  schemaRef,
  filePath,
  type DocumentRecord,
} from '../../src/types.js';
import type { BlockTextInput, SemanticIndex } from '../../src/engine/semantic/types.js';

let backend: SqliteBackend;

beforeEach(() => {
  backend = new SqliteBackend(':memory:');
  backend.init();
});

afterEach(() => {
  backend.close();
});

function makeDoc(id: string): DocumentRecord {
  return {
    docId: docId(id),
    docType: docType('note'),
    schemaRef: schemaRef('note.v1'),
    filePath: filePath(`notes/${id}.md`),
    fileHash: 'hash_' + id,
    version: 1,
    deleted: false,
    indexedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    valid: true,
  };
}

const blk = (ord: number, heading: string, text: string): BlockTextInput =>
  ({ blockOrd: ord, blockId: heading ? heading.toLowerCase() : null, heading, text });

// Unit vectors in a 4-d space so KNN ordering is easy to reason about.
const vec = (a: number[]): Float32Array => new Float32Array(a);

// Build embeddings for all currently-queued blocks, attaching the real qid (the
// epoch token putBlockEmbeddings requires) from the queue.
function embedQueued(s: SemanticIndex, vectorFor: (docId: string, blockOrd: number) => number[]) {
  return s.takeEmbedBatch(1000).map(b => ({
    qid: b.qid, docId: b.docId, blockOrd: b.blockOrd, vector: vec(vectorFor(b.docId, b.blockOrd)),
  }));
}

describe('SemanticStore', () => {
  describe('toFtsMatch', () => {
    it('tokenizes and ORs, escaping FTS5 syntax', () => {
      expect(toFtsMatch('vector search')).toBe('"vector" OR "search"');
      expect(toFtsMatch('a-b.c')).toBe('"a" OR "b" OR "c"');
    });
    it('returns null for non-searchable input (avoids FTS5 syntax errors)', () => {
      expect(toFtsMatch('   ')).toBeNull();
      expect(toFtsMatch('"" *(')).toBeNull();
    });
  });

  describe('not enabled', () => {
    it('semantic() is null until initSemantic, and reads are absent', () => {
      expect(backend.semantic()).toBeNull();
    });
  });

  describe('round-trip (enabled, dim known)', () => {
    beforeEach(() => {
      backend.initSemantic({ dim: 4, model: 'fake-4' });
      backend.putDocument(makeDoc('note-a'));
    });

    it('is ready and vec-ready', () => {
      const s = backend.semantic()!;
      expect(s.isReady()).toBe(true);
      expect(s.isVecReady()).toBe(true);
    });

    it('populates lexical + queue on putBlockText; bm25 search returns hits', () => {
      const s = backend.semantic()!;
      s.putBlockText('note-a', [
        blk(0, 'Animals', 'the quick brown fox jumps over the lazy dog'),
        blk(1, 'Search', 'semantic retrieval fuses vector and lexical search'),
      ]);
      const fts = s.searchFts('vector OR fox', 10, true);
      expect(fts.length).toBe(2);
      // block_ord comes back as a real number (CAST), not text
      expect(typeof fts[0]!.blockOrd).toBe('number');
      const stats = s.stats();
      expect(stats.indexedBlocks).toBe(2);
      expect(stats.queueDepth).toBe(2);     // both pending embedding
      expect(stats.embeddedBlocks).toBe(0);
    });

    it('worker round-trip: takeEmbedBatch → putBlockEmbeddings → searchVec (ordered) → queue drains', () => {
      const s = backend.semantic()!;
      s.putBlockText('note-a', [
        blk(0, 'X', 'block zero text'),
        blk(1, 'Y', 'block one text'),
      ]);
      const batch = s.takeEmbedBatch(10);
      expect(batch.map(b => b.blockOrd).sort()).toEqual([0, 1]);
      expect(batch.find(b => b.blockOrd === 0)!.text).toBe('block zero text');

      const embeds = batch.map(b => ({
        qid: b.qid, docId: b.docId, blockOrd: b.blockOrd,
        vector: b.blockOrd === 0 ? vec([1, 0, 0, 0]) : vec([0, 1, 0, 0]),
      }));
      s.putBlockEmbeddings(embeds);

      const hits = s.searchVec(vec([1, 0, 0, 0]), 2);
      expect(hits.length).toBe(2);
      expect(hits[0]!.blockOrd).toBe(0);           // nearest is block 0
      expect(hits[0]!.distance).toBeLessThan(hits[1]!.distance);

      const stats = s.stats();
      expect(stats.queueDepth).toBe(0);            // drained
      expect(stats.embeddedBlocks).toBe(2);
    });

    it('epoch guard: a batch superseded by a re-index writes no stale vector', () => {
      const s = backend.semantic()!;
      s.putBlockText('note-a', [blk(0, 'X', 'original text')]);
      const stale = s.takeEmbedBatch(10);          // captures the original row's qid
      // doc re-indexed before the worker writes → row deleted + re-inserted (new qid)
      s.putBlockText('note-a', [blk(0, 'X', 'rewritten text')]);
      // worker resumes with the STALE batch → epoch guard skips the write
      s.putBlockEmbeddings(stale.map(b => ({ qid: b.qid, docId: b.docId, blockOrd: b.blockOrd, vector: vec([1, 0, 0, 0]) })));
      expect(s.stats().embeddedBlocks).toBe(0);    // no stale vector landed
      expect(s.stats().queueDepth).toBe(1);        // fresh row still queued for re-embed
    });

    it('searchFts honors the in-SQL scope filter (scoped recall)', () => {
      backend.putDocument(makeDoc('note-b'));
      const s = backend.semantic()!;
      s.putBlockText('note-a', [blk(0, 'X', 'shared keyword alpha')]);
      s.putBlockText('note-b', [blk(0, 'Y', 'shared keyword beta')]);
      expect(s.searchFts('shared', 10, false).length).toBe(2);                       // unscoped
      const scoped = s.searchFts('shared', 10, false, ['note-a']);
      expect(scoped.map(h => h.docId)).toEqual(['note-a']);                          // scoped in-SQL
    });

    it('getBlockText resolves typed (doc_id, block_ord) — the FTS5 affinity trap', () => {
      const s = backend.semantic()!;
      s.putBlockText('note-a', [blk(0, 'Heading', 'the body text')]);
      const got = s.getBlockText('note-a', 0);
      expect(got).not.toBeNull();
      expect(got!.heading).toBe('Heading');
      expect(got!.text).toBe('the body text');
    });

    it('re-index of a doc replaces its blocks (no stale rows)', () => {
      const s = backend.semantic()!;
      s.putBlockText('note-a', [blk(0, 'Old', 'old content'), blk(1, 'B', 'second')]);
      s.putBlockText('note-a', [blk(0, 'New', 'fresh content')]);
      expect(s.stats().indexedBlocks).toBe(1);
      expect(s.searchFts('old', 10, false).length).toBe(0);
      expect(s.searchFts('fresh', 10, false).length).toBe(1);
    });

    it('deleteDoc clears vec + fts + block_text + queue', () => {
      const s = backend.semantic()!;
      s.putBlockText('note-a', [blk(0, 'X', 'hello world')]);
      s.putBlockEmbeddings(embedQueued(s, () => [1, 0, 0, 0]));
      s.deleteDoc('note-a');
      const stats = s.stats();
      expect(stats.indexedBlocks).toBe(0);
      expect(stats.embeddedBlocks).toBe(0);
      expect(stats.queueDepth).toBe(0);
      expect(s.searchFts('hello', 10, false).length).toBe(0);
    });

    it('hard removeDocument cascades + clears the semantic index', () => {
      const s = backend.semantic()!;
      s.putBlockText('note-a', [blk(0, 'X', 'hello world')]);
      s.putBlockEmbeddings(embedQueued(s, () => [1, 0, 0, 0]));
      backend.removeDocument(docId('note-a'));
      const stats = s.stats();
      expect(stats.indexedBlocks).toBe(0);
      expect(stats.embeddedBlocks).toBe(0);
      expect(stats.queueDepth).toBe(0);
    });
  });

  describe('dim/model mismatch', () => {
    it('dropping + recreating at a new dim re-enqueues every block', () => {
      backend.initSemantic({ dim: 4, model: 'fake-4' });
      backend.putDocument(makeDoc('note-a'));
      const s = backend.semantic()!;
      s.putBlockText('note-a', [blk(0, 'X', 'a'), blk(1, 'Y', 'b')]);
      s.putBlockEmbeddings(embedQueued(s, (_d, ord) => (ord === 0 ? [1, 0, 0, 0] : [0, 1, 0, 0])));
      expect(s.stats().queueDepth).toBe(0);
      expect(s.stats().embeddedBlocks).toBe(2);

      // Provider swap to a different dim → vectors dropped, all blocks re-enqueued.
      s.ensureVecTable(8, 'fake-8');
      const stats = s.stats();
      expect(stats.dim).toBe(8);
      expect(stats.embeddedBlocks).toBe(0);
      expect(stats.queueDepth).toBe(2);
      expect(stats.indexedBlocks).toBe(2);   // text preserved
    });
  });

  describe('lexical-only (vec table not created until dim known)', () => {
    it('fts works before a provider/dim is set; vec is absent', () => {
      backend.initSemantic({});                 // no dim → no vec table yet
      backend.putDocument(makeDoc('note-a'));
      const s = backend.semantic()!;
      expect(s.isReady()).toBe(true);
      expect(s.isVecReady()).toBe(false);
      s.putBlockText('note-a', [blk(0, 'X', 'lexical only works')]);
      expect(s.searchFts('lexical', 10, false).length).toBe(1);
      expect(s.searchVec(vec([1, 0, 0, 0]), 5).length).toBe(0);
      expect(s.stats().embeddedBlocks).toBe(0);
      expect(s.stats().queueDepth).toBe(1);     // queued, awaiting a provider
    });
  });
});
