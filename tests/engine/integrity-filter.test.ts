// verifyIntegrity with a filter must check every matching record, not one
// default page of them.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MaadEngine } from '../../src/engine.js';
import { docType } from '../../src/types.js';

const TAMPERED = 120;

let root: string;
let engine: MaadEngine;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'maad-integrity-filter-'));
  mkdirSync(path.join(root, '_registry'));
  mkdirSync(path.join(root, '_schema'));
  mkdirSync(path.join(root, 'data/notes'), { recursive: true });
  writeFileSync(path.join(root, '_registry/object_types.yaml'),
    'types:\n  note:\n    path: data/notes\n    id_prefix: note\n    schema: note.v1\n');
  writeFileSync(path.join(root, '_schema/note.v1.yaml'), [
    'type: note', 'version: 1', 'required:', '  - doc_id', 'fields:',
    '  status:', '    type: enum', '    values: [draft, final]', '    index: true', ''].join('\n'));
  engine = new MaadEngine();
  const init = await engine.init(root);
  expect(init.ok).toBe(true);

  const created = await engine.bulkCreate(Array.from({ length: TAMPERED + 5 }, (_, i) => ({
    docType: 'note',
    docId: `note-${i}`,
    fields: { status: i < TAMPERED ? 'final' : 'draft' },
    body: 'Body',
  })));
  expect(created.ok).toBe(true);
  for (let i = 0; i < TAMPERED + 5; i++) {
    appendFileSync(path.join(root, 'data/notes', `note-${i}.md`), 'tampered\n');
  }
});

afterEach(() => {
  engine.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('verifyIntegrity filter scope', () => {
  it('checks every record that matches the filter', async () => {
    const filtered = await engine.verifyIntegrity({
      docType: docType('note'),
      filter: { status: 'final' },
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) return;
    expect(filtered.value.findings.hash_drift).toBe(TAMPERED);

    const unfiltered = await engine.verifyIntegrity({ docType: docType('note') });
    expect(unfiltered.ok).toBe(true);
    if (!unfiltered.ok) return;
    expect(unfiltered.value.findings.hash_drift).toBe(TAMPERED + 5);
  });
});
