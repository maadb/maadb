// ============================================================================
// SQLite Backend Implementation
// Implements MaadBackend using better-sqlite3 with WAL mode.
// ============================================================================

import Database from 'better-sqlite3';
import { existsSync, readFileSync, statSync } from 'node:fs';
import type { Database as DatabaseType } from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';
import type { MaadBackend } from '../adapter.js';
import { SemanticStore } from './semantic-store.js';
import type { SemanticIndex } from '../../engine/semantic/types.js';
import {
  docId as toDocId,
  docType as toDocType,
  schemaRef as toSchemaRef,
  filePath as toFilePath,
  blockId as toBlockId,
  resolveSystemSortKey,
  type DocId,
  type DocType,
  type FilePath,
  type DocumentRecord,
  type DocumentQuery,
  type ObjectQuery,
  type DocumentMatch,
  type ObjectMatch,
  type ExtractedObject,
  type Relationship,
  type ParsedBlock,
  type BackendStats,
  type FilterCondition,
} from '../../types.js';
import type { AggregateQuery, AggregateResult } from '../../engine/types.js';

export class SqliteBackend implements MaadBackend {
  private db: DatabaseType;
  // 0.8.0 — constructed only when MAAD_SEMANTIC_ENABLE is on (via initSemantic);
  // null otherwise so the base engine carries no semantic surface.
  private semanticStore: SemanticStore | null = null;
  // 0.8.0 — flips on close() so an async read (e.g. semantic search resuming
  // after a query-embed await) can detect a concurrent reload closed the backend
  // out from under it, instead of throwing a raw "database is not open" error.
  private closed = false;

  constructor(dbPath: string, opts?: { readOnly?: boolean }) {
    // better-sqlite3's filesystem readonly open still participates in WAL and
    // can create -shm/-wal companions. Deserialize a byte snapshot in memory
    // instead: representative reads touch no project file or SQLite page.
    if (opts?.readOnly) {
      const walPath = `${dbPath}-wal`;
      if (existsSync(walPath) && statSync(walPath).size > 0) {
        throw new Error('Database has an uncheckpointed WAL; open it read-write once to recover before read-only use');
      }
      const snapshot = Buffer.from(readFileSync(dbPath));
      if (snapshot.length < 20 || snapshot.subarray(0, 16).toString('ascii') !== 'SQLite format 3\0') {
        throw new Error('Backend is not a valid SQLite database');
      }
      // A clean WAL database still carries WAL read/write version bytes in its
      // header, which makes a standalone buffer try to open filesystem WAL
      // companions. Modify only the private snapshot header to rollback mode.
      snapshot[18] = 1;
      snapshot[19] = 1;
      this.db = new Database(snapshot);
    } else {
      this.db = new Database(dbPath);
    }
  }

  /** Validate an existing database without executing pragmas, DDL, or migrations. */
  initReadOnly(): void {
    const required = new Set(['doc_id', 'doc_type', 'schema_ref', 'file_path', 'file_hash', 'version', 'deleted', 'indexed_at', 'updated_at', 'created_at', 'valid', 'partial']);
    const cols = this.db.pragma('table_info(documents)') as Array<{ name: string }>;
    for (const col of cols) required.delete(col.name);
    if (required.size > 0) {
      throw new Error(`Database requires migration before read-only use; missing columns: ${[...required].join(', ')}`);
    }
  }

  init(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA_SQL);

    // Migration: add updated_at column to existing databases
    const cols = this.db.pragma('table_info(documents)') as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'updated_at')) {
      this.db.exec("ALTER TABLE documents ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
    }

    // 0.7.12 — add created_at column. Existing rows backfill to updated_at
    // as the best-available approximation (real creation time wasn't captured
    // pre-0.7.12). Net-new databases skip the ALTER and start with the column
    // already present from SCHEMA_SQL.
    if (!cols.some(c => c.name === 'created_at')) {
      this.db.exec("ALTER TABLE documents ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
      this.db.exec("UPDATE documents SET created_at = updated_at WHERE created_at = ''");
    }

    // 0.7.17 — add valid column. Existing rows default to 1 (valid) and
    // self-correct to their true index-time validity on the next reindex.
    if (!cols.some(c => c.name === 'valid')) {
      this.db.exec("ALTER TABLE documents ADD COLUMN valid INTEGER NOT NULL DEFAULT 1");
    }

    // 0.8.1 — add partial column (annotation-capped or over-byte-cap stale
    // rows). Existing rows default to 0 and self-correct on the next reindex.
    if (!cols.some(c => c.name === 'partial')) {
      this.db.exec("ALTER TABLE documents ADD COLUMN partial INTEGER NOT NULL DEFAULT 0");
    }
    // Created here, after the column is guaranteed present (fresh DBs get it
    // from SCHEMA_SQL's CREATE TABLE; existing DBs from the ALTER above) — it
    // cannot live in SCHEMA_SQL, which runs before this migration.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_documents_valid ON documents(valid, deleted)');
  }

  close(): void {
    this.closed = true;
    this.db.close();
  }

  // --- Write operations ----------------------------------------------------

  putDocument(doc: DocumentRecord): void {
    // 0.8.1 — targeted upsert on doc_id, replacing INSERT OR REPLACE. REPLACE
    // resolves on ANY unique constraint: a file_path conflict with a DIFFERENT
    // doc_id silently deleted that other doc's row and CASCADE-wiped its
    // objects/relationships/blocks/field_index. With ON CONFLICT(doc_id) a
    // path collision now raises SQLITE_CONSTRAINT instead of destroying data —
    // the indexer resolves legitimate cases (doc_id renamed in place) before
    // calling here, so a throw means a real collision that must surface.
    this.db.prepare(`
      INSERT INTO documents
        (doc_id, doc_type, schema_ref, file_path, file_hash, version, deleted, indexed_at, updated_at, created_at, valid, partial)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(doc_id) DO UPDATE SET
        doc_type = excluded.doc_type,
        schema_ref = excluded.schema_ref,
        file_path = excluded.file_path,
        file_hash = excluded.file_hash,
        version = excluded.version,
        deleted = excluded.deleted,
        indexed_at = excluded.indexed_at,
        updated_at = excluded.updated_at,
        created_at = excluded.created_at,
        valid = excluded.valid,
        partial = excluded.partial
    `).run(
      doc.docId as string,
      doc.docType as string,
      doc.schemaRef as string,
      doc.filePath as string,
      doc.fileHash,
      doc.version,
      doc.deleted ? 1 : 0,
      doc.indexedAt,
      // 0.8.1 — explicit '' coalesce. INSERT OR REPLACE silently substituted
      // the column DEFAULT for a NOT NULL violation; the targeted upsert does
      // not, so callers that never populated these get the same '' explicitly.
      doc.updatedAt ?? '',
      doc.createdAt ?? '',
      // 0.7.17 — undefined (callers that don't compute validity) is treated as
      // valid so the column never blocks a write; the indexer always sets it.
      doc.valid === false ? 0 : 1,
      doc.partial === true ? 1 : 0,
    );
  }

  putObjects(docId: DocId, objects: ExtractedObject[]): void {
    this.db.prepare('DELETE FROM objects WHERE doc_id = ?').run(docId as string);

    const insert = this.db.prepare(`
      INSERT INTO objects
        (primitive, subtype, value, normalized_value, label, role, doc_id, source_line, block_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const obj of objects) {
      const normalizedStr = obj.normalizedValue !== null && obj.normalizedValue !== undefined
        ? (typeof obj.normalizedValue === 'object' ? JSON.stringify(obj.normalizedValue) : String(obj.normalizedValue))
        : null;

      insert.run(
        obj.primitive,
        obj.subtype,
        obj.value,
        normalizedStr,
        obj.label,
        obj.role,
        obj.docId as string,
        obj.location.line,
        obj.blockId as string | null,
      );
    }
  }

  putRelationships(docId: DocId, relations: Relationship[]): void {
    this.db.prepare('DELETE FROM relationships WHERE source_doc_id = ?').run(docId as string);

    const insert = this.db.prepare(`
      INSERT INTO relationships (source_doc_id, target_doc_id, field, relation_type)
      VALUES (?, ?, ?, ?)
    `);

    for (const rel of relations) {
      insert.run(
        rel.sourceDocId as string,
        rel.targetDocId as string,
        rel.field,
        rel.relationType,
      );
    }
  }

  putBlocks(docId: DocId, blocks: ParsedBlock[]): void {
    this.db.prepare('DELETE FROM blocks WHERE doc_id = ?').run(docId as string);

    const insert = this.db.prepare(`
      INSERT INTO blocks (doc_id, block_id, heading, level, start_line, end_line)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const block of blocks) {
      insert.run(
        docId as string,
        block.id as string | null,
        block.heading,
        block.level,
        block.startLine,
        block.endLine,
      );
    }
  }

  putFieldIndex(docId: DocId, fields: Array<{ name: string; value: string; numericValue: number | null; type: string }>): void {
    this.db.prepare('DELETE FROM field_index WHERE doc_id = ?').run(docId as string);

    const insert = this.db.prepare(`
      INSERT INTO field_index (doc_id, field_name, field_value, numeric_value, field_type)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const f of fields) {
      insert.run(docId as string, f.name, f.value, f.numericValue, f.type);
    }
  }

  materializeDocument(
    doc: DocumentRecord,
    objects: ExtractedObject[],
    relationships: Relationship[],
    blocks: ParsedBlock[],
    fieldIndex: Array<{ name: string; value: string; numericValue: number | null; type: string }>,
    semanticBlocks?: import('../../engine/semantic/types.js').BlockTextInput[],
  ): void {
    const txn = this.db.transaction(() => {
      this.putDocument(doc);
      this.putObjects(doc.docId, objects);
      this.putRelationships(doc.docId, relationships);
      this.putBlocks(doc.docId, blocks);
      this.putFieldIndex(doc.docId, fieldIndex);
      // 0.8.0 — atomically (re)populate the per-block semantic index. putBlockText
      // is a no-op if the store isn't ready; passing [] still clears stale rows.
      if (semanticBlocks !== undefined) {
        this.semanticStore?.putBlockText(doc.docId as string, semanticBlocks);
      }
    });
    txn();
  }

  // --- Read operations -----------------------------------------------------

  getDocument(docId: DocId): DocumentRecord | null {
    const row = this.db.prepare(
      'SELECT * FROM documents WHERE doc_id = ? AND deleted = 0',
    ).get(docId as string) as RawDocRow | undefined;

    return row ? rowToDocument(row) : null;
  }

  getDocumentsByIds(docIds: DocId[]): Map<DocId, DocumentRecord> {
    const map = new Map<DocId, DocumentRecord>();
    if (docIds.length === 0) return map;

    const placeholders = docIds.map(() => '?').join(', ');
    const rows = this.db.prepare(
      `SELECT * FROM documents WHERE doc_id IN (${placeholders}) AND deleted = 0`,
    ).all(...docIds.map(id => id as string)) as RawDocRow[];

    for (const row of rows) {
      const doc = rowToDocument(row);
      map.set(doc.docId, doc);
    }
    return map;
  }

  getDocumentByPath(path: FilePath): DocumentRecord | null {
    const original = path as string;
    const stmt = this.db.prepare(
      'SELECT * FROM documents WHERE file_path = ? AND deleted = 0',
    );
    let row = stmt.get(original) as RawDocRow | undefined;
    // 0.7.12 — separator-tolerant lookup for the file_path canonicalization
    // transition. Write-path emits forward-slash going forward, but legacy
    // rows on Windows-written databases may still have backslash form until
    // their next reindex touch (lazy migration). If the input form misses,
    // try the alternate-separator form once before declaring missing. Cost:
    // one extra query per miss during transition, zero in steady state.
    if (!row) {
      const alt = original.includes('\\')
        ? original.replaceAll('\\', '/')
        : original.includes('/')
          ? original.replaceAll('/', '\\')
          : null;
      if (alt !== null) {
        row = stmt.get(alt) as RawDocRow | undefined;
      }
    }

    return row ? rowToDocument(row) : null;
  }

  private buildDocQuery(query: DocumentQuery): { where: string; params: unknown[] } {
    const conditions: string[] = ['d.deleted = 0'];
    const params: unknown[] = [];

    if (query.docType) {
      conditions.push('d.doc_type = ?');
      params.push(query.docType as string);
    }

    if (query.filters) {
      for (const [field, condition] of Object.entries(query.filters)) {
        applyFieldFilters(field, condition, conditions, params);
      }
    }

    return { where: conditions.join(' AND '), params };
  }

  findDocuments(query: DocumentQuery): DocumentMatch[] {
    // 0.7.17 — scalar schema-field sort takes the sort-index-driven fast path:
    // walk the sort field's field_index in order, gate rows with EXISTS filter
    // probes, and stop at LIMIT (no full materialize + temp-b-tree sort). System
    // sort keys and list schema fields fall through to the aggregate path below.
    if (query.sortBy && resolveSystemSortKey(query.sortBy) === null && !query.sortListField) {
      return this.findDocumentsScalarSorted(query);
    }
    const { where, params } = this.buildDocQuery(query);
    // 0.7.12 — sort resolution. Engine layer validates sortBy as either a
    // system sort key or an indexed schema field before we get here. Backend
    // emits direct-column ORDER BY for system keys and the field_index
    // subquery for schema fields. Deterministic tie-breaker on doc_id in the
    // same direction so identical primary-sort values don't shuffle.
    let orderClause: string;
    const dir = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
    if (query.sortBy) {
      const systemColumn = resolveSystemSortKey(query.sortBy);
      if (systemColumn) {
        if (systemColumn === 'doc_id') {
          orderClause = `ORDER BY d.doc_id ${dir}`;
        } else {
          orderClause = `ORDER BY d.${systemColumn} ${dir}, d.doc_id ${dir}`;
        }
      } else {
        // Schema field — parameterized to prevent injection. Tie-breaker on doc_id.
        // Numeric fields (number/amount, flagged by the engine via sortNumeric)
        // order on numeric_value so 9 < 100; everything else on the TEXT column.
        // MIN/MAX aggregate makes the sort key deterministic for list fields
        // (one field_index row per item): ASC keys on the smallest item, DESC
        // on the largest, instead of an arbitrary row.
        const sortCol = query.sortNumeric ? 'fi.numeric_value' : 'fi.field_value';
        const agg = dir === 'ASC' ? 'MIN' : 'MAX';
        orderClause = `ORDER BY (SELECT ${agg}(${sortCol}) FROM field_index fi WHERE fi.doc_id = d.doc_id AND fi.field_name = ?) ${dir}, d.doc_id ${dir}`;
        params.push(query.sortBy);
      }
    } else {
      // Default sort: most-recently-indexed first with doc_id tie-breaker.
      orderClause = 'ORDER BY d.indexed_at DESC, d.doc_id DESC';
    }
    const sql = `SELECT d.* FROM documents d WHERE ${where} ${orderClause} LIMIT ? OFFSET ?`;
    params.push(sanitizePageParam(query.limit, 50), sanitizePageParam(query.offset, 0));

    const rows = this.db.prepare(sql).all(...params) as RawDocRow[];

    return rows.map((row): DocumentMatch => ({
      docId: toDocId(row.doc_id),
      docType: toDocType(row.doc_type),
      filePath: toFilePath(row.file_path),
    }));
  }

  // 0.7.17 — sort-index-driven query for scalar schema-field sorts. Drives from
  // the sort field's field_index rows (one per doc for a scalar field) so the
  // covering index yields rows already in sort order and the LIMIT terminates
  // early — O(limit) instead of materializing and temp-b-tree sorting the whole
  // matched set. Filters become correlated EXISTS probes against the index.
  //
  // Docs with no value for the sort field own no driving row, so they are
  // gathered by a second query and concatenated on the NULL-ordering side
  // (SQLite orders NULL smallest: missing sorts last under DESC, first under
  // ASC) — preserving the same result SET and missing-value ordering as the
  // aggregate path, while keeping the early-terminating scan for present docs.
  private findDocumentsScalarSorted(query: DocumentQuery): DocumentMatch[] {
    const dir = query.sortOrder === 'asc' ? 'ASC' : 'DESC';
    const sortCol = query.sortNumeric ? 'sfi.numeric_value' : 'sfi.field_value';
    const sortField = query.sortBy as string;
    const limit = sanitizePageParam(query.limit, 50);
    const offset = sanitizePageParam(query.offset, 0);
    const need = offset + limit;
    if (need === 0) return [];

    const docTypeClause = query.docType ? ' AND d.doc_type = ?' : '';
    const docTypeParam: unknown[] = query.docType ? [query.docType as string] : [];

    // Correlated EXISTS probes for filters (present-value arm). buildFilterSQL
    // emits unqualified field_name/field_value/numeric_value, which bind to the
    // inner field_index alias; the correlation is the alias.doc_id = sfi.doc_id.
    const existsConds: string[] = [];
    const existsParams: unknown[] = [];
    let exIdx = 0;
    if (query.filters) {
      for (const [field, condition] of Object.entries(query.filters)) {
        const atomics: unknown[] = Array.isArray(condition) ? condition : [condition];
        for (const c of atomics) {
          const { sql, values } = buildFilterSQL(field, c);
          const alias = `fex${exIdx++}`;
          existsConds.push(`EXISTS (SELECT 1 FROM field_index ${alias} WHERE ${alias}.doc_id = sfi.doc_id AND ${sql})`);
          existsParams.push(...values);
        }
      }
    }
    const existsWhere = existsConds.length ? ' AND ' + existsConds.join(' AND ') : '';

    type Row = { doc_id: string; doc_type: string; file_path: string };

    // Arm A — docs that HAVE the sort field, in index order, early-terminating.
    const presentArm = (lim: number): Row[] => {
      const sql =
        `SELECT d.doc_id, d.doc_type, d.file_path ` +
        `FROM field_index sfi ` +
        `JOIN documents d ON d.doc_id = sfi.doc_id AND d.deleted = 0${docTypeClause} ` +
        `WHERE sfi.field_name = ?${existsWhere} ` +
        `ORDER BY ${sortCol} ${dir}, sfi.doc_id ${dir} ` +
        `LIMIT ?`;
      const params = [...docTypeParam, sortField, ...existsParams, lim];
      return this.db.prepare(sql).all(...params) as Row[];
    };

    // Arm B — docs MISSING the sort field. Filters reuse the IN form on d.doc_id.
    const missingArm = (lim: number): Row[] => {
      const conds: string[] = ['d.deleted = 0'];
      const params: unknown[] = [];
      if (query.docType) { conds.push('d.doc_type = ?'); params.push(query.docType as string); }
      conds.push('NOT EXISTS (SELECT 1 FROM field_index WHERE doc_id = d.doc_id AND field_name = ?)');
      params.push(sortField);
      if (query.filters) {
        for (const [field, condition] of Object.entries(query.filters)) {
          applyFieldFilters(field, condition, conds, params);
        }
      }
      const sql =
        `SELECT d.doc_id, d.doc_type, d.file_path FROM documents d ` +
        `WHERE ${conds.join(' AND ')} ORDER BY d.doc_id ${dir} LIMIT ?`;
      params.push(lim);
      return this.db.prepare(sql).all(...params) as Row[];
    };

    // NULL (missing) sorts smallest: present-first under DESC, missing-first
    // under ASC. Fetch the leading arm up to `need`; only touch the trailing
    // arm if the requested page extends past the leading arm's rows.
    const leading = dir === 'DESC' ? presentArm(need) : missingArm(need);
    let combined = leading;
    if (leading.length < need) {
      const remaining = need - leading.length;
      const trailing = dir === 'DESC' ? missingArm(remaining) : presentArm(remaining);
      combined = leading.concat(trailing);
    }

    return combined.slice(offset, offset + limit).map((row): DocumentMatch => ({
      docId: toDocId(row.doc_id),
      docType: toDocType(row.doc_type),
      filePath: toFilePath(row.file_path),
    }));
  }

  countDocuments(query: DocumentQuery): number {
    const { where, params } = this.buildDocQuery(query);
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM documents d WHERE ${where}`).get(...params) as { cnt: number };
    return row.cnt;
  }

  getFieldValues(docIds: DocId[], fieldNames: string[]): Map<string, Record<string, string>> {
    if (docIds.length === 0 || fieldNames.length === 0) return new Map();

    const idPlaceholders = docIds.map(() => '?').join(', ');
    const namePlaceholders = fieldNames.map(() => '?').join(', ');
    const sql = `SELECT doc_id, field_name, field_value FROM field_index
      WHERE doc_id IN (${idPlaceholders}) AND field_name IN (${namePlaceholders})`;

    const rows = this.db.prepare(sql).all(
      ...docIds.map(id => id as string),
      ...fieldNames,
    ) as Array<{ doc_id: string; field_name: string; field_value: string }>;

    const result = new Map<string, Record<string, string>>();
    for (const row of rows) {
      let fields = result.get(row.doc_id);
      if (!fields) { fields = {}; result.set(row.doc_id, fields); }
      fields[row.field_name] = row.field_value;
    }
    return result;
  }

  private buildObjQuery(query: ObjectQuery, alias = ''): { where: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const col = (name: string) => `${alias}${name}`;

    if (query.primitive) { conditions.push(`${col('primitive')} = ?`); params.push(query.primitive); }
    if (query.subtype) { conditions.push(`${col('subtype')} = ?`); params.push(query.subtype); }
    if (query.value) { conditions.push(`${col('value')} = ?`); params.push(query.value); }
    if (query.contains) { conditions.push(`${col('value')} LIKE ?`); params.push(`%${query.contains}%`); }
    if (query.docId) { conditions.push(`${col('doc_id')} = ?`); params.push(query.docId as string); }
    if (query.range) {
      if (query.range.gte) { conditions.push(`${col('normalized_value')} >= ?`); params.push(query.range.gte); }
      if (query.range.gt) { conditions.push(`${col('normalized_value')} > ?`); params.push(query.range.gt); }
      if (query.range.lte) { conditions.push(`${col('normalized_value')} <= ?`); params.push(query.range.lte); }
      if (query.range.lt) { conditions.push(`${col('normalized_value')} < ?`); params.push(query.range.lt); }
    }

    const w = conditions.length > 0 ? conditions.join(' AND ') : '1=1';
    return { where: w, params };
  }

  findObjects(query: ObjectQuery): ObjectMatch[] {
    const { where, params } = this.buildObjQuery(query, 'o.');
    const sql = `SELECT o.* FROM objects o JOIN documents d ON d.doc_id = o.doc_id AND d.deleted = 0
      WHERE ${where}
      ORDER BY o.doc_id, o.source_line LIMIT ? OFFSET ?`;
    params.push(sanitizePageParam(query.limit, 50), sanitizePageParam(query.offset, 0));

    const rows = this.db.prepare(sql).all(...params) as RawObjectRow[];

    return rows.map((row): ObjectMatch => ({
      primitive: row.primitive as ObjectMatch['primitive'],
      subtype: row.subtype,
      value: row.value,
      normalizedValue: row.normalized_value,
      label: row.label,
      docId: toDocId(row.doc_id),
      sourceLine: row.source_line,
      blockId: row.block_id ? toBlockId(row.block_id) : null,
    }));
  }

  countObjects(query: ObjectQuery): number {
    const { where, params } = this.buildObjQuery(query, 'o.');
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM objects o JOIN documents d ON d.doc_id = o.doc_id AND d.deleted = 0 WHERE ${where}`).get(...params) as { cnt: number };
    return row.cnt;
  }

  getRelationships(docId: DocId, direction: 'outgoing' | 'incoming' | 'both'): Relationship[] {
    const results: Relationship[] = [];
    const id = docId as string;

    if (direction === 'outgoing' || direction === 'both') {
      const rows = this.db.prepare(
        `SELECT r.* FROM relationships r
         JOIN documents sd ON sd.doc_id = r.source_doc_id AND sd.deleted = 0
         LEFT JOIN documents td ON td.doc_id = r.target_doc_id
         WHERE r.source_doc_id = ? AND (td.doc_id IS NULL OR td.deleted = 0)`,
      ).all(id) as RawRelRow[];

      for (const row of rows) {
        results.push({
          sourceDocId: toDocId(row.source_doc_id),
          targetDocId: toDocId(row.target_doc_id),
          field: row.field,
          relationType: row.relation_type as 'ref' | 'mention',
        });
      }
    }

    if (direction === 'incoming' || direction === 'both') {
      const rows = this.db.prepare(
        `SELECT r.* FROM relationships r
         JOIN documents sd ON sd.doc_id = r.source_doc_id AND sd.deleted = 0
         JOIN documents td ON td.doc_id = r.target_doc_id AND td.deleted = 0
         WHERE r.target_doc_id = ?`,
      ).all(id) as RawRelRow[];

      for (const row of rows) {
        results.push({
          sourceDocId: toDocId(row.source_doc_id),
          targetDocId: toDocId(row.target_doc_id),
          field: row.field,
          relationType: row.relation_type as 'ref' | 'mention',
        });
      }
    }

    return results;
  }

  getBlocks(docId: DocId): ParsedBlock[] {
    const rows = this.db.prepare(
      `SELECT b.* FROM blocks b JOIN documents d ON d.doc_id = b.doc_id AND d.deleted = 0
       WHERE b.doc_id = ? ORDER BY b.start_line`,
    ).all(docId as string) as RawBlockRow[];

    return rows.map((row): ParsedBlock => ({
      id: row.block_id ? toBlockId(row.block_id) : null,
      heading: row.heading,
      level: row.level,
      startLine: row.start_line,
      endLine: row.end_line,
    }));
  }

  // --- Aggregation ---------------------------------------------------------

  getSubtypeInventory(limit: number): Array<{ primitive: string; subtype: string; count: number; topValues: string[] }> {
    const groups = this.db.prepare(`
      SELECT primitive, subtype, COUNT(*) as cnt
      FROM objects o JOIN documents d ON d.doc_id = o.doc_id AND d.deleted = 0
      GROUP BY primitive, subtype
      ORDER BY cnt DESC
      LIMIT ?
    `).all(limit) as Array<{ primitive: string; subtype: string; cnt: number }>;

    return groups.map(g => {
      const topRows = this.db.prepare(`
        SELECT value, COUNT(*) as cnt
        FROM objects o JOIN documents d ON d.doc_id = o.doc_id AND d.deleted = 0
        WHERE primitive = ? AND subtype = ?
        GROUP BY value
        ORDER BY cnt DESC
        LIMIT 5
      `).all(g.primitive, g.subtype) as Array<{ value: string; cnt: number }>;

      return {
        primitive: g.primitive,
        subtype: g.subtype,
        count: g.cnt,
        topValues: topRows.map(r => r.value),
      };
    });
  }

  getSampleDocIds(dt: DocType, limit: number): DocId[] {
    const rows = this.db.prepare(
      'SELECT doc_id FROM documents WHERE doc_type = ? AND deleted = 0 ORDER BY indexed_at DESC LIMIT ?',
    ).all(dt as string, limit) as Array<{ doc_id: string }>;

    return rows.map(r => toDocId(r.doc_id));
  }

  listChangesSince(opts: {
    cursor: import('../../engine/types.js').ChangesSinceParsedCursor | null;
    limit: number;
    docTypes?: string[] | undefined;
  }): Array<{ docId: string; docType: string; updatedAt: string; version: number }> {
    // Strict tuple comparison for (updated_at, doc_id) > (cursor.u, cursor.d):
    //   updated_at > cu  OR  (updated_at = cu AND doc_id > cd)
    const conditions: string[] = ['deleted = 0'];
    const params: unknown[] = [];

    if (opts.cursor) {
      conditions.push('(updated_at > ? OR (updated_at = ? AND doc_id > ?))');
      params.push(opts.cursor.updatedAt, opts.cursor.updatedAt, opts.cursor.docId);
    }

    if (opts.docTypes && opts.docTypes.length > 0) {
      const placeholders = opts.docTypes.map(() => '?').join(', ');
      conditions.push(`doc_type IN (${placeholders})`);
      params.push(...opts.docTypes);
    }

    const sql =
      `SELECT doc_id, doc_type, updated_at, version FROM documents ` +
      `WHERE ${conditions.join(' AND ')} ` +
      `ORDER BY updated_at ASC, doc_id ASC LIMIT ?`;
    params.push(opts.limit);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      doc_id: string;
      doc_type: string;
      updated_at: string;
      version: number;
    }>;

    return rows.map(r => ({
      docId: r.doc_id,
      docType: r.doc_type,
      updatedAt: r.updated_at,
      version: r.version,
    }));
  }

  aggregate(query: AggregateQuery): AggregateResult {
    // Build a set of doc_ids scoped by docType + filters
    const scopeConditions: string[] = ['d.deleted = 0'];
    const scopeParams: unknown[] = [];

    if (query.docType) {
      scopeConditions.push('d.doc_type = ?');
      scopeParams.push(query.docType as string);
    }

    if (query.filters) {
      for (const [field, condition] of Object.entries(query.filters)) {
        applyFieldFilters(field, condition, scopeConditions, scopeParams);
      }
    }

    const scopeWhere = scopeConditions.join(' AND ');
    const limit = query.limit ?? 50;

    if (!query.metric) {
      // Count documents per group value
      const sql = `
        SELECT fi.field_value as grp, COUNT(DISTINCT fi.doc_id) as cnt
        FROM field_index fi
        JOIN documents d ON d.doc_id = fi.doc_id
        WHERE fi.field_name = ? AND ${scopeWhere}
        GROUP BY fi.field_value
        ORDER BY cnt DESC
        LIMIT ?`;

      const rows = this.db.prepare(sql).all(query.groupBy, ...scopeParams, limit) as Array<{ grp: string; cnt: number }>;

      return {
        groups: rows.map(r => ({ value: r.grp ?? '(null)', count: r.cnt })),
        total: rows.reduce((sum, r) => sum + r.cnt, 0),
      };
    }

    // Metric aggregation: group by one field, aggregate another
    const metricOp = query.metric.op;
    const metricCol = metricOp === 'count' ? '1' : 'mfi.numeric_value';
    const aggFn = metricOp === 'count' ? 'COUNT(*)' :
      metricOp === 'sum' ? `SUM(${metricCol})` :
      metricOp === 'avg' ? `AVG(${metricCol})` :
      metricOp === 'min' ? `MIN(${metricCol})` :
      `MAX(${metricCol})`;

    const sql = `
      SELECT gfi.field_value as grp, COUNT(DISTINCT gfi.doc_id) as cnt, ${aggFn} as metric
      FROM field_index gfi
      JOIN documents d ON d.doc_id = gfi.doc_id
      ${metricOp !== 'count' ? 'JOIN field_index mfi ON mfi.doc_id = gfi.doc_id AND mfi.field_name = ?' : ''}
      WHERE gfi.field_name = ? AND ${scopeWhere}
      GROUP BY gfi.field_value
      ORDER BY metric DESC
      LIMIT ?`;

    const params = metricOp !== 'count'
      ? [query.metric.field, query.groupBy, ...scopeParams, limit]
      : [query.groupBy, ...scopeParams, limit];

    const rows = this.db.prepare(sql).all(...params) as Array<{ grp: string; cnt: number; metric: number | null }>;

    const totalMetric = rows.reduce((sum, r) => sum + (r.metric ?? 0), 0);

    return {
      groups: rows.map(r => ({ value: r.grp ?? '(null)', count: r.cnt, metric: r.metric })),
      total: rows.reduce((sum, r) => sum + r.cnt, 0),
      totalMetric,
    };
  }

  // --- Maintenance ---------------------------------------------------------

  removeDocument(docId: DocId): void {
    // CASCADE deletes handle objects, relationships, blocks, field_index.
    // 0.8.0 — vec0/fts5 virtual tables do NOT participate in FK CASCADE, so the
    // semantic index rows are removed explicitly here. Centralizing it in
    // removeDocument covers every hard-removal caller (deleteDocument hard,
    // purgeSoftDeleted, the indexAll stale-row sweep) in one place.
    // 0.8.1 — transaction-wrapped so the semantic deletes and the documents
    // delete commit or roll back together (same atomicity as
    // materializeDocument on the write side).
    const txn = this.db.transaction(() => {
      this.semanticStore?.deleteDoc(docId as string);
      this.db.prepare('DELETE FROM documents WHERE doc_id = ?').run(docId as string);
    });
    txn();
  }

  /**
   * 0.8.1 — mark a row stale without re-materializing the doc. Used by the
   * indexer when a previously indexed file grows past MAAD_MAX_DOC_BYTES: the
   * row is retained (still queryable at its last indexed content), flagged
   * partial so the staleness is visible, and its stored file_hash is
   * invalidated so the doc re-indexes — and the flag clears — on the first
   * pass where the file is readable again (even if it shrinks back to
   * byte-identical content, which would otherwise hash-skip forever).
   */
  markDocumentStale(docId: DocId): void {
    this.db.prepare("UPDATE documents SET partial = 1, file_hash = '' WHERE doc_id = ?")
      .run(docId as string);
  }

  /**
   * 0.8.1 — count live rows whose index state is partial/stale. Surfaced in
   * summary() warnings alongside brokenRefs/validationErrors.
   */
  countPartialDocuments(): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) AS n FROM documents WHERE partial = 1 AND deleted = 0',
    ).get() as { n: number };
    return row.n;
  }

  // 0.7.17 — refresh planner statistics after a full reindex. ANALYZE scans the
  // indexes to populate sqlite_stat1; cheap relative to the reindex that
  // precedes it (~1s at 240k field_index rows) and keeps the planner choosing
  // the composite field_index indexes over the low-selectivity deleted index.
  analyze(): void {
    this.db.exec('ANALYZE');
  }

  getFileHash(path: FilePath): string | null {
    const row = this.db.prepare(
      'SELECT file_hash FROM documents WHERE file_path = ? AND deleted = 0',
    ).get(path as string) as { file_hash: string } | undefined;

    return row?.file_hash ?? null;
  }

  getAllFileHashes(): Map<FilePath, string> {
    const rows = this.db.prepare(
      'SELECT file_path, file_hash FROM documents WHERE deleted = 0',
    ).all() as Array<{ file_path: string; file_hash: string }>;

    const map = new Map<FilePath, string>();
    for (const row of rows) {
      map.set(toFilePath(row.file_path), row.file_hash);
    }
    return map;
  }

  findSoftDeletedBefore(olderThanIso: string, limit: number): DocumentRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM documents WHERE deleted = 1 AND updated_at < ? ORDER BY updated_at ASC, doc_id ASC LIMIT ?',
    ).all(olderThanIso, limit) as RawDocRow[];
    return rows.map(rowToDocument);
  }

  // 0.7.4 — engine_meta key/value access. Used by indexAll for
  // per-type schema-index fingerprints; namespace keys with `<topic>:<id>`.
  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM engine_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare(
      'INSERT INTO engine_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  // 0.8.0 — bring up the semantic index (sqlite-vec + FTS5). Idempotent: a
  // second call is ignored. Fails open inside SemanticStore.init if the
  // loadable extension can't load.
  initSemantic(cfg: { dim?: number | undefined; model?: string | undefined }): void {
    if (this.semanticStore) return;
    const store = new SemanticStore(this.db);
    store.init(cfg);
    this.semanticStore = store;
  }

  semantic(): SemanticIndex | null {
    return this.closed ? null : this.semanticStore;
  }

  getStats(): BackendStats {
    const docCount = this.db.prepare('SELECT COUNT(*) as cnt FROM documents WHERE deleted = 0').get() as { cnt: number };
    const objCount = this.db.prepare('SELECT COUNT(*) as cnt FROM objects o JOIN documents d ON d.doc_id = o.doc_id AND d.deleted = 0').get() as { cnt: number };
    const relCount = this.db.prepare(`SELECT COUNT(*) as cnt FROM relationships r
      JOIN documents sd ON sd.doc_id = r.source_doc_id AND sd.deleted = 0
      LEFT JOIN documents td ON td.doc_id = r.target_doc_id
      WHERE td.doc_id IS NULL OR td.deleted = 0`).get() as { cnt: number };
    const lastIndexed = this.db.prepare('SELECT MAX(indexed_at) as ts FROM documents WHERE deleted = 0').get() as { ts: string | null };

    const byType = this.db.prepare(
      'SELECT doc_type, COUNT(*) as cnt FROM documents WHERE deleted = 0 GROUP BY doc_type',
    ).all() as Array<{ doc_type: string; cnt: number }>;

    const documentCountByType: Record<string, number> = {};
    for (const row of byType) {
      documentCountByType[row.doc_type] = row.cnt;
    }

    return {
      totalDocuments: docCount.cnt,
      totalObjects: objCount.cnt,
      totalRelationships: relCount.cnt,
      lastIndexedAt: lastIndexed.ts,
      documentCountByType,
    };
  }

  // 0.7.17 — count live records flagged invalid at index time. Backs
  // summary().warnings.validationErrors without re-reading every file. The
  // count reflects index-mode structural validity (precision enforcement is
  // write-time only — same posture as the read-mode validation summary() used
  // to run inline), and is accurate for records indexed since the 0.7.17
  // upgrade; pre-0.7.17 rows read as valid until their next reindex.
  countInvalidDocuments(): number {
    const row = this.db.prepare(
      'SELECT COUNT(*) as cnt FROM documents WHERE deleted = 0 AND valid = 0',
    ).get() as { cnt: number };
    return row.cnt;
  }

  countBrokenRefs(): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM relationships r
      JOIN documents d ON d.doc_id = r.source_doc_id AND d.deleted = 0
      WHERE r.relation_type = 'ref'
        AND r.target_doc_id NOT IN (SELECT doc_id FROM documents WHERE deleted = 0)
    `).get() as { cnt: number };
    return row.cnt;
  }

  getBrokenRefs(): Array<{ sourceDocId: string; sourceDocType: string; field: string; targetDocId: string; targetDeleted: boolean }> {
    const rows = this.db.prepare(`
      SELECT r.source_doc_id AS sourceDocId,
             d.doc_type      AS sourceDocType,
             r.field         AS field,
             r.target_doc_id AS targetDocId,
             CASE WHEN target.deleted = 1 THEN 1 ELSE 0 END AS targetDeleted
      FROM relationships r
      JOIN documents d
        ON r.source_doc_id = d.doc_id
       AND d.deleted = 0
      LEFT JOIN documents target ON target.doc_id = r.target_doc_id
      WHERE r.relation_type = 'ref'
        AND r.target_doc_id NOT IN (SELECT doc_id FROM documents WHERE deleted = 0)
      ORDER BY r.source_doc_id, r.field, r.target_doc_id
    `).all() as Array<{ sourceDocId: string; sourceDocType: string; field: string; targetDocId: string; targetDeleted: number }>;
    return rows.map(row => ({ ...row, targetDeleted: row.targetDeleted === 1 }));
  }
}

// --- Helpers ---------------------------------------------------------------

// SQLite treats LIMIT -1 (any negative) as "no limit", and a fractional bind
// errors the statement. The MCP boundary validates limit/offset as non-negative
// integers; this is the last line of defense for direct engine callers.
function sanitizePageParam(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function normalizeFilter(condition: FilterCondition | string | unknown): FilterCondition {
  // Shorthand: "value" → { op: 'eq', value: "value" }
  if (typeof condition === 'string') return { op: 'eq', value: condition };
  if (typeof condition === 'number') return { op: 'eq', value: condition };
  if (typeof condition === 'object' && condition !== null && 'op' in condition) return condition as FilterCondition;
  // Fallback: treat as eq with string coercion
  return { op: 'eq', value: String(condition) };
}

// 0.7.1 R2 — apply per-field filters to a SQL conditions/params pair. Accepts
// either the legacy single-filter shape (scalar, single op) or the expanded
// array-of-ops shape produced by the engine-layer `expandFilters`. All atomic
// conditions AND-combine at the SQL layer via separate `d.doc_id IN (...)` clauses.
function applyFieldFilters(
  field: string,
  raw: unknown,
  conditions: string[],
  params: unknown[],
): void {
  const atomics: unknown[] = Array.isArray(raw) ? raw : [raw];
  const positive: Array<{ sql: string; values: unknown[] }> = [];
  for (const c of atomics) {
    const normalized = normalizeFilter(c);
    if (normalized.op === 'neq') {
      // Multi-valued fields use NONE semantics for neq. `EXISTS(value != x)`
      // is wrong for [x, y] because y makes the document match even though x
      // is present. Retain the historical requirement that the field exists.
      conditions.push('d.doc_id IN (SELECT doc_id FROM field_index WHERE field_name = ?)');
      params.push(field);
      conditions.push('d.doc_id NOT IN (SELECT doc_id FROM field_index WHERE field_name = ? AND field_value = ?)');
      params.push(field, String(normalized.value));
      continue;
    }
    const { sql, values } = buildFilterSQL(field, c);
    positive.push({ sql, values });
  }
  if (positive.length > 0) {
    // All operators on one field must be satisfied by the same indexed value.
    // This matters for lists: [1, 20] must not satisfy gte 10 AND lte 5 by
    // distributing the two predicates across different items.
    conditions.push(`d.doc_id IN (SELECT doc_id FROM field_index WHERE ${positive.map(p => `(${p.sql})`).join(' AND ')})`);
    params.push(...positive.flatMap(p => p.values));
  }
}

function buildFilterSQL(field: string, rawCondition: FilterCondition | string | unknown): { sql: string; values: unknown[] } {
  const condition = normalizeFilter(rawCondition);
  // For range operators, use numeric_value when the value is numeric (handles number fields correctly)
  // For dates, field_value as ISO strings already sort correctly
  const isNumericRange = (condition.op === 'gt' || condition.op === 'gte' || condition.op === 'lt' || condition.op === 'lte')
    && typeof condition.value === 'number';

  switch (condition.op) {
    case 'eq':
      return { sql: 'field_name = ? AND field_value = ?', values: [field, String(condition.value)] };
    case 'neq':
      return { sql: 'field_name = ? AND field_value != ?', values: [field, String(condition.value)] };
    case 'gt':
      if (isNumericRange) {
        return { sql: 'field_name = ? AND numeric_value > ?', values: [field, condition.value] };
      }
      return { sql: 'field_name = ? AND field_value > ?', values: [field, String(condition.value)] };
    case 'gte':
      if (isNumericRange) {
        return { sql: 'field_name = ? AND numeric_value >= ?', values: [field, condition.value] };
      }
      return { sql: 'field_name = ? AND field_value >= ?', values: [field, String(condition.value)] };
    case 'lt':
      if (isNumericRange) {
        return { sql: 'field_name = ? AND numeric_value < ?', values: [field, condition.value] };
      }
      return { sql: 'field_name = ? AND field_value < ?', values: [field, String(condition.value)] };
    case 'lte':
      if (isNumericRange) {
        return { sql: 'field_name = ? AND numeric_value <= ?', values: [field, condition.value] };
      }
      return { sql: 'field_name = ? AND field_value <= ?', values: [field, String(condition.value)] };
    case 'in': {
      const placeholders = condition.value.map(() => '?').join(', ');
      return { sql: `field_name = ? AND field_value IN (${placeholders})`, values: [field, ...condition.value.map(String)] };
    }
    case 'contains':
      return { sql: 'field_name = ? AND field_value LIKE ?', values: [field, `%${condition.value}%`] };
    case 'between':
      // Defensive: `between` is a compound shortcut normalized to [gte, lte] by
      // the engine layer's `expandFilters` (src/engine/reads.ts). Reaching this
      // branch means filters bypassed engine normalization — caller layering bug.
      throw new Error(`Unexpected 'between' filter at backend layer — engine must expand via expandFilters before passing to backend`);
  }
}

function rowToDocument(row: RawDocRow): DocumentRecord {
  return {
    docId: toDocId(row.doc_id),
    docType: toDocType(row.doc_type),
    schemaRef: toSchemaRef(row.schema_ref),
    filePath: toFilePath(row.file_path),
    fileHash: row.file_hash,
    version: row.version,
    deleted: row.deleted === 1,
    indexedAt: row.indexed_at,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    valid: row.valid !== 0,
    partial: row.partial === 1,
  };
}

// --- Raw row types ---------------------------------------------------------

interface RawDocRow {
  doc_id: string;
  doc_type: string;
  schema_ref: string;
  file_path: string;
  file_hash: string;
  version: number;
  deleted: number;
  indexed_at: string;
  updated_at: string;
  created_at: string;
  valid: number;
  partial: number;
}

interface RawObjectRow {
  id: number;
  primitive: string;
  subtype: string;
  value: string;
  normalized_value: string | null;
  label: string;
  role: string | null;
  doc_id: string;
  source_line: number;
  block_id: string | null;
}

interface RawRelRow {
  id: number;
  source_doc_id: string;
  target_doc_id: string;
  field: string;
  relation_type: string;
}

interface RawBlockRow {
  id: number;
  doc_id: string;
  block_id: string | null;
  heading: string;
  level: number;
  start_line: number;
  end_line: number;
}
