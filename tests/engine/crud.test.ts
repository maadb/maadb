import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docId, docType, filePath as toFilePath, schemaRef } from '../../src/types.js';
import { SqliteBackend } from '../../src/backend/sqlite/index.js';

// Use a temp copy of the fixture to avoid mutating it
const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-crud');

let engine: MaadEngine;

beforeAll(async () => {
  // Copy fixture to temp
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, maxRetries: 10, retryDelay: 200 });
  cpSync(FIXTURE_SRC, TEMP_ROOT, { recursive: true });

  // Remove _backend if copied
  const backendDir = path.join(TEMP_ROOT, '_backend');
  if (existsSync(backendDir)) rmSync(backendDir, { recursive: true, maxRetries: 10, retryDelay: 200 });

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
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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

  it('guards against frontmatter wipe — rejects update that removes required fields', async () => {
    // Get current state
    const before = await engine.getDocument(docId('cli-acme'), 'hot');
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const originalName = before.value.frontmatter['name'];

    // Try to set required field to empty string
    const result = await engine.updateDocument(
      docId('cli-acme'),
      { name: '' },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('FRONTMATTER_GUARD');

    // Verify original data is intact
    const after = await engine.getDocument(docId('cli-acme'), 'hot');
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.value.frontmatter['name']).toBe(originalName);
  });

  it('rejects non-object fields', async () => {
    const result = await engine.updateDocument(
      docId('cli-acme'),
      'not an object' as any,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('INVALID_FIELDS');
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
    const getResult = engine.findDocuments({ docType: docType('client') });
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

describe('bulkCreate', () => {
  it('creates multiple records in one call', async () => {
    const result = await engine.bulkCreate([
      { docType: 'client', fields: { name: 'Bulk Client A', status: 'active' } },
      { docType: 'client', fields: { name: 'Bulk Client B', status: 'prospect' } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.succeeded).toHaveLength(2);
    expect(result.value.failed).toHaveLength(0);
    expect(result.value.totalRequested).toBe(2);

    // Verify records exist
    const a = await engine.getDocument(docId(result.value.succeeded[0]!.docId), 'hot');
    expect(a.ok).toBe(true);
    const b = await engine.getDocument(docId(result.value.succeeded[1]!.docId), 'hot');
    expect(b.ok).toBe(true);
  });

  it('reports per-record failures without blocking others', async () => {
    const result = await engine.bulkCreate([
      { docType: 'client', fields: { name: 'Good Record', status: 'active' } },
      { docType: 'nonexistent', fields: { name: 'Bad Type' } },
      { docType: 'client', fields: { name: 'Another Good', status: 'inactive' } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.succeeded).toHaveLength(2);
    expect(result.value.failed).toHaveLength(1);
    expect(result.value.failed[0]!.index).toBe(1);
    expect(result.value.failed[0]!.error).toContain('not in registry');
  });

  it('rejects duplicate IDs within the same batch', async () => {
    const result = await engine.bulkCreate([
      { docType: 'client', fields: { name: 'Dup Test A', status: 'active' }, docId: 'cli-dup-test' },
      { docType: 'client', fields: { name: 'Dup Test B', status: 'active' }, docId: 'cli-dup-test' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // First succeeds, second fails because ID already exists
    expect(result.value.succeeded).toHaveLength(1);
    expect(result.value.failed).toHaveLength(1);
    expect(result.value.failed[0]!.error).toContain('already exists');
  });
});

describe('body thematic-break', () => {
  it('accepts --- separators in body as markdown thematic breaks, not multi-document YAML', async () => {
    const body = 'Part A\n\n---\n\nPart B\n\n---\n\nPart C';
    const result = await engine.createDocument(
      docType('client'),
      { name: 'Thematic Break Co', status: 'active' },
      body,
      'cli-thematic-break',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Record is indexed (not just written to disk)
    const get = await engine.getDocument(docId('cli-thematic-break'), 'cold');
    expect(get.ok).toBe(true);
    if (!get.ok) return;
    expect(get.value.body).toContain('Part A');
    expect(get.value.body).toContain('Part B');
    expect(get.value.body).toContain('Part C');
    expect(get.value.body).toContain('---');
  });

  it('accepts --- separators via updateDocument body replace', async () => {
    const result = await engine.updateDocument(
      docId('cli-thematic-break'),
      undefined,
      'Section 1\n\n---\n\nSection 2',
    );
    expect(result.ok).toBe(true);

    const get = await engine.getDocument(docId('cli-thematic-break'), 'cold');
    expect(get.ok).toBe(true);
    if (!get.ok) return;
    expect(get.value.body).toContain('Section 1');
    expect(get.value.body).toContain('Section 2');
  });

  it('accepts --- in body via bulkCreate without orphaning files', async () => {
    const result = await engine.bulkCreate([
      { docType: 'client', fields: { name: 'Bulk Break A', status: 'active' }, body: 'Top\n\n---\n\nBottom' },
      { docType: 'client', fields: { name: 'Bulk Break B', status: 'active' }, body: 'Plain body' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.succeeded).toHaveLength(2);
    expect(result.value.failed).toHaveLength(0);
  });
});

describe('bulkUpdate', () => {
  it('updates multiple records in one call', async () => {
    const result = await engine.bulkUpdate([
      { docId: 'cli-acme', fields: { status: 'inactive' } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.succeeded).toHaveLength(1);
    expect(result.value.failed).toHaveLength(0);

    // Verify update
    const doc = await engine.getDocument(docId('cli-acme'), 'hot');
    expect(doc.ok).toBe(true);
    if (doc.ok) expect(doc.value.frontmatter['status']).toBe('inactive');
  });

  it('reports failures for missing documents', async () => {
    const result = await engine.bulkUpdate([
      { docId: 'cli-acme', fields: { status: 'active' } },
      { docId: 'nonexistent-doc', fields: { name: 'Nope' } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.succeeded).toHaveLength(1);
    expect(result.value.failed).toHaveLength(1);
    expect(result.value.failed[0]!.error).toContain('not found');
  });
});

describe('lazy ID sampling', () => {
  const year = new Date().getFullYear();
  const notePattern = new RegExp(`^note-${year}-\\d{3}$`);
  const seqOf = (id: string): number => parseInt(id.slice(`note-${year}-`.length), 10);
  const noteFields = { case: 'cas-2026-001', author: 'tester', noted_at: '2026-10-11' };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createDocument skips sampling for explicit IDs and usable slugs', async () => {
    const sample = vi.spyOn(SqliteBackend.prototype, 'listDocIdsByPrefix');

    const explicit = await engine.createDocument(
      docType('client'), { name: 'Lazy Explicit', status: 'active' }, undefined, 'cli-lazy-explicit',
    );
    expect(explicit.ok).toBe(true);
    if (!explicit.ok) return;
    expect(explicit.value.docId).toBe('cli-lazy-explicit');

    const slug = await engine.createDocument(docType('client'), { name: 'Lazy Slug Co', status: 'active' });
    expect(slug.ok).toBe(true);
    if (!slug.ok) return;
    expect(slug.value.docId).toBe('cli-lazy-slug-co');

    expect(sample).not.toHaveBeenCalled();
  });

  it('duplicate explicit and slug IDs still fail with DUPLICATE_DOC_ID without sampling', async () => {
    const sample = vi.spyOn(SqliteBackend.prototype, 'listDocIdsByPrefix');

    const explicit = await engine.createDocument(
      docType('client'), { name: 'Someone Else', status: 'active' }, undefined, 'cli-acme',
    );
    expect(explicit.ok).toBe(false);
    if (explicit.ok) return;
    expect(explicit.errors[0]!.code).toBe('DUPLICATE_DOC_ID');

    const slug = await engine.createDocument(docType('client'), { name: 'Acme', status: 'active' });
    expect(slug.ok).toBe(false);
    if (slug.ok) return;
    expect(slug.errors[0]!.code).toBe('DUPLICATE_DOC_ID');

    expect(sample).not.toHaveBeenCalled();
  });

  it('createDocument samples once per sequence ID and honours explicit sequence-shaped IDs', async () => {
    const sample = vi.spyOn(SqliteBackend.prototype, 'listDocIdsByPrefix');

    const explicit = await engine.createDocument(docType('case_note'), noteFields, 'explicit', `note-${year}-900`);
    expect(explicit.ok).toBe(true);
    expect(sample).not.toHaveBeenCalled();

    const next = await engine.createDocument(docType('case_note'), noteFields, 'sequence');
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    expect(next.value.docId).toBe(`note-${year}-901`);
    expect(sample).toHaveBeenCalledTimes(1);
    expect(sample).toHaveBeenCalledWith(`note-${year}-`);
  });

  it('bulkCreate samples only for sequence records and preserves mixed allocation', async () => {
    const sample = vi.spyOn(SqliteBackend.prototype, 'listDocIdsByPrefix');

    const result = await engine.bulkCreate([
      { docType: 'client', fields: { name: 'Bulk Lazy Explicit', status: 'active' }, docId: 'cli-bulk-lazy-explicit' },
      { docType: 'client', fields: { name: 'Bulk Lazy Slug', status: 'active' } },
      { docType: 'nonexistent', fields: { name: 'Bad Type' } },
      { docType: 'case_note', fields: noteFields, body: 'bulk a' },
      { docType: 'client', fields: { name: 'Dup', status: 'active' }, docId: 'cli-acme' },
      { docType: 'case_note', fields: { case: 'cas-2026-001', noted_at: '2026-10-11' }, body: 'missing author' },
      { docType: 'case_note', fields: noteFields, body: 'bulk b' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { succeeded, failed } = result.value;
    expect(succeeded.map(s => s.index)).toEqual([0, 1, 3, 6]);
    expect(failed.map(f => f.index)).toEqual([2, 4, 5]);
    expect(succeeded[0]!.docId).toBe('cli-bulk-lazy-explicit');
    expect(succeeded[1]!.docId).toBe('cli-bulk-lazy-slug');
    expect(failed[1]!.error).toContain('already exists');

    const noteA = succeeded[2]!.docId;
    const noteB = succeeded[3]!.docId;
    expect(noteA).toMatch(notePattern);
    expect(seqOf(noteB)).toBe(seqOf(noteA) + 1);
    // The invalid sequence record was offered the next ID but did not consume it.
    expect(failed[2]!.docId).toBe(noteB);

    // Only the three sequence-strategy records sample; explicit, slug and
    // rejected-type records do not.
    expect(sample).toHaveBeenCalledTimes(3);
  });

  it('bulkCreate preserves earlier explicit IDs across types sharing a prefix', async () => {
    const registry = engine.getRegistry();
    const contactType = docType('contact');
    const original = registry.types.get(contactType);
    if (!original) throw new Error('Missing contact fixture registration');
    registry.types.set(contactType, { ...original, idPrefix: 'note' });
    const sample = vi.spyOn(SqliteBackend.prototype, 'listDocIdsByPrefix');
    try {
      const result = await engine.bulkCreate([
        { docType: 'contact', fields: { name: 'Explicit shared prefix' }, docId: `note-${year}-950` },
        { docType: 'case_note', fields: noteFields },
        { docType: 'contact', fields: { name: '!!!' } },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.failed).toEqual([]);
      expect(result.value.succeeded.map(s => s.docId)).toEqual([
        `note-${year}-950`, `note-${year}-951`, `note-${year}-952`,
      ]);
      expect(sample).toHaveBeenCalledTimes(2);
      // Both types scan the same complete prefix range, not a per-type sample.
      expect(sample).toHaveBeenNthCalledWith(1, `note-${year}-`);
      expect(sample).toHaveBeenNthCalledWith(2, `note-${year}-`);
    } finally {
      registry.types.set(contactType, original);
    }
  });
});

describe('sequence allocation reserves every indexed ID under the prefix', () => {
  const year = new Date().getFullYear();
  const noteFields = { case: 'cas-2026-001', author: 'tester', noted_at: '2026-10-11' };
  const createNote = (customId?: string) =>
    engine.createDocument(docType('case_note'), noteFields, 'allocation', customId);
  // Index-only rows: cheap to seed, no files on disk. Removed in the test's finally.
  const seedRow = (id: string, indexedAt: string): void => {
    engine.getBackend().putDocument({
      docId: docId(id),
      docType: docType('case_note'),
      schemaRef: schemaRef('case_note.v1'),
      createdAt: indexedAt,
      filePath: toFilePath(`case-notes/_seed/${id}.md`),
      fileHash: 'seed',
      version: 1,
      deleted: false,
      indexedAt,
      updatedAt: indexedAt,
    });
  };
  const withPrefix = async (type: string, idPrefix: string, run: () => Promise<void>): Promise<void> => {
    const registry = engine.getRegistry();
    const original = registry.types.get(docType(type));
    if (!original) throw new Error(`Missing ${type} fixture registration`);
    registry.types.set(docType(type), { ...original, idPrefix });
    try {
      await run();
    } finally {
      registry.types.set(docType(type), original);
    }
  };

  it('never reissues a soft-deleted highest ID and refuses explicit reuse of it', async () => {
    const tomb = `note-${year}-7000`;
    expect((await createNote(tomb)).ok).toBe(true);
    expect((await engine.deleteDocument(docId(tomb), 'soft')).ok).toBe(true);

    const next = await createNote();
    expect(next.ok, JSON.stringify(next)).toBe(true);
    if (!next.ok) return;
    expect(next.value.docId).toBe(`note-${year}-7001`);

    const reuse = await createNote(tomb);
    expect(reuse.ok).toBe(false);
    if (reuse.ok) return;
    expect(reuse.errors[0]!.code).toBe('DUPLICATE_DOC_ID');
    expect(reuse.errors[0]!.message).toContain('soft-deleted');

    // Default reads stay live-only; the tombstone row survives untouched.
    const backend = engine.getBackend();
    expect(backend.getDocument(docId(tomb))).toBeNull();
    const row = backend.getDocument(docId(tomb), { includeDeleted: true });
    expect(row?.deleted).toBe(true);
    expect(row?.filePath).toBe(`case-notes/_deleted_${tomb}.md`);
    expect((await engine.getDocument(docId(tomb), 'hot')).ok).toBe(false);
  });

  it('bulkCreate refuses tombstoned IDs and allocates above them across mixed failures', async () => {
    const tomb = `note-${year}-7500`;
    expect((await createNote(tomb)).ok).toBe(true);
    expect((await engine.deleteDocument(docId(tomb), 'soft')).ok).toBe(true);

    const result = await engine.bulkCreate([
      { docType: 'case_note', fields: noteFields, docId: tomb },
      { docType: 'case_note', fields: noteFields, body: 'bulk a' },
      { docType: 'case_note', fields: { case: 'cas-2026-001', noted_at: '2026-10-11' }, body: 'missing author' },
      { docType: 'nonexistent', fields: { name: 'Bad Type' } },
      { docType: 'case_note', fields: noteFields, body: 'bulk b' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { succeeded, failed } = result.value;
    expect(failed.map(f => f.index)).toEqual([0, 2, 3]);
    expect(failed[0]!.error).toContain('soft-deleted');
    // The invalid sequence record was offered the next ID but did not consume it.
    expect(failed[1]!.docId).toBe(`note-${year}-7502`);
    expect(succeeded.map(s => s.docId)).toEqual([`note-${year}-7501`, `note-${year}-7502`]);
    expect(engine.getBackend().getDocument(docId(tomb), { includeDeleted: true })?.deleted).toBe(true);
  });

  it('counts an explicit sequence-shaped ID created under another type sharing the prefix', async () => {
    await withPrefix('contact', 'note', async () => {
      const foreign = await engine.createDocument(
        docType('contact'), { name: 'Shared prefix contact' }, undefined, `note-${year}-8000`,
      );
      expect(foreign.ok, JSON.stringify(foreign)).toBe(true);
    });

    const next = await createNote();
    expect(next.ok, JSON.stringify(next)).toBe(true);
    if (!next.ok) return;
    expect(next.value.docId).toBe(`note-${year}-8001`);
  });

  it('lets the true highest suffix govern when 10000 newer same-type rows hide it', async () => {
    const hidden = `note-${year}-20000`;
    const priorYear = `note-${year - 1}-90000`;
    const newer = Array.from({ length: 10000 }, (_, n) => `note-${year}-${10000 + n}`);
    try {
      seedRow(hidden, '2000-01-01T00:00:00.000Z');
      seedRow(priorYear, '2000-01-01T00:00:00.000Z');
      for (const id of newer) seedRow(id, '9999-01-01T00:00:00.000Z');

      // A newest-first 10000-row sample sees only 10000..19999 and offers the
      // hidden 20000; the complete prefix scan allocates past it. The prior
      // year has a larger suffix but sits outside the scanned range.
      const next = await createNote();
      expect(next.ok, JSON.stringify(next)).toBe(true);
      if (!next.ok) return;
      expect(next.value.docId).toBe(`note-${year}-20001`);
    } finally {
      for (const id of [hidden, priorYear, ...newer]) engine.getBackend().removeDocument(docId(id));
    }
  }, 60_000);

  it('allocates numerically past 999 and ignores previous-year suffixes', async () => {
    await withPrefix('contact', 'wid', async () => {
      const explicit = await engine.createDocument(docType('contact'), { name: 'Width' }, undefined, `wid-${year}-999`);
      expect(explicit.ok, JSON.stringify(explicit)).toBe(true);
      const prior = await engine.createDocument(docType('contact'), { name: 'Prior' }, undefined, `wid-${year - 1}-5000`);
      expect(prior.ok, JSON.stringify(prior)).toBe(true);

      const first = await engine.createDocument(docType('contact'), { name: '!!!' });
      expect(first.ok && first.value.docId).toBe(`wid-${year}-1000`);
      // Lexicographically 1000 sorts before 999; allocation must stay numeric.
      const second = await engine.createDocument(docType('contact'), { name: '!!!' });
      expect(second.ok && second.value.docId).toBe(`wid-${year}-1001`);
    });
  });
});
