// ============================================================================
// 0.7.10 — maad_backup coverage. Each test gets a fresh project copy with a
// freshly initialized engine + git repo (engine.init creates .git and the
// maad:init commit). Tests exercise engine.backupCreate/List/Delete; the
// MCP wrapper is a thin dispatch verified by kinds.test.ts.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync } from 'node:fs';
import { simpleGit } from 'simple-git';
import { MaadEngine } from '../../src/engine.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-backup');

let engine: MaadEngine;

beforeEach(async () => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  cpSync(FIXTURE_SRC, TEMP_ROOT, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}_backend`) && !src.includes(`${path.sep}.git`),
  });

  // Engine.init won't auto-create a git repo — it only checks for one. Bootstrap
  // a repo + initial commit so backup operations have a HEAD to anchor against.
  const setupGit = simpleGit(TEMP_ROOT);
  await setupGit.init();
  // Set repo-local identity so any direct simpleGit operations later in the
  // test body (e.g. tests that plant a "user-created" tag via
  // git.addAnnotatedTag without going through GitLayer) inherit it. Without
  // this, those direct calls fail on bare CI runners that have no global
  // git config.
  await setupGit.addConfig('user.email', 'test@example.com');
  await setupGit.addConfig('user.name', 'test');
  await setupGit.add('.').commit('test fixture init');

  engine = new MaadEngine();
  const result = await engine.init(TEMP_ROOT);
  expect(result.ok).toBe(true);
  await engine.indexAll({ force: true });
});

afterEach(async () => {
  engine.close();
  await new Promise(r => setTimeout(r, 100));
  try {
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Windows may briefly hold a db handle — non-fatal.
  }
});

const SNAPSHOT_NAME_REGEX = /^maad-snapshot-\d{4}-\d{2}-\d{2}-\d{4}(-[a-z0-9-]+)?$/;

describe('backupCreate', () => {
  it('creates a tag with the structured name and returns {tag, sha, message, createdAt}', async () => {
    const result = await engine.backupCreate();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tag).toMatch(SNAPSHOT_NAME_REGEX);
    expect(result.value.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.value.message).toContain('MAADB snapshot at');
    expect(result.value.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('appends sanitized label to the tag name', async () => {
    const result = await engine.backupCreate({ label: 'Pre-Cleanup Wave' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tag).toMatch(/-pre-cleanup-wave$/);
  });

  it('rejects a label that sanitizes to empty', async () => {
    const result = await engine.backupCreate({ label: '!!! @@@' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('INVALID_FIELDS');
  });

  it('caps label at 32 chars', async () => {
    const longLabel = 'a'.repeat(50);
    const result = await engine.backupCreate({ label: longLabel });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const labelPart = result.value.tag.replace(/^maad-snapshot-\d{4}-\d{2}-\d{2}-\d{4}-/, '');
    expect(labelPart.length).toBeLessThanOrEqual(32);
  });

  it('uses operator-supplied message when provided', async () => {
    const result = await engine.backupCreate({ message: 'before bulk_delete dry-run review' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.message).toBe('before bulk_delete dry-run review');
  });

  it('returns TAG_EXISTS on collision (no overwrite)', async () => {
    const first = await engine.backupCreate({ label: 'same' });
    expect(first.ok).toBe(true);
    // Re-create with the same label within the same minute — name collides.
    const second = await engine.backupCreate({ label: 'same' });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.errors[0]!.code).toBe('TAG_EXISTS');
  });
});

describe('backupList', () => {
  it('returns [] when no snapshots exist yet', async () => {
    const result = await engine.backupList();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it('returns every maad-snapshot-* tag with sha/message/createdAt', async () => {
    await engine.backupCreate({ label: 'one' });
    await engine.backupCreate({ label: 'two' });

    const result = await engine.backupList();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(2);
    for (const tag of result.value) {
      expect(tag.tag).toMatch(SNAPSHOT_NAME_REGEX);
      expect(tag.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(tag.message).toContain('MAADB snapshot');
      expect(tag.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it('ignores non-snapshot tags', async () => {
    // Plant a user-created tag outside the maad-snapshot-* namespace.
    const git = simpleGit(TEMP_ROOT);
    await git.addAnnotatedTag('user-release-v1', 'shipped release');
    await engine.backupCreate({ label: 'mine' });

    const result = await engine.backupList();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(1);
    expect(result.value[0]!.tag).toMatch(/-mine$/);
  });

  it('since filter excludes earlier tags', async () => {
    await engine.backupCreate({ label: 'old' });
    // Mid-test cut-off: now + small buffer so a fresh tag created after this
    // ISO timestamp is included while the earlier one is excluded.
    await new Promise(r => setTimeout(r, 1100));
    const sinceIso = new Date().toISOString();
    await new Promise(r => setTimeout(r, 1100));
    await engine.backupCreate({ label: 'new' });

    const result = await engine.backupList({ since: sinceIso });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(1);
    expect(result.value[0]!.tag).toMatch(/-new$/);
  });

  it('rejects invalid since with INVALID_FIELDS', async () => {
    const result = await engine.backupList({ since: 'not-a-date' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('INVALID_FIELDS');
  });
});

describe('backupDelete', () => {
  it('removes an existing snapshot tag', async () => {
    const created = await engine.backupCreate({ label: 'drop-me' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const removed = await engine.backupDelete(created.value.tag);
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.value.removed).toBe(created.value.tag);

    const list = await engine.backupList();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.value.some(t => t.tag === created.value.tag)).toBe(false);
  });

  it('returns TAG_NOT_FOUND when the tag does not exist', async () => {
    const result = await engine.backupDelete('maad-snapshot-2020-01-01-0000-ghost');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('TAG_NOT_FOUND');
  });

  it('refuses to delete tags outside the maad-snapshot-* namespace', async () => {
    const git = simpleGit(TEMP_ROOT);
    await git.addAnnotatedTag('user-release-v1', 'shipped release');

    const result = await engine.backupDelete('user-release-v1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('INVALID_FIELDS');

    // The user tag survives the rejection.
    const tags = await git.tags();
    expect(tags.all).toContain('user-release-v1');
  });

  it('deletes only the tag label — the underlying commit stays in history', async () => {
    const created = await engine.backupCreate({ label: 'transient' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taggedSha = created.value.sha;

    await engine.backupDelete(created.value.tag);

    // The commit is still reachable from HEAD (we never moved HEAD).
    const git = simpleGit(TEMP_ROOT);
    const log = await git.log();
    expect(log.all.some(c => c.hash === taggedSha)).toBe(true);
  });
});
