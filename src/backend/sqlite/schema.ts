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
  frontmatter  TEXT NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0,
  indexed_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(file_path);
CREATE INDEX IF NOT EXISTS idx_documents_deleted ON documents(deleted);

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
  end_line     INTEGER NOT NULL,
  content      TEXT NOT NULL DEFAULT ''
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
`;
