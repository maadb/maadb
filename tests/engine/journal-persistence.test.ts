import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { OperationJournal } from '../../src/engine/journal.js';

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

  it('accepts a missing journal for a new project', () => {
    expect(new OperationJournal(root).getPending()).toEqual([]);
    expect(fs.existsSync(journalPath)).toBe(false);
  });
});
