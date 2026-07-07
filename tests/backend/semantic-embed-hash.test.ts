// ============================================================================
// 0.8.2 — per-block text-hash gating in putBlockText.
//
// Embedding is the expensive leg of the semantic index. Pre-0.8.2,
// putBlockText wholesale-deleted and re-enqueued EVERY block of a doc on any
// reindex, so a one-character edit (or a frontmatter-only change) re-embedded
// the entire document. The store now diffs against per-block text hashes:
// unchanged blocks keep their vectors and never re-enqueue; metadata-only
// changes refresh block_text/FTS but keep the vector; text changes and new
// blocks replace + re-enqueue; removed ords clean all four tables.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteBackend } from '../../src/backend/sqlite/index.js';
import { SemanticStore } from '../../src/backend/sqlite/semantic-store.js';
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
  backend.initSemantic({ dim: 4, model: 'fake-4' });
  backend.putDocument(makeDoc('note-a'));
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

const vec = (a: number[]): Float32Array => new Float32Array(a);

// Embed everything currently queued with a fixed per-ord unit vector.
function drainQueue(s: SemanticIndex): number {
  const batch = s.takeEmbedBatch(1000);
  s.putBlockEmbeddings(batch.map(b => ({
    qid: b.qid,
    docId: b.docId,
    blockOrd: b.blockOrd,
    vector: vec([b.blockOrd === 0 ? 1 : 0, b.blockOrd === 1 ? 1 : 0, b.blockOrd === 2 ? 1 : 0, 0]),
  })));
  return batch.length;
}

const BLOCKS: BlockTextInput[] = [
  blk(0, 'Alpha', 'the quick brown fox'),
  blk(1, 'Beta', 'jumps over the lazy dog'),
  blk(2, 'Gamma', 'and naps in the sun'),
];

describe('putBlockText embed-hash gate', () => {
  it('re-putting identical blocks enqueues nothing and keeps vectors', () => {
    const s = backend.semantic()!;
    s.putBlockText('note-a', BLOCKS);
    expect(drainQueue(s)).toBe(3);

    s.putBlockText('note-a', BLOCKS);
    expect(s.takeEmbedBatch(1000)).toHaveLength(0);
    // Vectors survived — KNN still answers.
    expect(s.searchVec(vec([1, 0, 0, 0]), 1)[0]!.blockOrd).toBe(0);
  });

  it('editing one block re-enqueues only that block; the others keep vectors', () => {
    const s = backend.semantic()!;
    s.putBlockText('note-a', BLOCKS);
    expect(drainQueue(s)).toBe(3);

    const edited = [BLOCKS[0]!, blk(1, 'Beta', 'jumps over the sleepy cat'), BLOCKS[2]!];
    s.putBlockText('note-a', edited);

    const queued = s.takeEmbedBatch(1000);
    expect(queued.map(q => q.blockOrd)).toEqual([1]);
    // Unchanged ords still have their vectors.
    expect(s.searchVec(vec([1, 0, 0, 0]), 1)[0]!.blockOrd).toBe(0);
    expect(s.searchVec(vec([0, 0, 1, 0]), 1)[0]!.blockOrd).toBe(2);
  });

  it('a removed block cleans text, FTS, queue, and vector rows for its ord', () => {
    const s = backend.semantic()!;
    s.putBlockText('note-a', BLOCKS);
    expect(drainQueue(s)).toBe(3);

    s.putBlockText('note-a', [BLOCKS[0]!, BLOCKS[1]!]);
    expect(s.takeEmbedBatch(1000)).toHaveLength(0);
    // Ord 2's vector is gone: nearest to its old unit vector is another block.
    const hits = s.searchVec(vec([0, 0, 1, 0]), 3);
    expect(hits.every(h => h.blockOrd !== 2)).toBe(true);
    // Its FTS row is gone too.
    expect(s.searchFts('naps', 10, false).length).toBe(0);
  });

  it('a heading-only change refreshes FTS but does not re-embed', () => {
    const s = backend.semantic()!;
    s.putBlockText('note-a', BLOCKS);
    expect(drainQueue(s)).toBe(3);

    s.putBlockText('note-a', [blk(0, 'Renamed Alpha', 'the quick brown fox'), BLOCKS[1]!, BLOCKS[2]!]);
    expect(s.takeEmbedBatch(1000)).toHaveLength(0);
    expect(s.searchVec(vec([1, 0, 0, 0]), 1)[0]!.blockOrd).toBe(0);
    expect(s.searchFts('Renamed', 10, false).some(h => h.blockOrd === 0)).toBe(true);
  });

  it('a pending queue row for an unchanged block survives (failed-embed retry)', () => {
    const s = backend.semantic()!;
    s.putBlockText('note-a', BLOCKS);
    // Nothing drained — simulate the embed provider having failed.
    s.putBlockText('note-a', BLOCKS);
    // All three still pending, not duplicated.
    expect(s.takeEmbedBatch(1000)).toHaveLength(3);
  });

  it('pre-0.8.2 rows (NULL text_hash) re-embed once, then gate normally', () => {
    // Standalone store over a raw handle so the test can plant a legacy row.
    const db = new Database(':memory:');
    db.exec('CREATE TABLE documents (doc_id TEXT PRIMARY KEY)');
    db.prepare('INSERT INTO documents(doc_id) VALUES (?)').run('note-b');
    const store = new SemanticStore(db);
    store.init({ dim: 4, model: 'fake-4' });
    expect(store.isReady()).toBe(true);

    // Legacy row: no text_hash (as written by 0.8.0/0.8.1).
    db.prepare(
      'INSERT INTO block_text(doc_id, block_ord, block_id, heading, text) VALUES (?, ?, ?, ?, ?)',
    ).run('note-b', 0, 'alpha', 'Alpha', 'the quick brown fox');

    // Same content: NULL hash reads as changed → replaced + enqueued once...
    store.putBlockText('note-b', [blk(0, 'Alpha', 'the quick brown fox')]);
    expect(store.takeEmbedBatch(1000)).toHaveLength(1);
    // ...and the healed hash gates the next identical put.
    store.putBlockText('note-b', [blk(0, 'Alpha', 'the quick brown fox')]);
    expect(store.takeEmbedBatch(1000)).toHaveLength(1); // same pending row, not a new one
    db.close();
  });
});
