// ============================================================================
// Semantic store (0.8.0) — sqlite-vec vector index + FTS5 lexical index, both
// per-block. Owns the loadable-extension lifecycle and all vec/fts/queue SQL.
// Isolated from SqliteBackend so the base engine carries zero semantic surface
// when MAAD_SEMANTIC_ENABLE is off (this module is only constructed then).
//
// Four tables (all keyed by (doc_id, block_ord), block_ord = index in the
// parsed block list — block_id is nullable/non-unique so is NOT a key):
//   block_text  — typed, persistent per-block text store (FK CASCADE). The
//                 worker's embed source and the snippet source. FTS5 columns
//                 have no affinity (everything stored as text), so a typed
//                 (doc_id, block_ord) lookup must NOT go through fts_blocks.
//   fts_blocks  — FTS5 lexical leg (BM25). Read-only output is CAST back to int.
//   embed_queue — pending-embed markers (FK CASCADE) for crash-resume.
//   vec_blocks  — sqlite-vec vectors (virtual; explicit delete, no FK CASCADE).
// ============================================================================

import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import type { Database as DatabaseType } from 'better-sqlite3';
import { logger } from '../../engine/logger.js';
import type {
  SemanticIndex,
  SemanticStats,
  BlockTextInput,
  PendingEmbed,
  BlockEmbedding,
  VecHit,
  FtsHit,
} from '../../engine/semantic/types.js';

const MAX_DIM = 8192;

// engine_meta fingerprint keys — vectors are only comparable within one space.
const META_DIM = 'embed_dim';
const META_MODEL = 'embed_model';

const BLOCK_TEXT_DDL =
  `CREATE TABLE IF NOT EXISTS block_text (` +
  `doc_id TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE, ` +
  `block_ord INTEGER NOT NULL, ` +
  `block_id TEXT, ` +
  `heading TEXT NOT NULL, ` +
  `text TEXT NOT NULL, ` +
  // 0.8.2 — content hash of `text`, the re-embed gate. Nullable: pre-0.8.2
  // rows migrate in with NULL and re-embed once on their next touch.
  `text_hash TEXT, ` +
  `PRIMARY KEY (doc_id, block_ord))`;

// FTS5 lexical leg. doc_id/block_ord are UNINDEXED carry-back columns; FTS5
// stores them as text, so reads CAST block_ord back to INTEGER.
const FTS_DDL =
  `CREATE VIRTUAL TABLE IF NOT EXISTS fts_blocks ` +
  `USING fts5(text, heading, doc_id UNINDEXED, block_ord UNINDEXED)`;

// Pending-embed markers (no text — the worker joins block_text). FK CASCADE
// cleans it on hard delete. `id` is AUTOINCREMENT (never reused, even after the
// table empties) so it serves as the worker's epoch token: a re-queued block
// gets a strictly-new id, so a stale in-flight batch's id no longer matches.
const QUEUE_DDL =
  `CREATE TABLE IF NOT EXISTS embed_queue (` +
  `id INTEGER PRIMARY KEY AUTOINCREMENT, ` +
  `doc_id TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE, ` +
  `block_ord INTEGER NOT NULL, ` +
  `UNIQUE (doc_id, block_ord))`;
const QUEUE_IDX = `CREATE INDEX IF NOT EXISTS idx_embed_queue_doc ON embed_queue(doc_id)`;

/** Raw little-endian float32 BLOB — the form sqlite-vec binds. */
function vecToBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

/**
 * Turn arbitrary user text into a safe FTS5 MATCH expression: tokenize on
 * non-alphanumerics, quote each token (FTS5 phrase, double-quotes escaped),
 * OR them together. Returns null when nothing searchable remains — callers
 * then short-circuit to an empty result instead of risking an FTS5 syntax error.
 */
export function toFtsMatch(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/** Loads a sqlite-vec extension into a better-sqlite3 handle. */
export type VecExtensionLoader = (db: DatabaseType) => void;

// Default loader: lazily require sqlite-vec (an optionalDependency) at init time,
// NOT as a static top-level import, so the engine boots even when the package is
// absent — the require throws, SemanticStore.init catches it, and semantic
// retrieval stays disabled. sqlite-vec ships CommonJS, so createRequire resolves it.
const nodeRequire = createRequire(import.meta.url);
const defaultVecLoader: VecExtensionLoader = (db) => {
  const mod = nodeRequire('sqlite-vec') as { load(db: DatabaseType): void };
  mod.load(db);
};

export class SemanticStore implements SemanticIndex {
  private readonly db: DatabaseType;
  private readonly loadVec: VecExtensionLoader;
  private ready = false;
  private vecReady = false;
  private dim: number | null = null;
  private failures = 0;

  constructor(db: DatabaseType, loadVec: VecExtensionLoader = defaultVecLoader) {
    this.db = db;
    this.loadVec = loadVec;
  }

  /**
   * Load sqlite-vec and create the text/lexical/queue tables. Fails OPEN: if the
   * extension can't load, semantic retrieval stays disabled but the engine is
   * untouched (never bricks an existing install). The vec table is created here
   * when `dim` is known (provider present), else lazily via ensureVecTable.
   */
  init(cfg: { dim?: number | undefined; model?: string | undefined }): void {
    // Fail OPEN across the whole bring-up: a failure loading the extension OR
    // creating the lexical/queue tables (e.g. a partially-broken sqlite-vec
    // install, or a SQLite without FTS5) disables semantic retrieval rather than
    // throwing out of MaadEngine.init().
    try {
      this.loadVec(this.db);
      this.db.exec(BLOCK_TEXT_DDL);
      this.db.exec(FTS_DDL);
      this.db.exec(QUEUE_DDL);
      this.db.exec(QUEUE_IDX);
      // 0.8.2 — add text_hash to pre-0.8.2 block_text tables. NULL rows hash
      // as "changed" on next touch and heal to hashed form.
      const cols = this.db.pragma('table_info(block_text)') as Array<{ name: string }>;
      if (!cols.some(c => c.name === 'text_hash')) {
        this.db.exec('ALTER TABLE block_text ADD COLUMN text_hash TEXT');
      }
      this.ready = true;
    } catch (e) {
      logger.degraded('engine', 'semantic_init_failed',
        `sqlite-vec/FTS5 unavailable; semantic retrieval disabled: ${(e as Error).message}`);
      this.ready = false;
      return;
    }
    // The vector table is best-effort: if vec0 creation throws (broken extension),
    // keep the lexical leg — `exact` search still works — and disable vectors.
    if (cfg.dim !== undefined) {
      try {
        this.ensureVecTable(cfg.dim, cfg.model);
      } catch (e) {
        logger.degraded('engine', 'semantic_vec_init_failed',
          `vector index unavailable; lexical-only semantic retrieval: ${(e as Error).message}`);
        this.vecReady = false;
      }
    }
  }

  isReady(): boolean { return this.ready; }
  isVecReady(): boolean { return this.vecReady; }

  ensureVecTable(dim: number, model?: string | undefined): void {
    if (!this.ready) return;
    if (!Number.isInteger(dim) || dim <= 0 || dim > MAX_DIM) {
      throw new Error(`Invalid embedding dim ${dim} (must be an integer in 1..${MAX_DIM})`);
    }
    const storedDim = this.getMeta(META_DIM);
    const storedModel = this.getMeta(META_MODEL);
    const dimChanged = storedDim !== null && Number(storedDim) !== dim;
    const modelChanged = storedModel !== null && model !== undefined && storedModel !== model;
    const exists = this.tableExists('vec_blocks');

    if (exists && (dimChanged || modelChanged)) {
      // Provider/dim swap → stored vectors live in an incompatible space. Drop
      // them and re-enqueue every block so the worker rebuilds at the new dim.
      this.db.exec('DROP TABLE IF EXISTS vec_blocks');
      this.createVecTable(dim);
      const enq = this.enqueueAll();
      logger.degraded('engine', 'semantic_reembed',
        `embedding space changed (dim ${storedDim ?? '?'}→${dim}, model ${storedModel ?? '?'}→${model ?? '?'}); ` +
        `re-enqueued ${enq} blocks for re-embedding`);
    } else if (!exists) {
      this.createVecTable(dim);
    }

    this.dim = dim;
    this.vecReady = true;
    this.setMeta(META_DIM, String(dim));
    if (model !== undefined) this.setMeta(META_MODEL, model);
  }

  private createVecTable(dim: number): void {
    // dim is validated integer (provider.dim) — safe to interpolate.
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS vec_blocks ` +
      `USING vec0(doc_id TEXT, block_ord INTEGER, embedding float[${dim}])`);
  }

  putBlockText(docId: string, blocks: BlockTextInput[]): void {
    if (!this.ready) return;
    // 0.8.2 — diff against the stored per-block text hashes instead of
    // wholesale delete + re-enqueue. Embedding is the expensive leg (network/
    // model-bound); pre-0.8.2 ANY reindex of a doc re-embedded EVERY block,
    // so a one-character edit — or a frontmatter-only change — paid the full
    // re-embed cost. Now:
    //   unchanged block  → untouched (vector kept, no queue row added; a
    //                      pending queue row from an earlier failed embed
    //                      survives and retries)
    //   metadata change  → block_text/FTS rows refreshed, vector kept
    //   text change/new  → replaced + re-enqueued (fresh AUTOINCREMENT id =
    //                      the worker's epoch token, as before)
    //   removed ord      → all four tables cleaned for that ord
    const existing = new Map(
      (this.db.prepare(
        'SELECT block_ord AS ord, block_id AS blockId, heading, text_hash AS hash FROM block_text WHERE doc_id = ?',
      ).all(docId) as Array<{ ord: number; blockId: string | null; heading: string; hash: string | null }>)
        .map(r => [r.ord, r]),
    );

    const delText = this.db.prepare('DELETE FROM block_text WHERE doc_id = ? AND block_ord = ?');
    const delFts = this.db.prepare('DELETE FROM fts_blocks WHERE doc_id = ? AND block_ord = ?');
    const delQ = this.db.prepare('DELETE FROM embed_queue WHERE doc_id = ? AND block_ord = ?');
    // block_ord is a vec0 INTEGER metadata column — must bind as BigInt.
    const delVec = this.vecReady
      ? this.db.prepare('DELETE FROM vec_blocks WHERE doc_id = ? AND block_ord = ?')
      : null;
    const insText = this.db.prepare(
      'INSERT INTO block_text(doc_id, block_ord, block_id, heading, text, text_hash) VALUES (?, ?, ?, ?, ?, ?)');
    const updTextMeta = this.db.prepare(
      'UPDATE block_text SET block_id = ?, heading = ? WHERE doc_id = ? AND block_ord = ?');
    const insFts = this.db.prepare(
      'INSERT INTO fts_blocks(text, heading, doc_id, block_ord) VALUES (?, ?, ?, ?)');
    const insQ = this.db.prepare(
      'INSERT INTO embed_queue(doc_id, block_ord) VALUES (?, ?)');

    const incomingOrds = new Set(blocks.map(b => b.blockOrd));
    for (const [ord] of existing) {
      if (incomingOrds.has(ord)) continue;
      delText.run(docId, ord);
      delFts.run(docId, ord);
      delQ.run(docId, ord);
      delVec?.run(docId, BigInt(ord));
    }

    for (const b of blocks) {
      const hash = createHash('sha256').update(b.text).digest('hex').slice(0, 32);
      const prev = existing.get(b.blockOrd);
      if (prev && prev.hash === hash) {
        // Text unchanged — the vector stays valid, nothing re-enqueues.
        if (prev.blockId !== b.blockId || prev.heading !== b.heading) {
          updTextMeta.run(b.blockId, b.heading, docId, b.blockOrd);
          // FTS indexes heading — refresh via delete+insert (contentless-safe).
          delFts.run(docId, b.blockOrd);
          insFts.run(b.text, b.heading, docId, b.blockOrd);
        }
        continue;
      }
      if (prev) {
        delText.run(docId, b.blockOrd);
        delFts.run(docId, b.blockOrd);
        delQ.run(docId, b.blockOrd);
        delVec?.run(docId, BigInt(b.blockOrd));
      }
      insText.run(docId, b.blockOrd, b.blockId, b.heading, b.text, hash);
      insFts.run(b.text, b.heading, docId, b.blockOrd);
      insQ.run(docId, b.blockOrd);
    }
  }

  deleteDoc(docId: string): void {
    if (!this.ready) return;
    this.db.prepare('DELETE FROM block_text WHERE doc_id = ?').run(docId);
    this.db.prepare('DELETE FROM fts_blocks WHERE doc_id = ?').run(docId);
    this.db.prepare('DELETE FROM embed_queue WHERE doc_id = ?').run(docId);
    if (this.vecReady) this.db.prepare('DELETE FROM vec_blocks WHERE doc_id = ?').run(docId);
  }

  enqueueAll(): number {
    if (!this.ready) return 0;
    const res = this.db.prepare(
      'INSERT OR IGNORE INTO embed_queue(doc_id, block_ord) ' +
      'SELECT doc_id, block_ord FROM block_text').run();
    return res.changes;
  }

  takeEmbedBatch(limit: number): PendingEmbed[] {
    if (!this.ready) return [];
    return this.db.prepare(
      'SELECT q.id AS qid, q.doc_id AS docId, q.block_ord AS blockOrd, t.text AS text ' +
      'FROM embed_queue q JOIN block_text t ' +
      'ON t.doc_id = q.doc_id AND t.block_ord = q.block_ord ' +
      'LIMIT ?',
    ).all(limit) as PendingEmbed[];
  }

  putBlockEmbeddings(rows: BlockEmbedding[]): void {
    if (!this.vecReady || rows.length === 0) return;
    const delQ = this.db.prepare('DELETE FROM embed_queue WHERE id = ?');
    const delVec = this.db.prepare('DELETE FROM vec_blocks WHERE doc_id = ? AND block_ord = ?');
    const insVec = this.db.prepare(
      'INSERT INTO vec_blocks(doc_id, block_ord, embedding) VALUES (?, ?, ?)');
    const txn = this.db.transaction((rs: BlockEmbedding[]) => {
      for (const r of rs) {
        // Epoch guard: only write the vector if THIS queue row still exists. If
        // the block was re-queued during the embed await (putBlockText deletes +
        // re-inserts with a new rowid), this delete removes 0 rows → skip the
        // stale vector and leave the fresh row for the rerun to re-embed.
        if (delQ.run(r.qid).changes !== 1) continue;
        // block_ord is a vec0 INTEGER metadata column — must bind as BigInt.
        const ord = BigInt(r.blockOrd);
        delVec.run(r.docId, ord);
        insVec.run(r.docId, ord, vecToBlob(r.vector));
      }
    });
    txn(rows);
  }

  searchVec(queryVec: Float32Array, k: number): VecHit[] {
    if (!this.vecReady) return [];
    return this.db.prepare(
      'SELECT doc_id AS docId, block_ord AS blockOrd, distance ' +
      'FROM vec_blocks WHERE embedding MATCH ? AND k = ? ORDER BY distance',
    ).all(vecToBlob(queryVec), k) as VecHit[];
  }

  searchFts(query: string, k: number, withSnippet: boolean, scopeDocIds?: readonly string[]): FtsHit[] {
    if (!this.ready) return [];
    const match = toFtsMatch(query);
    if (match === null) return [];
    const snipCol = withSnippet
      ? `snippet(fts_blocks, 0, '', '', '…', 16) AS snippet`
      : `'' AS snippet`;
    // Optional in-SQL scope filter on the UNINDEXED doc_id column so the LIMIT
    // selects the top-k IN-SCOPE blocks (not the global top-k then post-filtered).
    const params: unknown[] = [match];
    let scopeClause = '';
    if (scopeDocIds && scopeDocIds.length > 0) {
      scopeClause = ` AND doc_id IN (${scopeDocIds.map(() => '?').join(', ')})`;
      params.push(...scopeDocIds);
    }
    params.push(k);
    // block_ord is an FTS5 (affinity-less) column → CAST back to INTEGER.
    return this.db.prepare(
      `SELECT doc_id AS docId, CAST(block_ord AS INTEGER) AS blockOrd, heading, ` +
      `bm25(fts_blocks) AS score, ${snipCol} ` +
      `FROM fts_blocks WHERE fts_blocks MATCH ?${scopeClause} ORDER BY score LIMIT ?`,
    ).all(...params) as FtsHit[];
  }

  getBlockText(docId: string, blockOrd: number): { heading: string; text: string } | null {
    if (!this.ready) return null;
    const row = this.db.prepare(
      'SELECT heading, text FROM block_text WHERE doc_id = ? AND block_ord = ?',
    ).get(docId, blockOrd) as { heading: string; text: string } | undefined;
    return row ?? null;
  }

  recordFailure(n: number): void {
    this.failures += n;
  }

  stats(): SemanticStats {
    if (!this.ready) {
      return { ready: false, vecReady: false, model: null, dim: null,
        queueDepth: 0, embeddedBlocks: 0, indexedBlocks: 0, failures: this.failures };
    }
    const count = (sql: string): number =>
      (this.db.prepare(sql).get() as { c: number }).c;
    return {
      ready: true,
      vecReady: this.vecReady,
      model: this.getMeta(META_MODEL),
      dim: this.dim,
      queueDepth: count('SELECT COUNT(*) AS c FROM embed_queue'),
      embeddedBlocks: this.vecReady ? count('SELECT COUNT(*) AS c FROM vec_blocks') : 0,
      indexedBlocks: count('SELECT COUNT(*) AS c FROM block_text'),
      failures: this.failures,
    };
  }

  // --- engine_meta helpers (shared k/v table, created in base SCHEMA_SQL) -----

  private getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM engine_meta WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO engine_meta (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  private tableExists(name: string): boolean {
    const row = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(name) as { name: string } | undefined;
    return row !== undefined;
  }
}
