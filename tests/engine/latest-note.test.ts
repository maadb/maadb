// getDocumentFull picks the newest incoming note from the index and reads git
// history for that one note only, instead of one git log per note.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MaadEngine } from '../../src/engine/index.js';
import { GitLayer } from '../../src/git/index.js';
import { docId, docType } from '../../src/types.js';

let root: string;
let engine: MaadEngine;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true }).toString().trim();

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'latest-note-'));
  cpSync(path.resolve(__dirname, '../fixtures/simple-crm'), root, { recursive: true,
    filter: source => !['_backend', '.git'].includes(path.basename(source)) });
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'noreply');
  git('config', 'core.autocrlf', 'false'); git('add', '.'); git('commit', '-m', 'Fixture');
  engine = new MaadEngine();
  const result = await engine.init(root, { semantic: false, history: {
    effectiveMode: 'audit', configuredMode: 'audit', modeSource: 'project', options: {}, advisories: [],
  } });
  expect(result.ok).toBe(true);
  await engine.indexAll({ force: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await engine?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function addNote(id: string, author: string): Promise<void> {
  const created = await engine.createDocument(docType('case_note'), {
    case: 'cas-2026-001', author, noted_at: '2026-11-01', note_type: 'update',
  }, 'A fictional note.', id);
  expect(created.ok).toBe(true);
}

describe('getDocumentFull latestNote', () => {
  it('reads git history once, for the newest incoming note', { timeout: 20_000 }, async () => {
    await addNote('note-2026-11-01-001', 'ana');
    await addNote('note-2026-11-01-002', 'ben');
    await addNote('note-2026-11-01-003', 'cy');
    // Older notes must be more than git's one-second resolution older.
    await new Promise(r => setTimeout(r, 2100));
    const updated = await engine.updateDocument(docId('note-2026-11-01-001'), { author: 'dee' });
    expect(updated.ok).toBe(true);

    const history = vi.spyOn(GitLayer.prototype, 'history');
    const result = await engine.getDocumentFull(docId('cas-2026-001'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.related.incoming.filter(rel => rel.docType === 'case_note')).toHaveLength(4);
    expect(history).toHaveBeenCalledTimes(1);
    const [entry] = await GitLayer.prototype.history.call(
      new GitLayer(root), 'case-notes/note-2026-11-01-001.md', { limit: 1 });
    expect(result.value.latestNote).toEqual({
      docId: 'note-2026-11-01-001',
      summary: entry!.summary,
      timestamp: entry!.timestamp,
    });
  });

  it('falls through to the next note when the newest has no engine commit', async () => {
    await addNote('note-2026-11-01-001', 'ana');
    // An edit made outside the engine: newest in the index, but no engine commit.
    const notePath = path.join(root, 'case-notes', 'note-2026-04-06-001.md');
    const { readFileSync, writeFileSync } = await import('node:fs');
    writeFileSync(notePath, readFileSync(notePath, 'utf8').replace('author: system', 'author: outside'));
    git('add', '.'); git('commit', '-m', 'Outside edit');
    await engine.indexAll({ force: true });

    const result = await engine.getDocumentFull(docId('cas-2026-001'));
    expect(result.ok && result.value.latestNote?.docId).toBe('note-2026-11-01-001');
  });

  it('does not let a newer outside edit hide a newer engine commit on another note', async () => {
    await addNote('note-2026-11-01-001', 'ana');
    await new Promise(r => setTimeout(r, 1100));
    await addNote('note-2026-11-01-002', 'ben');
    await new Promise(r => setTimeout(r, 1100));
    // Note 001 is now newest in the index, but its only engine commit is older than 002's.
    const notePath = path.join(root, 'case-notes', 'note-2026-11-01-001.md');
    const { readFileSync, writeFileSync } = await import('node:fs');
    writeFileSync(notePath, readFileSync(notePath, 'utf8').replace('author: ana', 'author: outside'));
    git('add', '.'); git('commit', '-m', 'Outside edit');
    await engine.indexAll({ force: true });

    const result = await engine.getDocumentFull(docId('cas-2026-001'));
    expect(result.ok && result.value.latestNote?.docId).toBe('note-2026-11-01-002');
  }, 20_000);

  it('returns null when no incoming note has an engine commit', async () => {
    const result = await engine.getDocumentFull(docId('cas-2026-001'));
    expect(result.ok && result.value.latestNote).toBeNull();
  });
});
