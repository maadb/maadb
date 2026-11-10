// An update that produces the file's current bytes returns before writing,
// reindexing or committing, unless an earlier operation on the file is still
// waiting to commit or the index does not hold those bytes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MaadEngine } from '../../src/engine/index.js';
import { GitLayer } from '../../src/git/index.js';
import { docId } from '../../src/types.js';

let root: string;
let engine: MaadEngine;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true }).toString().trim();
const file = () => path.join(root, 'clients', 'cli-acme.md');
const id = docId('cli-acme');

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'noop-update-'));
  cpSync(path.resolve(__dirname, '../fixtures/simple-crm'), root, { recursive: true,
    filter: source => !['_backend', '.git'].includes(path.basename(source)) });
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'noreply');
  git('config', 'core.autocrlf', 'false'); git('add', '.'); git('commit', '-m', 'Fixture');
  engine = new MaadEngine();
  expect((await engine.init(root, { semantic: false, history: {
    effectiveMode: 'audit', configuredMode: 'audit', modeSource: 'project', options: {}, advisories: [],
  } })).ok).toBe(true);
  await engine.indexAll({ force: true });
  // Normalise the fixture to the engine's own serialisation first.
  const first = await engine.updateDocument(id, { status: 'inactive' });
  expect(first.ok).toBe(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await engine?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('no-op update', () => {
  it('returns without writing, reindexing or committing', async () => {
    const head = git('rev-parse', 'HEAD');
    const past = new Date(Date.now() - 60_000);
    utimesSync(file(), past, past);
    const mtime = statSync(file()).mtimeMs;
    const commit = vi.spyOn(GitLayer.prototype, 'commit');

    const result = await engine.updateDocument(id, { status: 'inactive' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.writeDurable).toBe(true);
    expect(result.value.changedFields).toEqual([]);
    expect(commit).not.toHaveBeenCalled();
    expect(statSync(file()).mtimeMs).toBe(mtime);
    expect(git('rev-parse', 'HEAD')).toBe(head);
    const after = await engine.getDocument(id, 'hot');
    expect(after.ok && after.value.version).toBe(result.value.version);
  });

  it('still commits a retry after a failed commit', async () => {
    const real = GitLayer.prototype.commit;
    vi.spyOn(GitLayer.prototype, 'commit').mockImplementationOnce(async () =>
      ({ status: 'failed', code: 'GIT_COMMIT_FAILED', message: 'index locked' }));
    const failed = await engine.updateDocument(id, { status: 'active' });
    expect(failed.ok && failed.value.writeDurable).toBe(false);
    expect(git('status', '--porcelain', '--', 'clients')).not.toBe('');

    vi.mocked(GitLayer.prototype.commit).mockImplementation(real);
    const retry = await engine.updateDocument(id, { status: 'active' });
    expect(retry.ok && retry.value.writeDurable).toBe(true);
    expect(git('status', '--porcelain', '--', 'clients')).toBe('');
    expect(git('log', '-1', '--format=%s')).toMatch(/^maad:update cli-acme/);
  });

  it('still commits a retry after an interrupted write was reindexed', async () => {
    // The file holds the update's bytes and the index has them (crash after
    // the write, then reindex), but git never got the commit.
    const updated = readFileSync(file(), 'utf8').replace('status: inactive', 'status: active');
    writeFileSync(file(), updated);
    await engine.indexAll({ force: true });
    expect(git('status', '--porcelain', '--', 'clients')).not.toBe('');

    const retry = await engine.updateDocument(id, { status: 'active' });
    expect(retry.ok && retry.value.writeDurable).toBe(true);
    expect(git('status', '--porcelain', '--', 'clients')).toBe('');
  });

  it('reindexes when the file was edited outside the engine', async () => {
    const outside = readFileSync(file(), 'utf8').replace('status: inactive', 'status: active');
    writeFileSync(file(), outside);
    // Same value as now on disk: bytes match, but the index still holds the old ones.
    const result = await engine.updateDocument(id, { status: 'active' });
    expect(result.ok).toBe(true);
    const query = await engine.findDocuments({ docType: 'client' as never, filters: { status: 'active' } });
    expect(query.ok && query.value.results.map(r => r.docId)).toContain('cli-acme');
  });
});
