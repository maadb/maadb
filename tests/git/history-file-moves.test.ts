import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { buildGitEnv, GIT_IDENTITY_ENV_KEYS } from '../../src/git/commit.js';
import { GitLayer } from '../../src/git/index.js';
import { docId } from '../../src/types.js';

const ID = docId('note-moved');
const FIRST = 'records/[original] café.md';
const MIDDLE = 'records/bucket one/[middle] café.md';
const LAST = 'records/bucket two/[final] café.md';
let root: string;
let layer: GitLayer;
let seed: string;
let first: string;
let second: string;
let moved: string;
let third: string;
let latest: string;

function document(id: string, title: string, body: string): string {
  return `---\ndoc_id: ${id}\ndoc_type: note\ntitle: ${title}\n---\n\n${body}\n`;
}
function write(file: string, content: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), content, 'utf8');
}
async function commit(day: number, message: string): Promise<string> {
  const git = layer.getSimpleGit();
  await git.add(['--all', '--', 'records']);
  const date = `2020-01-${String(day).padStart(2, '0')}T12:00:00Z`;
  const dated = simpleGit({
    baseDir: root,
    allowEnvironment: [...GIT_IDENTITY_ENV_KEYS, 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE'],
  });
  await dated.env({ ...buildGitEnv(), GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }).commit(message);
  return (await git.revparse(['HEAD'])).trim();
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'maadb-history-moves-'));
  layer = new GitLayer(root);
  const git = layer.getSimpleGit();
  await git.init();
  await git.addConfig('user.name', 'History Test');
  await git.addConfig('user.email', 'noreply');
  await git.addConfig('core.autocrlf', 'false');
  // The eventual destination used to belong to a different document.
  write(LAST, document('note-other', 'Unrelated', 'Do not return this body.'));
  seed = await commit(1, 'fixture: another document');
  write(FIRST, document(ID, 'First', 'First body.'));
  first = await commit(2, 'maad:create note-moved [note] — created');
  write(FIRST, document(ID, 'Second', 'Second body.'));
  second = await commit(3, 'maad:update note-moved [note] — updated');
  rmSync(path.join(root, LAST));
  mkdirSync(path.dirname(path.join(root, MIDDLE)), { recursive: true });
  renameSync(path.join(root, FIRST), path.join(root, MIDDLE));
  moved = await commit(4, 'fixture: first move');
  write(MIDDLE, document(ID, 'Third', 'Third body.'));
  third = await commit(5, 'maad:update note-moved [note] — updated');
  renameSync(path.join(root, MIDDLE), path.join(root, LAST));
  await commit(6, 'fixture: second move');
  write(LAST, document(ID, 'Latest', 'Latest body.'));
  // Reusing an old filename must not contaminate a diff.
  write(FIRST, document('note-replacement', 'Replacement', 'Unrelated replacement body.'));
  latest = await commit(7, 'maad:update note-moved [note] — latest');
});

afterAll(() => {
  const relative = path.relative(tmpdir(), root);
  expect(relative && !relative.startsWith('..') && !path.isAbsolute(relative)).toBeTruthy();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('historical reads across file moves', () => {
  it('retrieves both pre-move snapshots through multiple renames and literal Unicode paths', async () => {
    expect(await layer.snapshot(LAST, ID, first)).toMatchObject({
      frontmatter: { doc_id: ID, title: 'First' }, body: 'First body.',
    });
    expect(await layer.snapshot(LAST, ID, second)).toMatchObject({
      frontmatter: { title: 'Second' }, body: 'Second body.',
    });
    expect(await layer.snapshot(LAST, ID, third)).toMatchObject({ frontmatter: { title: 'Third' } });
  });

  it('accepts abbreviated commits and resolves a date before the moves', async () => {
    expect(await layer.snapshot(LAST, ID, second.slice(0, 10))).toMatchObject({
      frontmatter: { title: 'Second' },
    });
    expect(await layer.snapshot(LAST, ID, '2020-01-03T23:59:59Z')).toMatchObject({
      commit: second, timestamp: expect.stringMatching(/^2020-01-03T12:00:00(?:Z|\+00:00)$/),
      frontmatter: { title: 'Second' }, body: 'Second body.',
    });
  });

  it('compares two pre-move versions rather than the destination file', async () => {
    const result = await layer.diff(LAST, ID, first, second);
    expect(result?.frontmatterChanges.title).toEqual({ from: 'First', to: 'Second' });
    expect(result?.bodyDiff).toContain('-First body.');
    expect(result?.bodyDiff).toContain('+Second body.');
    expect(result?.bodyDiff).not.toContain('Unrelated');
  });

  it('compares across moves, supports default HEAD, and reverses the endpoints', async () => {
    const result = await layer.diff(LAST, ID, first);
    expect(result?.frontmatterChanges.title).toEqual({ from: 'First', to: 'Latest' });
    expect(result?.bodyDiff).toContain('-First body.');
    expect(result?.bodyDiff).toContain('+Latest body.');
    expect(result?.bodyDiff).not.toContain('Unrelated');
    const reversed = await layer.diff(LAST, ID, latest, second);
    expect(reversed?.frontmatterChanges.title).toEqual({ from: 'Latest', to: 'Second' });
    expect(reversed?.bodyDiff).toContain('-Latest body.');
    expect(reversed?.bodyDiff).toContain('+Second body.');
  });

  it('reports no content change for a pure move and preserves unchanged-path reads', async () => {
    expect(await layer.diff(LAST, ID, second, moved)).toMatchObject({
      frontmatterChanges: {}, bodyDiff: '',
    });
    expect(await layer.snapshot(LAST, ID, latest)).toMatchObject({
      frontmatter: { title: 'Latest' }, body: 'Latest body.',
    });
    expect(await layer.diff(LAST, ID, latest, latest)).toMatchObject({
      frontmatterChanges: {}, bodyDiff: '',
    });
  });

  it('does not substitute another document or a version before creation', async () => {
    expect(await layer.snapshot(LAST, ID, seed)).toBeNull();
    expect(await layer.diff(LAST, ID, seed, latest)).toBeNull();
    expect(await layer.snapshot(LAST, ID, '2019-01-01T00:00:00Z')).toBeNull();
    expect(await layer.snapshot(LAST, ID, 'deadbeefdeadbeef')).toBeNull();
    expect(await layer.diff(LAST, ID, '--output=unexpected', latest)).toBeNull();
  });

  it('does not modify HEAD, the index or tracked files during historical reads', async () => {
    const git = layer.getSimpleGit();
    const before = await git.raw(['status', '--porcelain=v1']);
    await layer.snapshot(LAST, ID, first);
    await layer.diff(LAST, ID, first, latest);
    expect((await git.revparse(['HEAD'])).trim()).toBe(latest);
    expect(await git.raw(['status', '--porcelain=v1'])).toBe(before);
  });
});

describe('merge-resolution moves and unverifiable history', () => {
  it('retrieves versions on both merge parents, including after a later large body rewrite', async () => {
    const project = mkdtempSync(path.join(tmpdir(), 'maadb-merge-moves-'));
    try {
      const mergedLayer = new GitLayer(project);
      const git = mergedLayer.getSimpleGit();
      await git.init();
      await git.addConfig('user.name', 'History Test');
      await git.addConfig('user.email', 'noreply');
      await git.addConfig('core.autocrlf', 'false');
      const id = docId('note-merge');
      const body = Array.from({ length: 80 }, (_, i) => `Original paragraph ${i} with stable content.`).join('\n');
      writeFileSync(path.join(project, 'old.md'), document(id, 'Base', body));
      await git.add(['--all']); await git.commit('fixture: base');
      const base = (await git.revparse(['HEAD'])).trim();
      const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();

      await git.checkoutLocalBranch('side');
      renameSync(path.join(project, 'old.md'), path.join(project, 'side.md'));
      writeFileSync(path.join(project, 'side.md'), document(id, 'Side', body));
      await git.add(['--all']); await git.commit('fixture: side move');
      const side = (await git.revparse(['HEAD'])).trim();

      await git.checkout(branch);
      renameSync(path.join(project, 'old.md'), path.join(project, 'main.md'));
      writeFileSync(path.join(project, 'main.md'), document(id, 'Main', body));
      await git.add(['--all']); await git.commit('fixture: main move');
      const main = (await git.revparse(['HEAD'])).trim();
      await expect(git.merge(['side', '--no-edit'])).rejects.toThrow();
      for (const file of ['old.md', 'main.md', 'side.md']) rmSync(path.join(project, file), { force: true });
      writeFileSync(path.join(project, 'final.md'), document(id, 'Merged', body));
      await git.add(['--all']); await git.commit('fixture: resolve move');
      const merged = (await git.revparse(['HEAD'])).trim();

      const rewritten = Array.from({ length: 80 }, (_, i) => `Replacement text ${i} with wholly different wording.`).join('\n');
      writeFileSync(path.join(project, 'final.md'), document(id, 'Latest', rewritten));
      await git.add(['--all']); await git.commit('fixture: later rewrite');

      for (const [sha, title] of [[base, 'Base'], [main, 'Main'], [side, 'Side'], [merged, 'Merged']]) {
        expect(await mergedLayer.snapshot('final.md', id, sha!)).toMatchObject({
          frontmatter: { doc_id: id, title }, body,
        });
      }
      const result = await mergedLayer.diff('final.md', id, main, side);
      expect(result?.frontmatterChanges.title).toEqual({ from: 'Main', to: 'Side' });
      expect(result?.bodyDiff).toContain('-title: Main');
      expect(result?.bodyDiff).toContain('+title: Side');
      expect((await git.status()).isClean()).toBe(true);
    } finally {
      const relative = path.relative(tmpdir(), project);
      expect(relative && !relative.startsWith('..') && !path.isAbsolute(relative)).toBeTruthy();
      rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it.each([
    ['malformed YAML', '---\ndoc_id: note-invalid\ntitle: [\n---\nbody\n'],
    ['missing identity', '---\ntitle: Untagged\n---\nbody\n'],
  ])('refuses an unverifiable historical document: %s', async (_label, content) => {
    const project = mkdtempSync(path.join(tmpdir(), 'maadb-invalid-history-'));
    try {
      const invalidLayer = new GitLayer(project);
      const git = invalidLayer.getSimpleGit();
      await git.init();
      await git.addConfig('user.name', 'History Test');
      await git.addConfig('user.email', 'noreply');
      writeFileSync(path.join(project, 'note.md'), content);
      await git.add(['--all']); await git.commit('fixture: invalid historical data');
      const old = (await git.revparse(['HEAD'])).trim();
      writeFileSync(path.join(project, 'note.md'), document('note-invalid', 'Valid', 'Current body.'));
      await git.add(['--all']); await git.commit('fixture: repair identity');
      expect(await invalidLayer.snapshot('note.md', docId('note-invalid'), old)).toBeNull();
      expect(await invalidLayer.diff('note.md', docId('note-invalid'), old)).toBeNull();
    } finally {
      const relative = path.relative(tmpdir(), project);
      expect(relative && !relative.startsWith('..') && !path.isAbsolute(relative)).toBeTruthy();
      rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe('converged merge filenames', () => {
  it('finds the alternate parent path when both branches have already moved to the same final name', async () => {
    const project = mkdtempSync(path.join(tmpdir(), 'maadb-converged-moves-'));
    try {
      const converged = new GitLayer(project);
      const git = converged.getSimpleGit();
      await git.init();
      await git.addConfig('user.name', 'History Test');
      await git.addConfig('user.email', 'noreply');
      const id = docId('note-converged');
      writeFileSync(path.join(project, 'old.md'), document(id, 'Same', 'Same body.'));
      await git.add(['--all']); await git.commit('fixture: base');
      const branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
      await git.checkoutLocalBranch('side');
      await git.mv('old.md', 'side.md'); await git.commit('fixture: side intermediate');
      const side = (await git.revparse(['HEAD'])).trim();
      await git.mv('side.md', 'final.md'); await git.commit('fixture: side final');
      await git.checkout(branch);
      await git.mv('old.md', 'main.md'); await git.commit('fixture: main intermediate');
      const main = (await git.revparse(['HEAD'])).trim();
      await git.mv('main.md', 'final.md'); await git.commit('fixture: main final');
      await git.merge(['--no-ff', '--no-edit', 'side']);

      for (const sha of [main, side]) {
        expect(await converged.snapshot('final.md', id, sha)).toMatchObject({
          frontmatter: { doc_id: id, title: 'Same' }, body: 'Same body.',
        });
      }
      expect(await converged.diff('final.md', id, main, side)).toMatchObject({
        frontmatterChanges: {}, bodyDiff: '',
      });
    } finally {
      const relative = path.relative(tmpdir(), project);
      expect(relative && !relative.startsWith('..') && !path.isAbsolute(relative)).toBeTruthy();
      rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
