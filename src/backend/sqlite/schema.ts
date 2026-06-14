// ============================================================================
// SQLite Schema
// CREATE TABLE statements and migrations for the MAAD backend.
// ============================================================================

export const SCHEMA_SQL = `
-- Documents table: one row per markdown file
CREATE TABLE IF NOT EXISTS documents (
  doc_id       TEXT PRIMARY KEY,
  doc_type     TEXT NOT NULL,
  schema_ref   TEXT NOT NULL,
  file_path    TEXT NOT NULL UNIQUE,
  file_hash    TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  deleted      INTEGER NOT NULL DEFAULT 0,
  indexed_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT '',
  -- 0.7.12 — engine-stamped creation time. Existing dbs pick it up via
  -- ALTER TABLE in the migration block below; pre-existing rows backfill
  -- to updated_at as the best-available approximation.
  created_at   TEXT NOT NULL DEFAULT '',
  -- 0.7.17 — structural validity at index time (1 = valid, 0 = invalid). Lets
  -- summary() COUNT invalid records instead of re-reading and re-validating
  -- every file per call. Existing rows pick it up via ALTER (default 1) and
  -- self-correct on next reindex.
  valid        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(file_path);
CREATE INDEX IF NOT EXISTS idx_documents_deleted ON documents(deleted);
-- 0.7.17 — composite for the findDocuments driving scan. Without it the planner
-- picks the low-selectivity idx_documents_deleted (deleted=0 matches every live
-- row) and full-scans documents before sorting. Leading deleted keeps the
-- live-rows predicate sargable; doc_type narrows; doc_id covers the tie-breaker.
CREATE INDEX IF NOT EXISTS idx_documents_del_type_id ON documents(deleted, doc_type, doc_id);
-- NB: the idx_documents_valid index lives in the init() migration block, not
-- here. It references the valid column, which existing databases only gain via
-- ALTER after this SCHEMA_SQL runs, so creating it here would fail on
-- pre-0.7.17 databases with a no-such-column error.

-- Extracted objects table: inline annotations and indexed fields
CREATE TABLE IF NOT EXISTS objects (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  primitive        TEXT NOT NULL,
  subtype          TEXT NOT NULL,
  value            TEXT NOT NULL,
  normalized_value TEXT,
  label            TEXT NOT NULL,
  role             TEXT,
  doc_id           TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  source_line      INTEGER NOT NULL,
  block_id         TEXT
);
CREATE INDEX IF NOT EXISTS idx_objects_primitive ON objects(primitive);
CREATE INDEX IF NOT EXISTS idx_objects_subtype ON objects(subtype);
CREATE INDEX IF NOT EXISTS idx_objects_value ON objects(value);
CREATE INDEX IF NOT EXISTS idx_objects_doc_id ON objects(doc_id);
CREATE INDEX IF NOT EXISTS idx_objects_normalized ON objects(normalized_value);

-- Relationships table: edges between documents
CREATE TABLE IF NOT EXISTS relationships (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  source_doc_id   TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  target_doc_id   TEXT NOT NULL,
  field           TEXT NOT NULL,
  relation_type   TEXT NOT NULL CHECK(relation_type IN ('ref', 'mention'))
);
CREATE INDEX IF NOT EXISTS idx_rel_source ON relationships(source_doc_id);
CREATE INDEX IF NOT EXISTS idx_rel_target ON relationships(target_doc_id);
CREATE INDEX IF NOT EXISTS idx_rel_type ON relationships(relation_type);

-- Blocks table: heading-delimited sections
CREATE TABLE IF NOT EXISTS blocks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id       TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  block_id     TEXT,
  heading      TEXT NOT NULL,
  level        INTEGER NOT NULL,
  start_line   INTEGER NOT NULL,
  end_line     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_doc_id ON blocks(doc_id);
CREATE INDEX IF NOT EXISTS idx_blocks_block_id ON blocks(block_id);

-- Field index: denormalized frontmatter fields for fast filtering
CREATE TABLE IF NOT EXISTS field_index (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id        TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  field_name    TEXT NOT NULL,
  field_value   TEXT,
  numeric_value REAL,
  field_type    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_field_doc ON field_index(doc_id);
CREATE INDEX IF NOT EXISTS idx_field_name_value ON field_index(field_name, field_value);
CREATE INDEX IF NOT EXISTS idx_field_name_numeric ON field_index(field_name, numeric_value);
-- 0.7.17 — covering indexes for the sort-index-driven query path. The first two
-- let the engine walk a scalar sort field (text/date -> field_value,
-- number/amount -> numeric_value) in index order with doc_id covered, so a
-- sorted+limited query terminates early instead of materializing + temp-b-tree
-- sorting the whole matched set. The third covers the per-doc EXISTS filter
-- probes (one 4-col index subsumes both text and numeric by-doc lookups, vs two
-- 3-col indexes — half the write amplification).
CREATE INDEX IF NOT EXISTS idx_field_name_value_doc ON field_index(field_name, field_value, doc_id);
CREATE INDEX IF NOT EXISTS idx_field_name_numeric_doc ON field_index(field_name, numeric_value, doc_id);
CREATE INDEX IF NOT EXISTS idx_field_doc_name_value ON field_index(doc_id, field_name, field_value, numeric_value);

-- Engine meta key/value store (0.7.4, fup-2026-093). Holds per-type schema
-- index fingerprints so indexAll can detect "indexed-field set changed since
-- last run" and force-rebuild affected types regardless of file-hash skip.
-- Keys are namespaced (e.g. schema_index_fp:<doc_type>).
CREATE TABLE IF NOT EXISTS engine_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
