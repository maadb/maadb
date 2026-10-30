import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { OperationJournal } from '../../src/engine/journal.js';
import { docId, docType } from '../../src/types.js';

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
}));

let root: string;
let journalPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'maad-journal-persistence-'));
  journalPath = path.join(root, 'journal.json');
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(path.dirname(root)).toBe(fs.realpathSync(tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('operation journal persistence', () => {
  it('preserves disk and memory evidence when atomic replacement fails', () => {
    const journal = new OperationJournal(root);
    const id = journal.begin('create', 'note-one', path.join(root, 'note-one.md'));
    journal.advance(id, 'indexed');
    const before = fs.readFileSync(journalPath, 'utf8');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('publication denied'), { code: 'EACCES' });
    });

    expect(() => journal.complete(id)).toThrow('publication denied');
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(before);
    expect(journal.getIndexedPending().map(entry => entry.id)).toEqual([id]);
    expect(fs.readdirSync(root)).toEqual(['journal.json']);
    expect(new OperationJournal(root).getIndexedPending().map(entry => entry.id)).toEqual([id]);

    rename.mockRestore();
    journal.complete(id);
    expect(new OperationJournal(root).getPending()).toEqual([]);
  });

  it.each(['[{', '{}', '[null]', '[{"status":"indexed"}]'])('rejects corrupt journal %s without overwriting it', raw => {
    fs.writeFileSync(journalPath, raw);
    expect(() => new OperationJournal(root)).toThrow('Invalid operation journal');
    expect(fs.readFileSync(journalPath, 'utf8')).toBe(raw);
  });

  it('reports read failures instead of silently resetting recovery', () => {
    vi.spyOn(fs, 'readFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('read denied'), { code: 'EACCES' });
    });
    expect(() => new OperationJournal(root)).toThrow('read denied');
  });

  describe('commit storage', () => {
    const commitFor = (files: string[]) => ({
      action: 'create' as const,
      docId: docId('note-1'),
      docType: docType('note'),
      detail: `bulk:${files.length}`,
      summary: `Bulk created ${files.length} records`,
      files,
    });
    const indexedEntries = (journal: OperationJournal, count: number) => Array.from({ length: count }, (_, i) => {
      const file = path.join(root, `note-${i}.md`);
      const id = journal.begin('create', `note-${i}`, file);
      journal.advance(id, 'indexed');
      return { id, file };
    });

    it('stores a bulk commit once however many entries share it', () => {
      const journal = new OperationJournal(root);
      const entries = indexedEntries(journal, 200);
      const files = entries.map(entry => entry.file);
      journal.bindCommit(entries.map(entry => entry.id), commitFor(files));

      const raw = fs.readFileSync(journalPath, 'utf8');
      expect(raw.split('note-199.md').length - 1).toBe(2);
      const parsed = JSON.parse(raw) as { commits: Record<string, unknown>; entries: Array<{ commitId: string }> };
      expect(Object.keys(parsed.commits)).toHaveLength(1);
      expect(new Set(parsed.entries.map(entry => entry.commitId)).size).toBe(1);

      const reopened = new OperationJournal(root);
      for (const entry of reopened.getIndexedPending()) {
        expect(reopened.getCommit(entry)?.files).toEqual(files);
      }
    });

    it('drops a commit once no entry references it', () => {
      const journal = new OperationJournal(root);
      const entries = indexedEntries(journal, 2);
      journal.bindCommit(entries.map(entry => entry.id), commitFor(entries.map(entry => entry.file)));

      journal.complete(entries[0]!.id);
      expect(Object.keys((JSON.parse(fs.readFileSync(journalPath, 'utf8')) as { commits: object }).commits)).toHaveLength(1);
      journal.complete(entries[1]!.id);
      expect(JSON.parse(fs.readFileSync(journalPath, 'utf8'))).toMatchObject({ commits: {}, entries: [] });
    });

    it('keeps the bound commit when a later replacement fails', () => {
      const journal = new OperationJournal(root);
      const [entry] = indexedEntries(journal, 1);
      journal.bindCommit([entry!.id], commitFor([entry!.file]));
      const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw Object.assign(new Error('publication denied'), { code: 'EACCES' });
      });

      expect(() => journal.complete(entry!.id)).toThrow('publication denied');
      rename.mockRestore();
      const [pending] = journal.getIndexedPending();
      expect(journal.getCommit(pending!)?.files).toEqual([entry!.file]);
    });

    it('loads a pre-version-2 journal and collapses its inlined commits', () => {
      const files = [path.join(root, 'a.md'), path.join(root, 'b.md')];
      const legacy = (id: string, filePath: string, commit: unknown) => ({
        id, op: 'create', docId: id, filePath, timestamp: '2026-10-30T00:00:00.000Z', status: 'indexed', commit,
      });
      fs.writeFileSync(journalPath, JSON.stringify([
        legacy('a', files[0]!, commitFor(files)),
        legacy('b', files[1]!, commitFor(files)),
        legacy('c', path.join(root, 'c.md'), undefined),
      ]));

      const journal = new OperationJournal(root);
      const [a, b, c] = journal.getIndexedPending();
      expect(journal.getCommit(a!)).toEqual(commitFor(files));
      expect(b!.commitId).toBe(a!.commitId);
      expect(journal.getCommit(c!)).toBeUndefined();

      journal.setFiles('c', [path.join(root, 'c.md')]);
      expect(JSON.parse(fs.readFileSync(journalPath, 'utf8'))).toMatchObject({ version: 2 });
      expect(new OperationJournal(root).getCommit(a!)).toEqual(commitFor(files));
    });

    it.each([
      ['a dangling commit reference', { version: 2, commits: {}, entries: [{ id: 'a', op: 'create', docId: 'a', filePath: 'a.md', timestamp: 't', status: 'indexed', commitId: 'gone' }] }],
      ['a malformed commit', { version: 2, commits: { x: { action: 'create' } }, entries: [] }],
      ['an unknown version', { version: 3, commits: {}, entries: [] }],
    ])('rejects %s without overwriting it', (_name, content) => {
      const raw = JSON.stringify(content);
      fs.writeFileSync(journalPath, raw);
      expect(() => new OperationJournal(root)).toThrow('Invalid operation journal');
      expect(fs.readFileSync(journalPath, 'utf8')).toBe(raw);
    });
  });

  it('accepts a missing journal for a new project', () => {
    expect(new OperationJournal(root).getPending()).toEqual([]);
    expect(fs.existsSync(journalPath)).toBe(false);
  });
});
