// ============================================================================
// SQLite Backend Implementation
// Implements MaadBackend using better-sqlite3 with WAL mode.
// ============================================================================

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { SCHEMA_SQL } from './schema.js';
import type { MaadBackend } from '../adapter.js';
import {
  docId as toDocId,
  docType as toDocType,
  schemaRef as toSchemaRef,
  filePath as toFilePath,
  blockId as toBlockId,
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

export class SqliteBackend implements MaadBackend {
  private db: DatabaseType;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
  }

  init(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  // --- Write operations ----------------------------------------------------

  putDocument(doc: DocumentRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO documents
        (doc_id, doc_type, schema_ref, file_path, file_hash, version, deleted, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      doc.docId as string,
      doc.docType as string,
      doc.schemaRef as string,
      doc.filePath as string,
      doc.fileHash,
      doc.version,
      doc.deleted ? 1 : 0,
      doc.indexedAt,
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
  ): void {
    const txn = this.db.transaction(() => {
      this.putDocument(doc);
      this.putObjects(doc.docId, objects);
      this.putRelationships(doc.docId, relationships);
      this.putBlocks(doc.docId, blocks);
      this.putFieldIndex(doc.docId, fieldIndex);
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
    const row = this.db.prepare(
      'SELECT * FROM documents WHERE file_path = ? AND deleted = 0',
    ).get(path as string) as RawDocRow | undefined;

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
        const { sql, values } = buildFilterSQL(field, condition);
        conditions.push(`d.doc_id IN (SELECT doc_id FROM field_index WHERE ${sql})`);
        params.push(...values);
      }
    }

    return { where: conditions.join(' AND '), params };
  }

  findDocuments(query: DocumentQuery): DocumentMatch[] {
    const { where, params } = this.buildDocQuery(query);
    const sql = `SELECT d.* FROM documents d WHERE ${where} ORDER BY d.indexed_at DESC LIMIT ? OFFSET ?`;
    params.push(query.limit ?? 50, query.offset ?? 0);

    const rows = this.db.prepare(sql).all(...params) as RawDocRow[];

    return rows.map((row): DocumentMatch => ({
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

  private buildObjQuery(query: ObjectQuery): { where: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.primitive) { conditions.push('primitive = ?'); params.push(query.primitive); }
    if (query.subtype) { conditions.push('subtype = ?'); params.push(query.subtype); }
    if (query.value) { conditions.push('value = ?'); params.push(query.value); }
    if (query.contains) { conditions.push('value LIKE ?'); params.push(`%${query.contains}%`); }
    if (query.docId) { conditions.push('doc_id = ?'); params.push(query.docId as string); }
    if (query.range) {
      if (query.range.gte) { conditions.push('normalized_value >= ?'); params.push(query.range.gte); }
      if (query.range.gt) { conditions.push('normalized_value > ?'); params.push(query.range.gt); }
      if (query.range.lte) { conditions.push('normalized_value <= ?'); params.push(query.range.lte); }
      if (query.range.lt) { conditions.push('normalized_value < ?'); params.push(query.range.lt); }
    }

    const w = conditions.length > 0 ? conditions.join(' AND ') : '1=1';
    return { where: w, params };
  }

  findObjects(query: ObjectQuery): ObjectMatch[] {
    const { where, params } = this.buildObjQuery(query);
    const sql = `SELECT * FROM objects WHERE ${where} ORDER BY doc_id, source_line LIMIT ? OFFSET ?`;
    params.push(query.limit ?? 50, query.offset ?? 0);

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
    const { where, params } = this.buildObjQuery(query);
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM objects WHERE ${where}`).get(...params) as { cnt: number };
    return row.cnt;
  }

  getRelationships(docId: DocId, direction: 'outgoing' | 'incoming' | 'both'): Relationship[] {
    const results: Relationship[] = [];
    const id = docId as string;

    if (direction === 'outgoing' || direction === 'both') {
      const rows = this.db.prepare(
        'SELECT * FROM relationships WHERE source_doc_id = ?',
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
        'SELECT * FROM relationships WHERE target_doc_id = ?',
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
      'SELECT * FROM blocks WHERE doc_id = ? ORDER BY start_line',
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
      FROM objects
      GROUP BY primitive, subtype
      ORDER BY cnt DESC
      LIMIT ?
    `).all(limit) as Array<{ primitive: string; subtype: string; cnt: number }>;

    return groups.map(g => {
      const topRows = this.db.prepare(`
        SELECT value, COUNT(*) as cnt
        FROM objects
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

  // --- Maintenance ---------------------------------------------------------

  removeDocument(docId: DocId): void {
    // CASCADE deletes handle objects, relationships, blocks, field_index
    this.db.prepare('DELETE FROM documents WHERE doc_id = ?').run(docId as string);
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

  getStats(): BackendStats {
    const docCount = this.db.prepare('SELECT COUNT(*) as cnt FROM documents WHERE deleted = 0').get() as { cnt: number };
    const objCount = this.db.prepare('SELECT COUNT(*) as cnt FROM objects').get() as { cnt: number };
    const relCount = this.db.prepare('SELECT COUNT(*) as cnt FROM relationships').get() as { cnt: number };
    const lastIndexed = this.db.prepare('SELECT MAX(indexed_at) as ts FROM documents').get() as { ts: string | null };

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
}

// --- Helpers ---------------------------------------------------------------

function buildFilterSQL(field: string, condition: FilterCondition): { sql: string; values: unknown[] } {
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
