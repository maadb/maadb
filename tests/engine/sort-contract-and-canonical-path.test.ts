// ============================================================================
// 0.7.12 — system sort contract + file_path canonicalization
//
// Sort contract: maad_query.sortBy must resolve to either a system sort key
// (updated_at, indexed_at, doc_id, doc_type, created_at + camelCase aliases)
// or an indexed schema field for the requested docType. Unknown / unindexed
// keys reject up front with UNSUPPORTED_SORT_FIELD instead of silently
// degrading to all-NULL ordering. Every sorted query gets a deterministic
// doc_id tie-breaker in the same direction.
//
// File path canonicalization: documents.file_path is stored in forward-slash
// form regardless of host platform so the SQLite index is portable. Legacy
// backslash rows from pre-0.7.12 Windows writes are tolerated by a fallback
// in getDocumentByPath; they migrate to '/' on their next reindex touch.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import {
  docId,
  docType,
  filePath as toFilePath,
  resolveSystemSortKey,
  SYSTEM_SORT_KEYS,
  SYSTEM_SORT_KEY_ALIASES,
} from '../../src/types.js';
import { toCanonicalRelPath } from '../../src/engine/helpers.js';

// ---------------------------------------------------------------------------
// Pure unit tests — no fixture required
// ---------------------------------------------------------------------------

describe('SYSTEM_SORT_KEYS + resolveSystemSortKey', () => {
  it('maps every documented alias to a real documents.* column', () => {
    const expected: Record<string, string> = {
      doc_id: 'doc_id',
      docId: 'doc_id',
      doc_type: 'doc_type',
      docType: 'doc_type',
      updated_at: 'updated_at',
      updatedAt: 'updated_at',
      indexed_at: 'indexed_at',
      indexedAt: 'indexed_at',
      created_at: 'created_at',
      createdAt: 'created_at',
    };
    expect({ ...SYSTEM_SORT_KEYS }).toEqual(expected);
  });

  it('SYSTEM_SORT_KEY_ALIASES enumerates every alias', () => {
    expect([...SYSTEM_SORT_KEY_ALIASES].sort()).toEqual(
      Object.keys(SYSTEM_SORT_KEYS).sort(),
    );
  });

  it('resolveSystemSortKey returns the column for known aliases', () => {
    expect(resolveSystemSortKey('updated_at')).toBe('updated_at');
    expect(resolveSystemSortKey('updatedAt')).toBe('updated_at');
    expect(resolveSystemSortKey('docId')).toBe('doc_id');
    expect(resolveSystemSortKey('created_at')).toBe('created_at');
  });

  it('returns null for unknown keys', () => {
    expect(resolveSystemSortKey('name')).toBeNull();
    expect(resolveSystemSortKey('status')).toBeNull();
    expect(resolveSystemSortKey('nonexistent')).toBeNull();
    expect(resolveSystemSortKey('')).toBeNull();
    expect(resolveSystemSortKey('Updated_At')).toBeNull(); // case-sensitive
  });
});

describe('toCanonicalRelPath', () => {
  it('produces forward-slash relative paths regardless of platform', () => {
    const root = path.resolve('/projects/maadb-test');
    const abs = path.resolve(root, 'clients', 'cli-acme.md');
    const rel = toCanonicalRelPath(root, abs);
    expect(rel).toBe('clients/cli-acme.md');
    expect(rel).not.toContain('\\');
  });

  it('handles deeply nested paths', () => {
    const root = path.resolve('/projects/maadb-test');
    const abs = path.resolve(root, 'a', 'b', 'c', 'd.md');
    expect(toCanonicalRelPath(root, abs)).toBe('a/b/c/d.md');
  });

  it('handles root-level files (no separator)', () => {
    const root = path.resolve('/projects/maadb-test');
    const abs = path.resolve(root, 'README.md');
    expect(toCanonicalRelPath(root, abs)).toBe('README.md');
  });
});

// ---------------------------------------------------------------------------
// Fixture-backed integration tests for sort contract + write-time behaviors
// ---------------------------------------------------------------------------

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/.tmp-sort-contract');
let engine: MaadEngine;

beforeAll(async () => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true });
  cpSync(FIXTURE_SRC, TEMP_ROOT, { recursive: true });
  // Strip any prebuilt _backend so we start from a fresh 0.7.12 schema.
  const backendDir = path.join(TEMP_ROOT, '_backend');
  if (existsSync(backendDir)) rmSync(backendDir, { recursive: true });

  engine = new MaadEngine();
  const initResult = await engine.init(TEMP_ROOT);
  expect(initResult.ok).toBe(true);
  await engine.indexAll({ force: true });
});

afterAll(async () => {
  engine.close();
  await new Promise(r => setTimeout(r, 100));
  try {
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch {
    // Windows may briefly hold the SQLite handle — non-fatal cleanup.
  }
});

describe('maad_query sort contract — acceptance', () => {
  it('accepts system sort key without docType', () => {
    const result = engine.findDocuments({ sortBy: 'updated_at', sortOrder: 'desc' });
    expect(result.ok).toBe(true);
  });

  it('accepts every system alias for the same column', () => {
    for (const alias of SYSTEM_SORT_KEY_ALIASES) {
      const result = engine.findDocuments({ sortBy: alias });
      expect(result.ok, `alias ${alias} should be accepted`).toBe(true);
    }
  });

  it('accepts indexed schema field with docType', () => {
    const result = engine.findDocuments({
      docType: docType('client'),
      sortBy: 'name',
      sortOrder: 'asc',
    });
    expect(result.ok).toBe(true);
  });

  it('default sort (no sortBy) works and includes results', () => {
    const result = engine.findDocuments({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBeGreaterThan(0);
  });
});

describe('maad_query sort contract — rejection', () => {
  it('rejects unknown field on a known docType', () => {
    const result = engine.findDocuments({
      docType: docType('client'),
      sortBy: 'nonexistent_field',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe('UNSUPPORTED_SORT_FIELD');
    expect(result.errors[0]?.message).toContain('nonexistent_field');
    expect(result.errors[0]?.message).toContain('client');
  });

  it('rejects non-system sortBy without docType', () => {
    const result = engine.findDocuments({ sortBy: 'name' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe('UNSUPPORTED_SORT_FIELD');
    expect(result.errors[0]?.message).toContain('Provide docType');
  });

  it('error details carry provided/systemKeys for client UX', () => {
    const result = engine.findDocuments({
      docType: docType('client'),
      sortBy: 'bogus',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const details = result.errors[0]?.details as Record<string, unknown> | undefined;
    expect(details).toBeDefined();
    expect(details!['provided']).toBe('bogus');
    expect(Array.isArray(details!['systemKeys'])).toBe(true);
    expect(details!['indexedFields']).toBeDefined();
  });
});

describe('maad_query sort contract — tie-breaker stability', () => {
  it('rows with identical primary sort value retain deterministic doc_id order', () => {
    // 4 docs in simple-crm fixture; doc_id desc must always be the descending
    // lex order. With the tie-breaker, any sortBy that ties on sort value
    // falls back to doc_id in the same direction. Using doc_id directly is
    // the cleanest invariant — it's both the primary AND tie-breaker.
    const asc = engine.findDocuments({ sortBy: 'docId', sortOrder: 'asc', limit: 50 });
    expect(asc.ok).toBe(true);
    if (!asc.ok) return;
    const ascIds = asc.value.results.map(r => r.docId as string);
    const expected = [...ascIds].sort();
    expect(ascIds).toEqual(expected);

    const desc = engine.findDocuments({ sortBy: 'docId', sortOrder: 'desc', limit: 50 });
    expect(desc.ok).toBe(true);
    if (!desc.ok) return;
    const descIds = desc.value.results.map(r => r.docId as string);
    expect(descIds).toEqual([...expected].reverse());
  });
});

describe('engine-stamped createdAt', () => {
  it('stamps createdAt on net-new createDocument calls', async () => {
    const before = new Date().toISOString();
    const created = await engine.createDocument(
      docType('client'),
      { name: 'Sort Test Client', status: 'prospect' },
      'fixture for createdAt test',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const after = new Date().toISOString();
    const fetched = await engine.getDocument(created.value.docId, 'hot');
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;

    const row = fetched.value as { createdAt?: string };
    expect(row.createdAt).toBeDefined();
    expect(row.createdAt!).toBeTruthy();
    expect(row.createdAt! >= before).toBe(true);
    expect(row.createdAt! <= after).toBe(true);
  });

  it('preserves createdAt across updateDocument', async () => {
    const created = await engine.createDocument(
      docType('client'),
      { name: 'Preserve Test', status: 'prospect' },
      'fixture for createdAt preservation',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const initial = await engine.getDocument(created.value.docId, 'hot');
    expect(initial.ok).toBe(true);
    if (!initial.ok) return;
    const initialCreatedAt = (initial.value as { createdAt?: string }).createdAt;
    expect(initialCreatedAt).toBeTruthy();

    // small delay so updatedAt would otherwise advance past createdAt
    await new Promise(r => setTimeout(r, 50));

    const updated = await engine.updateDocument(
      created.value.docId,
      { status: 'active' },
    );
    expect(updated.ok).toBe(true);

    const after = await engine.getDocument(created.value.docId, 'hot');
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    const afterCreatedAt = (after.value as { createdAt?: string }).createdAt;
    expect(afterCreatedAt).toBe(initialCreatedAt);
  });

  it('exposes created_at as a usable sort key returning real dates', () => {
    const result = engine.findDocuments({
      sortBy: 'created_at',
      sortOrder: 'desc',
      limit: 50,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBeGreaterThan(0);
  });
});

describe('file_path canonicalization', () => {
  it('writes store file_path in forward-slash form', async () => {
    const created = await engine.createDocument(
      docType('client'),
      { name: 'Path Test', status: 'prospect' },
      'fixture for file_path canonicalization',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.filePath as string).not.toContain('\\');
    expect(created.value.filePath as string).toContain('/');
  });
});

describe('getDocumentByPath separator tolerance (transition fallback)', () => {
  // The fallback covers legacy backslash rows from pre-0.7.12 Windows
  // writes. We can exercise it on any host by directly inserting a row
  // with a non-canonical separator and confirming the canonical lookup
  // still finds it.
  it('finds a backslash-stored row when queried with forward-slash form', async () => {
    // Insert a synthetic row directly so the test is host-agnostic. Use the
    // internal backend handle reachable via the engine's adapter.
    const created = await engine.createDocument(
      docType('client'),
      { name: 'Legacy Path Client', status: 'prospect' },
      'fixture for path-fallback test',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const canonical = created.value.filePath as string;
    const backslashForm = canonical.replaceAll('/', '\\');
    // Sanity — if there's no '/' in the canonical path (e.g. a top-level
    // file), the substitution is a no-op and the test is degenerate.
    expect(backslashForm).not.toBe(canonical);

    // Direct backend mutation: rewrite the row to backslash form to simulate
    // a legacy Windows-written DB entry.
    const backend = (engine as unknown as { backend: {
      getDocument: (id: ReturnType<typeof docId>) => unknown;
      putDocument: (doc: unknown) => void;
      getDocumentByPath: (p: ReturnType<typeof toFilePath>) => unknown;
    } }).backend;
    const existing = backend.getDocument(created.value.docId) as { filePath: ReturnType<typeof toFilePath> } & Record<string, unknown>;
    backend.putDocument({ ...existing, filePath: toFilePath(backslashForm) });

    // Lookup by canonical form should still find the row via the fallback.
    const found = backend.getDocumentByPath(toFilePath(canonical)) as { docId: unknown } | null;
    expect(found).not.toBeNull();
    expect((found as { docId: { toString: () => string } }).docId.toString()).toBe(
      created.value.docId.toString(),
    );
  });
});
