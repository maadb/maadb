// indexAll commits documents in groups. A failure must stay as narrow as it was
// when every document committed alone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { MaadEngine } from '../../src/engine.js';
import type { SqliteBackend } from '../../src/backend/sqlite/index.js';
import { docId } from '../../src/types.js';

const DOCS = 205;

let root: string;
let engine: MaadEngine;
let backend: SqliteBackend;

function writeNote(i: number): void {
  writeFileSync(path.join(root, 'data/notes', `note-${i}.md`),
    `---\ndoc_id: note-${i}\ndoc_type: note\nschema: note.v1\n---\n\n# Note ${i}\n`);
}

const indexedCount = () => backend.getStats().documentCountByType['note'] ?? 0;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'maad-index-batch-'));
  mkdirSync(path.join(root, '_registry'));
  mkdirSync(path.join(root, '_schema'));
  mkdirSync(path.join(root, 'data/notes'), { recursive: true });
  writeFileSync(path.join(root, '_registry/object_types.yaml'),
    'types:\n  note:\n    path: data/notes\n    id_prefix: note\n    schema: note.v1\n');
  writeFileSync(path.join(root, '_schema/note.v1.yaml'),
    'type: note\nversion: 1\nrequired:\n  - doc_id\nfields: {}\n');
  engine = new MaadEngine();
  expect((await engine.init(root)).ok).toBe(true);
  backend = engine.getBackend() as SqliteBackend;
  for (let i = 0; i < DOCS; i++) writeNote(i);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await engine.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('indexAll commit groups', () => {
  it('indexes every document across a group boundary and leaves no transaction open', async () => {
    const begin = vi.spyOn(backend, 'beginBatch');

    const result = await engine.indexAll();

    expect(result).toMatchObject({ indexed: DOCS, errors: [] });
    expect(begin).toHaveBeenCalledTimes(2);
    expect(indexedCount()).toBe(DOCS);
    expect((backend as unknown as { db: Database.Database }).db.inTransaction).toBe(false);
  });

  it('opens no group when nothing changed', async () => {
    await engine.indexAll();
    const begin = vi.spyOn(backend, 'beginBatch');
    await engine.indexAll();
    expect(begin).not.toHaveBeenCalled();
  });

  it('loses only the document that failed, including its partial rows', async () => {
    const putBlocks = backend.putBlocks.bind(backend);
    vi.spyOn(backend, 'putBlocks').mockImplementation((id, blocks) => {
      if (id === docId('note-3')) throw new Error('row rejected');
      putBlocks(id, blocks);
    });

    const result = await engine.indexAll();

    expect(result).toMatchObject({ indexed: DOCS - 1, errors: [{ code: 'BACKEND_ERROR' }] });
    expect(backend.getDocument(docId('note-3'))).toBeNull();
    expect(backend.getDocument(docId('note-4'))).not.toBeNull();
    expect(indexedCount()).toBe(DOCS - 1);
  });

  it('reports a failed commit and retries the type on the next pass', async () => {
    const db = (backend as unknown as { db: Database.Database }).db;
    vi.spyOn(backend, 'commitBatch').mockImplementationOnce(() => {
      db.exec('ROLLBACK');
      throw new Error('disk full');
    });

    const failed = await engine.indexAll();

    expect(failed).toMatchObject({ indexed: 5, errors: [{ code: 'BACKEND_ERROR', message: expect.stringContaining('disk full') }] });
    expect(indexedCount()).toBe(5);

    const retried = await engine.indexAll();
    expect(retried).toMatchObject({ indexed: DOCS, errors: [] });
    expect(indexedCount()).toBe(DOCS);
  });

  it('commits one document at a time when a group cannot open', async () => {
    vi.spyOn(backend, 'beginBatch').mockImplementation(() => { throw new Error('database is locked'); });
    const commit = vi.spyOn(backend, 'commitBatch');

    const result = await engine.indexAll();

    expect(result).toMatchObject({ indexed: DOCS, errors: [] });
    expect(commit).not.toHaveBeenCalled();
    expect(indexedCount()).toBe(DOCS);
  });

  it('keeps finished documents if the scan throws', async () => {
    const lookup = backend.getDocumentByPath.bind(backend);
    let calls = 0;
    vi.spyOn(backend, 'getDocumentByPath').mockImplementation(file => {
      if (++calls === 50) throw new Error('scan failed');
      return lookup(file);
    });

    await expect(engine.indexAll()).rejects.toThrow('scan failed');

    expect((backend as unknown as { db: Database.Database }).db.inTransaction).toBe(false);
    expect(indexedCount()).toBeGreaterThan(0);
    expect(indexedCount()).toBeLessThan(DOCS);
  });
});
