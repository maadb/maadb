// autoCommit staging arguments.
//
// simple-git waits an extra 50 ms after a git command that printed nothing.
// `git add --verbose` prints a line per staged change, so audited writes skip
// that wait; `--` keeps a path starting with '-' from being read as an option.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

  it('commits more paths than fit on one command line', async () => {
    const made = await repo();
    root = made.root;
    // 1,000 paths of 70+ characters are well past the 32,767 Windows limit.
    const prefix = 'x'.repeat(70);
    const files = Array.from({ length: 1000 }, (_, i) => `${prefix}-${i}.md`);
    for (const file of files) writeFileSync(path.join(root, file), `${file}\n`, 'utf-8');
    writeFileSync(path.join(root, 'stray.txt'), 'unrelated\n', 'utf-8');
    await made.git.add('stray.txt');

    const outcome = await autoCommit(made.git, {
      action: 'create', docId: docId('bulk'), docType: docType('note'),
      detail: 'bulk:1000', summary: 'bulk', files,
    });

    expect(outcome.status).toBe('committed');
    const committed = (await made.git.raw(['show', '--name-only', '--pretty=format:', 'HEAD'])).trim().split('\n');
    expect(committed.sort()).toEqual([...files].sort());
    expect((await made.git.status()).staged).toEqual(['stray.txt']);
    expect(readdirSync(path.join(root, '.git')).filter(name => name.startsWith('maad-pathspec-'))).toEqual([]);

    const repeat = await autoCommit(made.git, {
      action: 'update', docId: docId('bulk'), docType: docType('note'),
      detail: '', summary: 'unchanged', files,
    });
    expect(repeat.status).toBe('noop');
  });

  it('caps a long summary so a large field value cannot overflow the command line', async () => {
    const made = await repo();
    root = made.root;
    writeFileSync(path.join(root, 'note.md'), 'hello\n', 'utf-8');

    const outcome = await autoCommit(made.git, {
      action: 'update', docId: docId('note'), docType: docType('note'),
      detail: 'fields:body', summary: `body: ${'\u{1F600}'.repeat(20_000)}`, files: ['note.md'],
    });

    expect(outcome.status).toBe('committed');
    const subject = (await made.git.raw(['log', '-1', '--format=%s'])).trim();
    expect(subject.startsWith('maad:update note [note] fields:body — body: ')).toBe(true);
    expect(subject.endsWith('\u{1F600}…')).toBe(true);
    expect(Array.from(subject).length).toBeLessThan(260);
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
