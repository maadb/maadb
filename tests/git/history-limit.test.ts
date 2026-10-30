// A history limit counts MAAD commits, not every commit that touched the file.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { getHistory } from '../../src/git/log.js';

let root: string;
let git: SimpleGit;

async function commit(message: string): Promise<void> {
  writeFileSync(path.join(root, 'note.md'), `${message}\n`);
  await git.add('note.md');
  await git.commit(message);
}

const maad = (i: number) => `maad:update note [note] body:replace — edit ${i}`;

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'maad-history-limit-'));
  git = simpleGit(root);
  await git.init();
  await git.addConfig('user.name', 'Test');
  await git.addConfig('user.email', 'noreply@example.invalid');
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('getHistory limit', () => {
  it('finds a MAAD commit behind newer non-MAAD commits', async () => {
    await commit(maad(1));
    for (let i = 0; i < 6; i++) await commit(`manual edit ${i}`);

    const history = await getHistory(git, 'note.md', { limit: 1 });

    expect(history.map(entry => entry.summary)).toEqual(['edit 1']);
  });

  it('returns the newest commits and never more than the limit', async () => {
    for (let i = 0; i < 5; i++) {
      await commit(maad(i));
      await commit(`manual edit ${i}`);
    }

    const history = await getHistory(git, 'note.md', { limit: 3 });

    expect(history.map(entry => entry.summary)).toEqual(['edit 4', 'edit 3', 'edit 2']);
  });

  it('runs Git once when the first window fills the limit', async () => {
    for (let i = 0; i < 3; i++) await commit(maad(i));
    const raw = vi.spyOn(git, 'raw');

    await getHistory(git, 'note.md', { limit: 2 });

    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('stops when the history runs out before the limit', async () => {
    await commit('manual edit');
    const raw = vi.spyOn(git, 'raw');

    expect(await getHistory(git, 'note.md', { limit: 5 })).toEqual([]);
    expect(raw).toHaveBeenCalledTimes(1);
  });

  it('returns everything without a limit', async () => {
    for (let i = 0; i < 3; i++) await commit(maad(i));
    expect(await getHistory(git, 'note.md')).toHaveLength(3);
  });
});
