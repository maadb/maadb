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
let logPath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(tmpdir(), 'maad-journal-persistence-'));
  journalPath = path.join(root, 'journal.json');
  logPath = path.join(root, 'journal.log');
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(path.dirname(root)).toBe(fs.realpathSync(tmpdir()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe('operation journal persistence', () => {
  it('preserves disk and memory evidence when an append fails', () => {
    const journal = new OperationJournal(root);
    const id = journal.begin('create', 'note-one', path.join(root, 'note-one.md'));
    journal.advance(id, 'indexed');
    const before = fs.readFileSync(logPath, 'utf8');
    const append = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw Object.assign(new Error('append denied'), { code: 'EACCES' });
    });

    expect(() => journal.complete(id)).toThrow('append denied');
    expect(fs.readFileSync(logPath, 'utf8')).toBe(before);
    expect(journal.getIndexedPending().map(entry => entry.id)).toEqual([id]);
    expect(new OperationJournal(root).getIndexedPending().map(entry => entry.id)).toEqual([id]);

    append.mockRestore();
    journal.complete(id);
    expect(new OperationJournal(root).getPending()).toEqual([]);
  });

  it('keeps the previous snapshot when replacing it fails', () => {
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('publication denied'), { code: 'EACCES' });
    });
    const journal = new OperationJournal(root);

    expect(() => journal.begin('create', 'note-one', path.join(root, 'note-one.md'))).toThrow('publication denied');
    expect(journal.getPending()).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);

    rename.mockRestore();
    journal.begin('create', 'note-one', path.join(root, 'note-one.md'));
    expect(new OperationJournal(root).getPending()).toHaveLength(1);
  });

  describe('change log', () => {
    const begin = (journal: OperationJournal, name: string) => {
      const id = journal.begin('create', name, path.join(root, `${name}.md`));
      journal.advance(id, 'indexed');
      return id;
    };

    it('keeps the snapshot ahead of the log so older engines fail closed', () => {
      begin(new OperationJournal(root), 'note-one');
      expect(JSON.parse(fs.readFileSync(journalPath, 'utf8'))).toMatchObject({ version: 3, entries: [] });
    });

    it('does not write until something changes', () => {
      const id = begin(new OperationJournal(root), 'note-one');
      const before = fs.readFileSync(logPath, 'utf8');
      new OperationJournal(root).getIndexedPending();
      expect(fs.readFileSync(logPath, 'utf8')).toBe(before);
      expect(new OperationJournal(root).getIndexedPending().map(entry => entry.id)).toEqual([id]);
    });

    it('ignores an append that never finished and clears it on the next change', () => {
      const id = begin(new OperationJournal(root), 'note-one');
      fs.appendFileSync(logPath, '{"seq":99,"kind":"drop","ids":["');

      const reopened = new OperationJournal(root);
      expect(reopened.getIndexedPending().map(entry => entry.id)).toEqual([id]);

      const second = begin(reopened, 'note-two');
      expect(fs.readFileSync(logPath, 'utf8')).not.toContain('"seq":99');
      expect(new OperationJournal(root).getIndexedPending().map(entry => entry.id)).toEqual([id, second]);
    });

    it('ignores a complete record that lost its newline', () => {
      const id = begin(new OperationJournal(root), 'note-one');
      fs.appendFileSync(logPath, JSON.stringify({ seq: 99, kind: 'drop', ids: [id] }));
      expect(new OperationJournal(root).getIndexedPending().map(entry => entry.id)).toEqual([id]);
    });

    it('stops appending after a partial write until a snapshot replaces the log', () => {
      const journal = new OperationJournal(root);
      const id = begin(journal, 'note-one');
      const realAppend = fs.appendFileSync;
      const append = vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => {
        realAppend(logPath, '{"seq":3,"kind":');
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      });

      expect(() => journal.complete(id)).toThrow('disk full');
      append.mockRestore();
      journal.complete(id);

      expect(new OperationJournal(root).getPending()).toEqual([]);
    });

    it('fails the write rather than appending after a partial line it cannot remove', () => {
      const journal = new OperationJournal(root);
      const id = begin(journal, 'note-one');
      const realAppend = fs.appendFileSync;
      const append = vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => {
        realAppend(logPath, '{"seq":3,"kind":');
        throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      });
      expect(() => journal.complete(id)).toThrow('disk full');
      append.mockRestore();

      const rm = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
        throw Object.assign(new Error('log busy'), { code: 'EACCES' });
      });
      expect(() => journal.complete(id)).toThrow('log busy');
      rm.mockRestore();

      expect(journal.getIndexedPending().map(entry => entry.id)).toEqual([id]);
      expect(new OperationJournal(root).getIndexedPending().map(entry => entry.id)).toEqual([id]);
      journal.complete(id);
      expect(new OperationJournal(root).getPending()).toEqual([]);
    });

    it('keeps appending when compaction cannot remove a clean log', () => {
      const journal = new OperationJournal(root);
      const padding = 'x'.repeat(64 * 1024);
      const id = journal.begin('create', 'note-one', path.join(root, padding));
      const rm = vi.spyOn(fs, 'rmSync').mockImplementation(() => {
        throw Object.assign(new Error('log busy'), { code: 'EACCES' });
      });

      journal.complete(id);
      const second = journal.begin('create', 'note-two', path.join(root, 'note-two.md'));
      rm.mockRestore();

      expect(new OperationJournal(root).getPending().map(entry => entry.id)).toEqual([second]);
    });

    it('stops at a corrupt line inside the log without overwriting it', () => {
      begin(new OperationJournal(root), 'note-one');
      const raw = `${fs.readFileSync(logPath, 'utf8')}{broken\n`;
      fs.writeFileSync(logPath, raw);
      expect(() => new OperationJournal(root)).toThrow('Invalid operation journal log');
      expect(fs.readFileSync(logPath, 'utf8')).toBe(raw);
    });

    it.each([
      ['an unknown kind', { seq: 9, kind: 'mystery' }],
      ['a missing seq', { kind: 'drop', ids: [] }],
      ['a bad status', { seq: 9, kind: 'patch', ids: ['ID'], patch: { status: 'nope' } }],
    ])('rejects %s', (_name, record) => {
      const id = begin(new OperationJournal(root), 'note-one');
      fs.appendFileSync(logPath, `${JSON.stringify(record).replace('ID', id)}\n`);
      expect(() => new OperationJournal(root)).toThrow('Invalid operation journal log');
    });

    it('skips records the snapshot already covers', () => {
      const journal = new OperationJournal(root);
      const id = begin(journal, 'note-one');
      const log = fs.readFileSync(logPath, 'utf8');
      journal.complete(id);
      (journal as unknown as { writeSnapshot(): void }).writeSnapshot();

      // A crash between publishing the snapshot and removing the log leaves this.
      fs.writeFileSync(logPath, log);
      expect(new OperationJournal(root).getPending()).toEqual([]);
    });

    it('ignores a stale log beside a journal from an older engine', () => {
      begin(new OperationJournal(root), 'note-one');
      fs.writeFileSync(journalPath, '[]');
      const journal = new OperationJournal(root);
      expect(journal.getPending()).toEqual([]);

      const id = begin(journal, 'note-two');
      expect(new OperationJournal(root).getPending().map(entry => entry.id)).toEqual([id]);
    });

    it('folds the log into the snapshot once nothing is pending', () => {
      const journal = new OperationJournal(root);
      const padding = 'x'.repeat(64 * 1024);
      journal.complete(journal.begin('create', 'note-one', path.join(root, padding)));

      expect(fs.existsSync(logPath)).toBe(false);
      expect(JSON.parse(fs.readFileSync(journalPath, 'utf8'))).toMatchObject({ seq: 2, entries: [] });
    });

    it('folds a long log into the snapshot while entries stay pending', () => {
      const journal = new OperationJournal(root);
      const padding = 'x'.repeat(4096);
      const ids = Array.from({ length: 300 }, (_, i) => journal.begin('create', `note-${i}`, path.join(root, padding)));

      expect(fs.statSync(journalPath).size).toBeGreaterThan(1024 * 1024);
      expect(new OperationJournal(root).getPending().map(entry => entry.id)).toEqual(ids);
    });

    it('keeps a change that a failed compaction could not fold in', () => {
      const journal = new OperationJournal(root);
      const padding = 'x'.repeat(64 * 1024);
      const id = journal.begin('create', 'note-one', path.join(root, padding));
      const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
        throw Object.assign(new Error('publication denied'), { code: 'EACCES' });
      });

      journal.complete(id);
      rename.mockRestore();

      expect(journal.getPending()).toEqual([]);
      expect(new OperationJournal(root).getPending()).toEqual([]);
    });
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

      const records = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { kind: string; ids?: string[] });
      expect(records.filter(record => record.kind === 'bind')).toHaveLength(1);
      expect(records.find(record => record.kind === 'bind')?.ids).toHaveLength(200);

      const reopened = new OperationJournal(root);
      for (const entry of reopened.getIndexedPending()) {
        expect(reopened.getCommit(entry)?.files).toEqual(files);
      }
    });

    it('drops a commit once no entry references it', () => {
      const journal = new OperationJournal(root);
      const entries = indexedEntries(journal, 2);
      journal.bindCommit(entries.map(entry => entry.id), commitFor(entries.map(entry => entry.file)));

      const storedCommits = () => (journal as unknown as { commits: Map<string, unknown> }).commits.size;
      journal.complete(entries[0]!.id);
      expect(storedCommits()).toBe(1);
      journal.complete(entries[1]!.id);
      expect(storedCommits()).toBe(0);
    });

    it('keeps the bound commit when a later append fails', () => {
      const journal = new OperationJournal(root);
      const [entry] = indexedEntries(journal, 1);
      journal.bindCommit([entry!.id], commitFor([entry!.file]));
      const append = vi.spyOn(fs, 'appendFileSync').mockImplementation(() => {
        throw Object.assign(new Error('append denied'), { code: 'EACCES' });
      });

      expect(() => journal.complete(entry!.id)).toThrow('append denied');
      append.mockRestore();
      const [pending] = journal.getIndexedPending();
      expect(journal.getCommit(pending!)?.files).toEqual([entry!.file]);
    });

    it('loads a version 2 journal', () => {
      const entry = { id: 'a', op: 'create', docId: 'a', filePath: 'a.md', timestamp: 't', status: 'indexed', commitId: 'c' };
      fs.writeFileSync(journalPath, JSON.stringify({ version: 2, commits: { c: commitFor(['a.md']) }, entries: [entry] }));

      const journal = new OperationJournal(root);
      const [loaded] = journal.getIndexedPending();
      expect(journal.getCommit(loaded!)?.files).toEqual(['a.md']);
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
      expect(JSON.parse(fs.readFileSync(journalPath, 'utf8'))).toMatchObject({ version: 3 });
      expect(new OperationJournal(root).getCommit(a!)).toEqual(commitFor(files));
    });

    it.each([
      ['a dangling commit reference', { version: 2, commits: {}, entries: [{ id: 'a', op: 'create', docId: 'a', filePath: 'a.md', timestamp: 't', status: 'indexed', commitId: 'gone' }] }],
      ['a malformed commit', { version: 2, commits: { x: { action: 'create' } }, entries: [] }],
      ['an unknown version', { version: 4, seq: 0, commits: {}, entries: [] }],
      ['a snapshot without seq', { version: 3, commits: {}, entries: [] }],
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
