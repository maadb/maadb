// ============================================================================
// Semantic retrieval — shared types (0.8.0)
// The contract shared by the embedding provider, the sqlite-vec/FTS5 store,
// the async embed worker, and the maad_semantic_search read path.
// ============================================================================

/** Whether a text is being embedded as a stored passage or a search query.
 *  Drives asymmetric model prefixes (e.g. nomic search_document:/search_query:). */
export type EmbedKind = 'document' | 'query';

/** The three retrieval modes of maad_semantic_search. `exact` never touches a model. */
export type SearchMode = 'exact' | 'hybrid' | 'semantic';

/**
 * Pluggable embedding provider. A property of the index (vectors from different
 * models live in incompatible spaces), selected at deploy time via DI or env.
 * The engine never manages API keys — that stays app-tier / env.
 */
export interface EmbeddingProvider {
  /** Stable provider id: 'openai' | 'local' | 'injected' | 'fake'. */
  readonly id: string;
  /** Model identifier, stamped into engine_meta as the vector-space fingerprint. */
  readonly model: string;
  /** Output vector dimension (table width). */
  readonly dim: number;
  /** Embed a batch. `kind` selects the asymmetric prefix where the model needs one. */
  embed(texts: string[], kind: EmbedKind): Promise<Float32Array[]>;
}

/** One block's text snapshot fed into the index at materialize time. */
export interface BlockTextInput {
  blockOrd: number;
  blockId: string | null;
  heading: string;
  text: string;
}

/** A queued block awaiting embedding (text carried so the worker needs no join). */
export interface PendingEmbed {
  docId: string;
  blockOrd: number;
  text: string;
}

/** A computed block embedding ready to upsert into the vector index. */
export interface BlockEmbedding {
  docId: string;
  blockOrd: number;
  vector: Float32Array;
}

/** A vector-index KNN hit. */
export interface VecHit {
  docId: string;
  blockOrd: number;
  distance: number;
}

/** A lexical (FTS5/BM25) hit. `score` is bm25 (more negative = more relevant). */
export interface FtsHit {
  docId: string;
  blockOrd: number;
  heading: string;
  score: number;
  snippet: string;
}

/** Input to maad_semantic_search. */
export interface SemanticSearchQuery {
  query: string;
  mode: SearchMode;
  /** Top results after block→doc rollup (default 10, clamped to MAX_QUERY_LIMIT). */
  k?: number;
  /** Scope filters (same shape as maad_query filters). */
  filters?: Record<string, unknown>;
  /** Scope to a single doc type. */
  docType?: string;
  /** Include snippets (default true). */
  snippet?: boolean;
}

/** One ranked result (a document, represented by its best-matching block). */
export interface SemanticHit {
  docId: string;
  docType: string;
  /** Best-matching block ordinal (locate via maad_get with the heading). */
  blockOrd: number;
  heading: string;
  /** Fused relevance score (RRF for hybrid; rank-based for single-leg). Higher = better. */
  score: number;
  snippet: string;
}

export interface SemanticSearchResult {
  mode: SearchMode;
  total: number;
  results: SemanticHit[];
  /** Set when the requested mode degraded (e.g. 'no_vector_provider' ⇒ lexical fallback). */
  degraded?: string;
}

/** Embedding subsystem stats surfaced via maad_health.embeddings. */
export interface SemanticStats {
  ready: boolean;
  vecReady: boolean;
  model: string | null;
  dim: number | null;
  queueDepth: number;
  embeddedBlocks: number;
  indexedBlocks: number;
  failures: number;
}

/**
 * Engine-facing surface of the per-block vector + lexical index. Implemented by
 * the SQLite/sqlite-vec store; a backend without semantic support returns null
 * from `MaadBackend.semantic()`. All methods are no-ops / empty when not ready.
 */
export interface SemanticIndex {
  /** ext loaded + fts/queue tables present. */
  isReady(): boolean;
  /** vec_blocks table created (embedding dim known). */
  isVecReady(): boolean;
  /** Create/reconcile vec_blocks at `dim`; dim/model change drops vectors + re-enqueues. */
  ensureVecTable(dim: number, model?: string | undefined): void;
  /** Replace a doc's lexical rows + enqueue its blocks for embedding (in caller's txn). */
  putBlockText(docId: string, blocks: BlockTextInput[]): void;
  /** Remove all index rows for a doc (vec + fts + queue). */
  deleteDoc(docId: string): void;
  /** Re-enqueue every indexed block for (re-)embedding; returns count enqueued. */
  enqueueAll(): number;
  /** Pull up to `limit` pending blocks (with text) for the worker. */
  takeEmbedBatch(limit: number): PendingEmbed[];
  /** Upsert computed vectors and clear their queue entries (own short txn). */
  putBlockEmbeddings(rows: BlockEmbedding[]): void;
  /** Vector KNN. */
  searchVec(queryVec: Float32Array, k: number): VecHit[];
  /** Lexical BM25 search. */
  searchFts(query: string, k: number, withSnippet: boolean): FtsHit[];
  /** Resolve a block's heading + text (for semantic-only snippets). */
  getBlockText(docId: string, blockOrd: number): { heading: string; text: string } | null;
  /** Tally embedding failures (surfaced in stats). */
  recordFailure(n: number): void;
  /** Subsystem stats for maad_health. */
  stats(): SemanticStats;
}
