import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteBackend } from '../../src/backend/sqlite/index.js';
import { docId, docType, schemaRef, filePath } from '../../src/types.js';
import type { EngineContext } from '../../src/engine/context.js';

/** Synthetic index fixture; no canonical files, Git, network, or background worker. */
export function scopeFixture(size: number) {
  const root = mkdtempSync(path.join(tmpdir(), 'maadb-scope-'));
  const backend = new SqliteBackend(path.join(root, 'index.db'));
  backend.init();
  backend.initSemantic({ dim: 2, model: 'scope-fixture' });
  const sem = backend.semantic()!;
  function add(id: string, text: string, type = 'note', access = 'public', indexedAt = '2026-01-01') {
    backend.putDocument({ docId: docId(id), docType: docType(type), schemaRef: schemaRef('note.v1'),
      filePath: filePath(`notes/${id}.md`), fileHash: id, version: 1, deleted: false,
      indexedAt, updatedAt: '2020-01-01', createdAt: '2020-01-01', valid: true });
    backend.putFieldIndex(docId(id), [
      { name: 'access', value: access, numericValue: null, type: 'string' },
      { name: 'amount', value: '12', numericValue: 12, type: 'number' },
    ]);
    sem.putBlockText(id, [{ blockOrd: 0, blockId: null, heading: 'Evidence', text }]);
  }
  add('old', 'uniqueneedle foundational decision', 'note', 'public', '2000-01-01');
  for (let i = 1; i < size; i++) add(`new-${i.toString().padStart(6, '0')}`, 'routine unrelated update');
  const ctx = { backend, embeddingProvider: {
    id: 'fixture', model: 'scope-fixture', dim: 2,
    embed: async () => [new Float32Array([1, 0])],
  } } as EngineContext;
  return { root, backend, sem, ctx, add, close() {
    backend.close();
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('maadb-scope-')) {
      throw new Error('Unexpected fixture cleanup root');
    }
    rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } };
}
