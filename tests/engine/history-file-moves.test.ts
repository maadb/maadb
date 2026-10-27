import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { MaadEngine } from '../../src/engine.js';
import { docId, docType } from '../../src/types.js';

const ID = docId('cli-history-move');
let root: string;
let engine: MaadEngine;
let first: string;
let second: string;
let latest: string;

async function reopen(): Promise<void> {
  engine = new MaadEngine();
  const initialized = await engine.init(root, { semantic: false });
  expect(initialized.ok, JSON.stringify(initialized)).toBe(true);
  const indexed = await engine.indexAll({ force: true });
  expect(indexed.errors).toEqual([]);
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'maadb-engine-moves-'));
  cpSync(path.resolve(__dirname, '../fixtures/simple-crm'), root, { recursive: true });
  writeFileSync(path.join(root, '.gitignore'), '_backend/\n', 'utf8');
  const git = simpleGit(root);
  await git.init();
  await git.addConfig('user.name', 'History Test');
  await git.addConfig('user.email', 'noreply');
  await git.add(['--all']);
  await git.commit('fixture: project');
  await reopen();
  const created = await engine.createDocument(
    docType('client'), { name: 'Before', status: 'active' }, 'Before body.', ID,
  );
  expect(created.ok, JSON.stringify(created)).toBe(true);
  first = (await git.revparse(['HEAD'])).trim();
  expect((await engine.snapshot(ID, first)).ok).toBe(true);
  const updated = await engine.updateDocument(ID, { name: 'Second' }, 'Second body.');
  expect(updated.ok, JSON.stringify(updated)).toBe(true);
  second = (await git.revparse(['HEAD'])).trim();

  await engine.close();
  mkdirSync(path.join(root, 'clients', '000'));
  renameSync(path.join(root, 'clients', ID + '.md'), path.join(root, 'clients', '000', ID + '.md'));
  await git.add(['--all', '--', 'clients']);
  await git.commit('fixture: move into folder');
  await reopen();
  const afterMove = await engine.updateDocument(ID, { name: 'After', status: 'inactive' }, 'After body.');
  expect(afterMove.ok, JSON.stringify(afterMove)).toBe(true);
  latest = (await git.revparse(['HEAD'])).trim();
  // Reopen once more to prove historical access survives persisted reindexing.
  await engine.close();
  await reopen();
});

afterAll(async () => {
  await engine?.close();
  const relative = path.relative(tmpdir(), root);
  expect(relative && !relative.startsWith('..') && !path.isAbsolute(relative)).toBeTruthy();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('engine history after a document moves into a folder', () => {
  it('keeps the original create/update history after reopen and forced reindex', async () => {
    const result = await engine.history(ID);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error('History unavailable');
    expect(result.value.map(entry => entry.sha)).toEqual(expect.arrayContaining([first, second, latest]));
  });

  it('retrieves both older snapshots with the original fields and bodies', async () => {
    for (const [sha, name, body] of [
      [first, 'Before', 'Before body.'], [second, 'Second', 'Second body.'], [latest, 'After', 'After body.'],
    ]) {
      const result = await engine.snapshot(ID, sha!);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw new Error('Snapshot unavailable');
      expect(result.value.frontmatter.name).toBe(name);
      expect(result.value.frontmatter.doc_id).toBe(ID);
      expect(result.value.body).toBe(body);
    }
  });

  it('returns the real pre-move field and body diff', async () => {
    const result = await engine.diff(ID, first, second);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error('Diff unavailable');
    expect(result.value.frontmatterChanges.name).toEqual({ from: 'Before', to: 'Second' });
    expect(result.value.bodyDiff).toContain('-Before body.');
    expect(result.value.bodyDiff).toContain('+Second body.');
  });

  it('compares an older version with current HEAD across the move', async () => {
    const result = await engine.diff(ID, first);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error('Diff unavailable');
    expect(result.value.frontmatterChanges.name).toEqual({ from: 'Before', to: 'After' });
    expect(result.value.frontmatterChanges.status).toEqual({ from: 'active', to: 'inactive' });
    expect(result.value.bodyDiff).toContain('-Before body.');
    expect(result.value.bodyDiff).toContain('+After body.');
  });
});
