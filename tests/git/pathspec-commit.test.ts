// 0.7.14 — autoCommit is pathspec-scoped to the operation's files. Unrelated
// staged content (operator activity, leftovers from a prior failed commit)
// must not be swept into a maad:* commit: the structured subject line is the
// audit trail that maad_audit / maad_history parse, so a commit claiming
// "maad:create cli-x" must contain only cli-x's files.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { simpleGit } from 'simple-git';
import { MaadEngine } from '../../src/engine.js';
import { docId, docType } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-pathspec-commit');

let engine: MaadEngine;

beforeAll(async () => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, maxRetries: 10, retryDelay: 200 });
  cpSync(FIXTURE_SRC, TEMP_ROOT, { recursive: true });
  const backendDir = path.join(TEMP_ROOT, '_backend');
  if (existsSync(backendDir)) rmSync(backendDir, { recursive: true, maxRetries: 10, retryDelay: 200 });

  const git = simpleGit(TEMP_ROOT);
  await git.init();
  await git.addConfig('user.email', 'test@test.com');
  await git.addConfig('user.name', 'Test');
  await git.add('.');
  await git.commit('Initial commit');

  engine = new MaadEngine();
  const result = await engine.init(TEMP_ROOT);
  expect(result.ok).toBe(true);
  await engine.indexAll({ force: true });
});

afterAll(async () => {
  engine.close();
  await new Promise(r => setTimeout(r, 100));
  try {
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Windows may hold handles briefly — non-fatal
  }
});

describe('pathspec-scoped auto-commit', () => {
  it('does not sweep unrelated staged files into a write commit', async () => {
    const git = simpleGit(TEMP_ROOT);

    // Simulate operator activity: an unrelated file staged but not committed
    writeFileSync(path.join(TEMP_ROOT, 'stray.txt'), 'unrelated staged content', 'utf-8');
    await git.add('stray.txt');

    const result = await engine.createDocument(
      docType('client'),
      { name: 'Scoped Corp', status: 'active' },
      'Pathspec test client.',
      'cli-scoped',
    );
    expect(result.ok).toBe(true);

    const log = await git.log({ maxCount: 1 });
    expect(log.latest?.message).toContain('maad:create');
    expect(log.latest?.message).toContain('cli-scoped');

    const committedFiles = await git.raw(['show', '--name-only', '--pretty=format:', 'HEAD']);
    expect(committedFiles).toContain('cli-scoped.md');
    expect(committedFiles).not.toContain('stray.txt');

    // The unrelated file is still staged, untouched, for the operator to handle
    const status = await git.status();
    expect(status.staged).toContain('stray.txt');
  });

  it('soft delete (rename pair) still commits under pathspec', async () => {
    const git = simpleGit(TEMP_ROOT);

    const del = await engine.deleteDocument(docId('cli-scoped'), 'soft');
    expect(del.ok).toBe(true);

    const log = await git.log({ maxCount: 1 });
    expect(log.latest?.message).toContain('maad:delete');
    expect(log.latest?.message).toContain('cli-scoped');

    const committedFiles = await git.raw(['show', '--name-only', '--pretty=format:', 'HEAD']);
    expect(committedFiles).toContain('_deleted_cli-scoped.md');
    expect(committedFiles).not.toContain('stray.txt');
  });

  it('unrelated staged content alone does not produce a maad commit on a no-change update', async () => {
    const git = simpleGit(TEMP_ROOT);
    const before = await git.log({ maxCount: 1 });

    // Update that changes nothing on disk: same field value as current
    const get = await engine.getDocument(docId('cli-acme'), 'hot');
    expect(get.ok).toBe(true);
    if (!get.ok) return;
    const currentStatus = get.value.frontmatter['status'];
    const upd = await engine.updateDocument(docId('cli-acme'), { status: currentStatus });
    expect(upd.ok).toBe(true);

    const after = await git.log({ maxCount: 1 });
    // Either no new commit (noop) or a commit that does not include stray.txt
    if (after.latest?.hash !== before.latest?.hash) {
      const committedFiles = await git.raw(['show', '--name-only', '--pretty=format:', 'HEAD']);
      expect(committedFiles).not.toContain('stray.txt');
    }
  });
});
