import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MaadEngine } from '../../src/engine.js';
import { parseMatter } from '../../src/parser/matter.js';
import { docId, docType } from '../../src/types.js';

const TEMP_PARENT = realpathSync(tmpdir());
let root: string;
let engine: MaadEngine;

beforeEach(async () => {
  root = mkdtempSync(path.join(TEMP_PARENT, 'maad-serializer-flow-'));
  for (const dir of ['_registry', '_schema', 'notes']) mkdirSync(path.join(root, dir));
  writeFileSync(path.join(root, '_registry', 'object_types.yaml'),
    'types:\n  note:\n    path: notes/\n    id_prefix: note\n    schema: note.v1\n');
  writeFileSync(path.join(root, '_schema', 'note.v1.yaml'), `type: note
version: 1
required: [doc_id, title]
fields:
  title:
    type: string
  paths:
    type: list
    item_type: string
    index: true
`);
  engine = new MaadEngine();
  expect((await engine.init(root)).ok).toBe(true);
  expect(await engine.indexAll({ force: true })).toMatchObject({ errors: [] });
});

afterEach(async () => {
  await engine?.close();
  if (root) {
    const resolved = realpathSync(root);
    expect(path.dirname(resolved)).toBe(TEMP_PARENT);
    expect(path.basename(resolved)).toMatch(/^maad-serializer-flow-/);
    rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

async function expectStored(id: string, fields: Record<string, unknown>): Promise<string> {
  const raw = readFileSync(path.join(root, 'notes', `${id}.md`), 'utf-8');
  const expected = { ...fields, doc_id: id, doc_type: 'note', schema: 'note.v1' };
  expect(parseMatter(raw).data).toStrictEqual(expected);
  const fetched = await engine.getDocument(docId(id), 'cold');
  expect(fetched.ok).toBe(true);
  if (!fetched.ok) throw new Error(JSON.stringify(fetched.errors));
  expect(fetched.value.frontmatter).toStrictEqual(expected);
  expect(fetched.value.body).toBe('# Body');
  return raw;
}

async function expectReindexed(id: string, fields: Record<string, unknown>): Promise<void> {
  const before = await expectStored(id, fields);
  const reindexed = await engine.reindex({ docId: docId(id), force: true });
  expect(reindexed.ok).toBe(true);
  if (!reindexed.ok) throw new Error(JSON.stringify(reindexed.errors));
  expect(reindexed.value.errors).toStrictEqual([]);
  expect(reindexed.value.indexed).toBe(1);
  expect(await expectStored(id, fields)).toBe(before);
}

describe('engine flow-sequence round trips', () => {
  it.each(['src/routes/[itemId]/route.ts', 'src/a,b.ts'])(
    'preserves %s on create, unrelated update, reindex, and reopen', async value => {
      const id = 'note-create-flow';
      const fields = { title: 'Flow strings', paths: [value] };
      const created = await engine.createDocument(docType('note'), fields, '# Body', id);
      expect(created.ok).toBe(true);
      await expectReindexed(id, fields);

      const updated = { ...fields, title: 'Updated title' };
      expect((await engine.updateDocument(docId(id), { title: updated.title })).ok).toBe(true);
      await expectReindexed(id, updated);

      await engine.close();
      engine = new MaadEngine();
      expect((await engine.init(root)).ok).toBe(true);
      expect(await engine.indexAll({ force: true })).toMatchObject({ errors: [] });
      await expectStored(id, updated);
    },
  );

  it.each(['src/routes/[itemId]/route.ts', 'src/a,b.ts'])(
    'preserves %s when updating an existing valid document', async value => {
      const id = 'note-update-flow';
      const initial = { title: 'Flow strings', paths: ['plain'] };
      expect((await engine.createDocument(docType('note'), initial, '# Body', id)).ok).toBe(true);
      const paths = ['before', value, 'after'];
      expect((await engine.updateDocument(docId(id), { paths })).ok).toBe(true);
      await expectReindexed(id, { ...initial, paths });
    },
  );

  it('preserves punctuation, escapes, empty strings, nested extras, and scalar types', async () => {
    const id = 'note-mixed-flow';
    const paths = [
      'src/routes/[itemId]/route.ts', 'src/a,b.ts',
      'a[b', 'a]b', 'a{b', 'a}b', 'a:b', 'a: b', 'a # b',
      '', ' ', ' padded ', '\t', 'a\tb', 'a\nb', 'a\rb', 'a\r\nb',
      'src\\[item]\\file.ts', 'says "hi", then \'bye\'',
      'true', 'false', 'null', '007', '-42', '3.5',
    ];
    // The engine YAML profile permits two list levels; the raw writer tests
    // also cover deeper nesting independently of that validation boundary.
    const extras = [true, false, null, 7, -42, 3.5, 'true', '007', 'null',
      [], ['a,b', 'x[y]', '', false, 0, null]];
    const fields = { title: 'Mixed flow', paths, extras };
    const created = await engine.createDocument(docType('note'), fields, '# Body', id);
    expect(created.ok, JSON.stringify(created)).toBe(true);
    await expectReindexed(id, fields);

    const updated = { ...fields, paths: [...paths].reverse(), extras: [...extras].reverse() };
    expect((await engine.updateDocument(docId(id), { paths: updated.paths, extras: updated.extras })).ok).toBe(true);
    await expectReindexed(id, updated);
    expect((await engine.updateDocument(docId(id), { title: 'Updated mixed flow' })).ok).toBe(true);
    await expectReindexed(id, { ...updated, title: 'Updated mixed flow' });
  });
});
