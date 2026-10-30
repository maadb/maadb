// The default find order and the changes feed must come from an index, so a
// page stops at LIMIT instead of sorting every live row.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { SqliteBackend } from '../../src/backend/sqlite/index.js';
import { docId, docType, filePath, schemaRef, type DocumentRecord } from '../../src/types.js';

let backend: SqliteBackend;
let db: Database.Database;

function makeDoc(i: number): DocumentRecord {
  const id = `note-${String(i).padStart(3, '0')}`;
  const stamp = `2026-10-30T00:00:${String(i % 60).padStart(2, '0')}.000Z`;
  return {
    docId: docId(id),
    docType: docType(i % 2 === 0 ? 'note' : 'task'),
    schemaRef: schemaRef('note.v1'),
    filePath: filePath(`notes/${id}.md`),
    fileHash: `hash_${id}`,
    version: 1,
    deleted: i % 10 === 0,
    indexedAt: stamp,
    updatedAt: stamp,
    createdAt: stamp,
    valid: true,
  } as DocumentRecord;
}

// Plans the exact SQL the backend ran, so the assertion follows the query.
function planOf(run: () => unknown): string {
  const statements: string[] = [];
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    statements.push(sql);
    return prepare(sql);
  }) as typeof db.prepare;
  try {
    run();
  } finally {
    db.prepare = prepare;
  }
  const sql = statements.find(statement => statement.includes('ORDER BY'))!;
  const rows = prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => null)) as Array<{ detail: string }>;
  return rows.map(row => row.detail).join('\n');
}

beforeEach(() => {
  backend = new SqliteBackend(':memory:');
  backend.init();
  db = (backend as unknown as { db: Database.Database }).db;
  for (let i = 0; i < 120; i++) backend.putDocument(makeDoc(i));
  db.exec('ANALYZE');
});

afterEach(() => {
  backend.close();
});

describe('document order indexes', () => {
  it('walks the index for the default find order', () => {
    const plan = planOf(() => backend.findDocuments({}));
    expect(plan).toContain('idx_documents_del_indexed_id');
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it('walks the index for the first changes page', () => {
    const plan = planOf(() => backend.listChangesSince({ cursor: null, limit: 10 }));
    expect(plan).toContain('idx_documents_del_updated_id');
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it('walks the index for a later changes page', () => {
    const plan = planOf(() => backend.listChangesSince({
      cursor: { updatedAt: '2026-10-30T00:00:30.000Z', docId: 'note-030' },
      limit: 10,
    }));
    expect(plan).toContain('idx_documents_del_updated_id');
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it('pages through every live row in order with no gap or repeat', () => {
    const seen: string[] = [];
    let cursor: { updatedAt: string; docId: string } | null = null;
    for (;;) {
      const page: Array<{ docId: string; updatedAt: string }> = backend.listChangesSince({ cursor, limit: 7 });
      if (page.length === 0) break;
      seen.push(...page.map(row => row.docId));
      const last = page[page.length - 1]!;
      cursor = { updatedAt: last.updatedAt, docId: last.docId };
    }

    const expected = Array.from({ length: 120 }, (_, i) => makeDoc(i))
      .filter(doc => !doc.deleted)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || (a.docId as string).localeCompare(b.docId as string))
      .map(doc => doc.docId as string);
    expect(seen).toEqual(expected);
  });

  it('adds the indexes to a database that lacks them', () => {
    db.exec('DROP INDEX idx_documents_del_updated_id');
    db.exec('DROP INDEX idx_documents_del_indexed_id');
    backend.init();
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>)
      .map(row => row.name);
    expect(names).toEqual(expect.arrayContaining(['idx_documents_del_updated_id', 'idx_documents_del_indexed_id']));
  });
});
