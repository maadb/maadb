// autoCommit staging arguments.
//
// simple-git waits an extra 50 ms after a git command that printed nothing.
// `git add --verbose` prints a line per staged change, so audited writes skip
// that wait; `--` keeps a path starting with '-' from being read as an option.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { autoCommit, GIT_IDENTITY_ENV_KEYS } from '../../src/git/commit.js';
import { docId, docType } from '../../src/types.js';

async function repo(): Promise<{ root: string; git: SimpleGit }> {
  const root = mkdtempSync(path.join(tmpdir(), 'maad-staging-args-'));
  // Same construction as GitLayer: autoCommit passes the commit identity env.
  const git = simpleGit({ baseDir: root, allowEnvironment: GIT_IDENTITY_ENV_KEYS });
  await git.init();
  await git.addConfig('user.email', 'test@test.com');
  await git.addConfig('user.name', 'Test');
  writeFileSync(path.join(root, 'seed.txt'), 'seed\n', 'utf-8');
  await git.add('seed.txt');
  await git.commit('seed');
  return { root, git };
}

describe('autoCommit staging', () => {
  let root: string | null = null;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    root = null;
  });

  it('stages verbosely, with the paths after --', async () => {
    const made = await repo();
    root = made.root;
    const calls: unknown[] = [];
    const realAdd = made.git.add.bind(made.git);
    (made.git as unknown as { add: (files: string | string[]) => unknown }).add = (files) => {
      calls.push(files);
      return realAdd(files);
    };
    writeFileSync(path.join(root, 'note.md'), 'hello\n', 'utf-8');

    const outcome = await autoCommit(made.git, {
      action: 'create', docId: docId('note'), docType: docType('note'),
      detail: '', summary: 'note', files: ['note.md'],
    });

    expect(outcome).toMatchObject({ status: 'committed' });
    expect(calls).toEqual([['--verbose', '--', 'note.md']]);
  });

  it('commits a path that starts with a dash', async () => {
    const made = await repo();
    root = made.root;
    writeFileSync(path.join(root, '-v.md'), 'dash\n', 'utf-8');

    const outcome = await autoCommit(made.git, {
      action: 'create', docId: docId('-v'), docType: docType('note'),
      detail: '', summary: 'dash', files: ['-v.md'],
    });

    expect(outcome.status).toBe('committed');
    const committed = await made.git.raw(['show', '--name-only', '--pretty=format:', 'HEAD']);
    expect(committed.trim()).toBe('-v.md');
  });
});
