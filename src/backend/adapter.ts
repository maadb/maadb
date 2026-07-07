// ============================================================================
// Backend Adapter Interface
// Any backend implementation must satisfy this contract.
// ============================================================================

import type {
  DocId,
  DocType,
  FilePath,
  DocumentRecord,
  DocumentQuery,
  ObjectQuery,
  DocumentMatch,
  ObjectMatch,
  ExtractedObject,
  Relationship,
  ParsedBlock,
  BackendStats,
} from '../types.js';
import type { SemanticIndex } from '../engine/semantic/types.js';

export interface MaadBackend {
  // Lifecycle
  init(): void;
  close(): void;

  // Write operations (called during materialize stage)
  putDocument(doc: DocumentRecord): void;
  putObjects(docId: DocId, objects: ExtractedObject[]): void;
  putRelationships(docId: DocId, relations: Relationship[]): void;
  putBlocks(docId: DocId, blocks: ParsedBlock[]): void;
  putFieldIndex(docId: DocId, fields: Array<{ name: string; value: string; numericValue: number | null; type: string }>): void;

  // Read operations (called by MCP tools)
  getDocument(docId: DocId): DocumentRecord | null;
  getDocumentsByIds(docIds: DocId[]): Map<DocId, DocumentRecord>;
  getDocumentByPath(path: FilePath): DocumentRecord | null;
  findDocuments(query: DocumentQuery): DocumentMatch[];
  countDocuments(query: DocumentQuery): number;
  findObjects(query: ObjectQuery): ObjectMatch[];
  countObjects(query: ObjectQuery): number;
  getRelationships(docId: DocId, direction: 'outgoing' | 'incoming' | 'both'): Relationship[];
  getBlocks(docId: DocId): ParsedBlock[];

  // Projection
  getFieldValues(docIds: DocId[], fieldNames: string[]): Map<string, Record<string, string>>;

  // Aggregation queries
  aggregate(query: import('../engine/types.js').AggregateQuery): import('../engine/types.js').AggregateResult;

  // Changes-since polling delta (0.5.0 R5). Strict deterministic order:
  // (updated_at ASC, doc_id ASC). `cursor` is the exclusive lower bound —
  // returns rows with (updated_at, doc_id) > (cursor.updatedAt, cursor.docId).
  // Excludes deleted rows. Emits `operation = 'create'` when version = 1 and
  // `'update'` otherwise. Deletes are not emitted (see spec §maad_changes_since).
  listChangesSince(opts: {
    cursor: import('../engine/types.js').ChangesSinceParsedCursor | null;
    limit: number;
    docTypes?: string[] | undefined;
  }): Array<{ docId: string; docType: string; updatedAt: string; version: number }>;

  // Aggregation
  getSubtypeInventory(limit: number): Array<{ primitive: string; subtype: string; count: number; topValues: string[] }>;
  getSampleDocIds(docType: DocType, limit: number): DocId[];

  // Maintenance
  removeDocument(docId: DocId): void;
  /**
   * 0.8.1 — mark a row stale without re-materializing the doc: flags it
   * partial and invalidates its stored file_hash so the doc re-indexes (and
   * the flag clears) on the first pass where the file is indexable again.
   * Used when a previously indexed file grows past MAAD_MAX_DOC_BYTES.
   */
  markDocumentStale(docId: DocId): void;
  /**
   * 0.7.17 — refresh SQLite query-planner statistics (`ANALYZE`). Called after
   * a full reindex so the planner has up-to-date selectivity data for the
   * composite field_index indexes; without stats it can fall back to the
   * low-selectivity deleted index and full-scan on sorted queries.
   */
  analyze(): void;
  getFileHash(path: FilePath): string | null;
  getAllFileHashes(): Map<FilePath, string>;
  getStats(): BackendStats;
  countBrokenRefs(): number;
  /**
   * 0.7.17 — count live records flagged invalid at index time (`valid = 0`).
   * Backs summary()'s validation-error warning without re-reading every file,
   * and is uncapped (the prior inline scan silently stopped at 100k docs).
   */
  countInvalidDocuments(): number;
  /**
   * 0.8.1 — count live records flagged partial at index time (`partial = 1`):
   * annotation-capped bodies or over-byte-cap stale rows. Backs summary()'s
   * partialDocs warning.
   */
  countPartialDocuments(): number;

  /**
   * 0.7.10 — return soft-deleted records (`deleted = 1`) whose `updated_at`
   * predates `olderThanIso`. Drives `maad_purge_soft_deleted`. Ordered by
   * updated_at ASC so the oldest soft-deletes purge first. `limit` caps the
   * result set so callers can bound blast radius without scanning the full
   * cemetery; pass a value above the actual count to get everything.
   */
  findSoftDeletedBefore(olderThanIso: string, limit: number): DocumentRecord[];

  /**
   * 0.7.10 P5b — return broken-ref rows for the integrity sweep.
   * One row per (source, target, field) where target is missing or
   * soft-deleted. Drives the verifyIntegrity broken_refs category without
   * re-parsing per-doc frontmatter from disk.
   */
  getBrokenRefs(): Array<{ sourceDocId: string; sourceDocType: string; field: string; targetDocId: string }>;

  // Engine meta key/value (0.7.4 — schema-index fingerprints, future expansion)
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;

  // Semantic retrieval (0.8.0). initSemantic loads the vector/lexical index
  // (sqlite-vec + FTS5) when MAAD_SEMANTIC_ENABLE is on; semantic() exposes it
  // (or null on a backend without semantic support). Both are no-ops/null when
  // the feature is off, keeping the base engine semantic-free.
  initSemantic(cfg: { dim?: number | undefined; model?: string | undefined }): void;
  semantic(): SemanticIndex | null;

  // Batch write (wraps all puts in a transaction for a single document).
  // 0.8.0 — `semanticBlocks` (when provided) populates the per-block semantic
  // index (FTS + embed queue) inside the same transaction. Omitted/undefined
  // when semantic retrieval is off, keeping the base write path unchanged.
  materializeDocument(
    doc: DocumentRecord,
    objects: ExtractedObject[],
    relationships: Relationship[],
    blocks: ParsedBlock[],
    fieldIndex: Array<{ name: string; value: string; numericValue: number | null; type: string }>,
    semanticBlocks?: import('../engine/semantic/types.js').BlockTextInput[],
  ): void;
}
