import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docId, docType } from '../../src/types.js';

// Use a temp copy of the fixture to avoid mutating it
const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-crud');

let engine: MaadEngine;

beforeAll(async () => {
  // Copy fixture to temp
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true });
  cpSync(FIXTURE_SRC, TEMP_ROOT, { recursive: true });

  // Remove _backend if copied
  const backendDir = path.join(TEMP_ROOT, '_backend');
  if (existsSync(backendDir)) rmSync(backendDir, { recursive: true });

  engine = new MaadEngine();
  const result = await engine.init(TEMP_ROOT);
  expect(result.ok).toBe(true);

  // Index existing files
  await engine.indexAll({ force: true });
});

afterAll(async () => {
  engine.close();
  await new Promise(r => setTimeout(r, 100));
  try {
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch {
    // Windows may hold handles briefly — non-fatal
  }
});

describe('createDocument', () => {
  it('creates a new document with auto-generated ID', async () => {
    const result = await engine.createDocument(
      docType('client'),
      { name: 'Beta Inc', status: 'prospect', tags: ['startup'] },
      'A new prospect client.',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.docId).toMatch(/^cli-/);
    expect(result.value.version).toBe(1);

    // Verify it's in the index
    const getResult = await engine.getDocument(result.value.docId, 'hot');
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value.frontmatter.name).toBe('Beta Inc');
  });

  it('creates with custom doc_id', async () => {
    const result = await engine.createDocument(
      docType('contact'),
      { name: 'Bob Torres', client: 'cli-acme' },
      'Vendor representative.',
      'con-bob-torres',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.docId).toBe('con-bob-torres');
  });

  it('rejects duplicate doc_id', async () => {
    const result = await engine.createDocument(
      docType('client'),
      { name: 'Duplicate', status: 'active' },
      undefined,
      'cli-acme',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('DUPLICATE_DOC_ID');
  });

  it('rejects invalid schema', async () => {
    const result = await engine.createDocument(
      docType('client'),
      { name: 'Missing Status' }, // status is required
    );
    expect(result.ok).toBe(false);
  });
});

describe('updateDocument', () => {
  it('updates frontmatter fields', async () => {
    const result = await engine.updateDocument(
      docId('cli-acme'),
      { status: 'inactive' },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changedFields).toContain('status');

    const getResult = await engine.getDocument(docId('cli-acme'), 'hot');
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value.frontmatter.status).toBe('inactive');
  });

  it('appends body content', async () => {
    const result = await engine.updateDocument(
      docId('cli-acme'),
      undefined,
      undefined,
      '## New Section\n\nAppended content.',
    );
    expect(result.ok).toBe(true);

    const getResult = await engine.getDocument(docId('cli-acme'), 'cold');
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    expect(getResult.value.body).toContain('Appended content.');
  });

  it('rejects version conflict', async () => {
    const result = await engine.updateDocument(
      docId('cli-acme'),
      { status: 'active' },
      undefined,
      undefined,
      999, // wrong version
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('VERSION_CONFLICT');
  });

  it('rejects invalid field value', async () => {
    const result = await engine.updateDocument(
      docId('cli-acme'),
      { status: 'nonexistent_status' },
    );
    expect(result.ok).toBe(false);
  });
});

describe('reindex stale cleanup', () => {
  it('removes stale backend records when files are deleted externally', async () => {
    // Create a doc
    const createResult = await engine.createDocument(
      docType('client'),
      { name: 'Stale Corp', status: 'active' },
      'Will be deleted externally.',
      'cli-stale',
    );
    expect(createResult.ok).toBe(true);

    // Verify it's in the index
    const getResult = engine.findDocuments({ docType: docType('client'), includeFrontmatter: true });
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;
    const staleBefore = getResult.value.results.find(r => (r.docId as string) === 'cli-stale');
    expect(staleBefore).toBeDefined();

    // Delete the file externally (outside MAAD)
    const { unlinkSync } = await import('node:fs');
    const fp = path.join(TEMP_ROOT, 'clients', 'cli-stale.md');
    unlinkSync(fp);

    // Reindex — should clean up the stale record
    const reindexResult = await engine.reindex({ force: true });
    expect(reindexResult.ok).toBe(true);

    // Verify stale record is gone
    const backend = engine.getBackend();
    expect(backend.getDocument(docId('cli-stale'))).toBeNull();

    // Objects and relationships should also be gone
    const objects = backend.findObjects({ docId: docId('cli-stale') });
    expect(objects).toHaveLength(0);
  });
});

describe('deleteDocument', () => {
  it('soft deletes a document', async () => {
    // Create a throwaway doc
    const createResult = await engine.createDocument(
      docType('case_note'),
      { case: 'cas-2026-001', author: 'test', noted_at: '2026-04-06', note_type: 'update' },
      'Throwaway note.',
      'note-throwaway',
    );
    expect(createResult.ok).toBe(true);

    const delResult = await engine.deleteDocument(docId('note-throwaway'), 'soft');
    expect(delResult.ok).toBe(true);
    if (!delResult.ok) return;
    expect(delResult.value.mode).toBe('soft');

    // Should not be findable
    const getResult = await engine.getDocument(docId('note-throwaway'), 'hot');
    expect(getResult.ok).toBe(false);

    // Deleted file should exist
    const deletedPath = path.join(TEMP_ROOT, 'case-notes', '_deleted_note-throwaway.md');
    expect(existsSync(deletedPath)).toBe(true);
  });
});
