// A write that knows it changed content commits without a git status probe.
// The status check still runs when the commit records nothing, so outcomes
// (committed / noop / failed) match the probing path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { autoCommit } from '../../src/git/commit.js';
import { GitLayer } from '../../src/git/index.js';
import { MaadEngine } from '../../src/engine/index.js';
import { docId as toDocId, docType as toDocType } from '../../src/types.js';

const opts = {
  action: 'update' as const,
  docId: toDocId('cli-acme'),
  docType: toDocType('client'),
  detail: '',
  summary: 'test',
  files: ['one.md'],
  changed: true,
};

function stub(over: { status?: () => Promise<unknown>; commit?: () => Promise<unknown> }) {
  const g: Record<string, unknown> = {
    add: vi.fn(async () => {}),
    status: vi.fn(over.status ?? (async () => ({ staged: ['one.md'], files: [] }))),
    commit: vi.fn(over.commit ?? (async () => ({ commit: 'deadbeef' }))),
  };
  g.env = () => g;
  return g as never as Parameters<typeof autoCommit>[0] & { status: ReturnType<typeof vi.fn> };
}

describe('autoCommit with the changed hint', () => {
  it('commits without a status probe', async () => {
    const git = stub({});
    expect(await autoCommit(git, opts)).toEqual({ status: 'committed', sha: 'deadbeef' });
    expect(git.status).not.toHaveBeenCalled();
  });

  it('reports noop when git records nothing and nothing is staged', async () => {
    const git = stub({ commit: async () => ({ commit: '' }), status: async () => ({ staged: [], files: [] }) });
    expect(await autoCommit(git, opts)).toEqual({ status: 'noop' });
  });

  it('reports GIT_COMMIT_EMPTY when git records nothing but a change is staged', async () => {
    const git = stub({ commit: async () => ({ commit: '' }) });
    expect(await autoCommit(git, opts)).toMatchObject({ status: 'failed', code: 'GIT_COMMIT_EMPTY' });
  });

  it('reports noop when the commit throws with nothing staged', async () => {
    const git = stub({ commit: async () => { throw new Error('nothing to commit'); }, status: async () => ({ staged: [], files: [] }) });
    expect(await autoCommit(git, opts)).toEqual({ status: 'noop' });
  });

  it('reports GIT_COMMIT_FAILED when the commit throws with a change staged', async () => {
    const git = stub({ commit: async () => { throw new Error('index.lock held'); } });
    expect(await autoCommit(git, opts)).toMatchObject({ status: 'failed', code: 'GIT_COMMIT_FAILED' });
  });

  it('still probes first without the hint', async () => {
    const git = stub({ status: async () => ({ staged: [], files: [] }) });
    expect(await autoCommit(git, { ...opts, changed: undefined })).toEqual({ status: 'noop' });
    expect(git.status).toHaveBeenCalled();
  });
});

describe('real git', () => {
  let root: string;
  let engine: MaadEngine;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true }).toString().trim();

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'changed-hint-'));
    cpSync(path.resolve(__dirname, '../fixtures/simple-crm'), root, { recursive: true,
      filter: source => !['_backend', '.git'].includes(path.basename(source)) });
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'noreply');
    git('config', 'core.autocrlf', 'false'); git('add', '.'); git('commit', '-m', 'Fixture');
    engine = new MaadEngine();
    expect((await engine.init(root, { semantic: false, history: {
      effectiveMode: 'audit', configuredMode: 'audit', modeSource: 'project', options: {}, advisories: [],
    } })).ok).toBe(true);
    await engine.indexAll({ force: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await engine?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('notes a noop when the changed paths already match HEAD', async () => {
    const file = path.join(root, 'clients', 'cli-acme.md');
    const before = git('rev-parse', 'HEAD');
    writeFileSync(file, readFileSync(file, 'utf8'));
    const outcome = await new GitLayer(root).commit({ ...opts, files: [file] });
    expect(outcome).toEqual({ status: 'noop' });
    expect(git('rev-parse', 'HEAD')).toBe(before);
  });

  it('create, update, soft delete and hard delete commit with no git status call', async () => {
    const status = vi.spyOn(Object.getPrototypeOf((new GitLayer(root) as unknown as { git: object }).git), 'status');
    const created = await engine.createDocument(toDocType('client'), { name: 'Fictional Co', status: 'active' }, 'Body.', 'cli-fictional');
    expect(created.ok && created.value.writeDurable).toBe(true);
    const updated = await engine.updateDocument(toDocId('cli-fictional'), { status: 'inactive' });
    expect(updated.ok && updated.value.writeDurable).toBe(true);
    const soft = await engine.deleteDocument(toDocId('cli-fictional'), 'soft');
    expect(soft.ok).toBe(true);
    const hard = await engine.deleteDocument(toDocId('cli-acme'), 'hard');
    expect(hard.ok).toBe(true);
    expect(status).not.toHaveBeenCalled();
    const subjects = git('log', '--format=%s', '-4').split('\n');
    expect(subjects.map(s => s.split(' ')[0])).toEqual(['maad:delete', 'maad:delete', 'maad:update', 'maad:create']);
    expect(git('status', '--porcelain', '--', 'clients')).toBe('');
  });
});
