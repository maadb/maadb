// ============================================================================
// 0.7.3 — autoCommit identity env.
//
// resolveCommitAuthor() returns the GIT_AUTHOR_* / GIT_COMMITTER_* values that
// autoCommit threads into the spawned git process via simple-git's .env()
// chain. Defaults are stable synthetic values so the engine never depends on
// host `git config user.name/user.email` (the failure mode that left the
// brain-app droplet with 21 staged-uncommitted files on 2026-04-23).
// ============================================================================

import { describe, it, expect } from 'vitest';
import { resolveCommitAuthor } from '../../src/git/commit.js';

describe('resolveCommitAuthor', () => {
  it('returns synthetic defaults when env unset', () => {
    const id = resolveCommitAuthor({});
    expect(id.GIT_AUTHOR_NAME).toBe('maadb-engine');
    expect(id.GIT_AUTHOR_EMAIL).toBe('engine@maadb.local');
    expect(id.GIT_COMMITTER_NAME).toBe('maadb-engine');
    expect(id.GIT_COMMITTER_EMAIL).toBe('engine@maadb.local');
  });

  it('honors MAAD_COMMIT_AUTHOR_NAME / EMAIL when set', () => {
    const id = resolveCommitAuthor({
      MAAD_COMMIT_AUTHOR_NAME: 'Brain Engine',
      MAAD_COMMIT_AUTHOR_EMAIL: 'brain@maadb.ai',
    });
    expect(id.GIT_AUTHOR_NAME).toBe('Brain Engine');
    expect(id.GIT_AUTHOR_EMAIL).toBe('brain@maadb.ai');
    expect(id.GIT_COMMITTER_NAME).toBe('Brain Engine');
    expect(id.GIT_COMMITTER_EMAIL).toBe('brain@maadb.ai');
  });

  it('mirrors author to committer (single env pair drives both)', () => {
    const id = resolveCommitAuthor({
      MAAD_COMMIT_AUTHOR_NAME: 'X',
      MAAD_COMMIT_AUTHOR_EMAIL: 'x@y.z',
    });
    expect(id.GIT_AUTHOR_NAME).toBe(id.GIT_COMMITTER_NAME);
    expect(id.GIT_AUTHOR_EMAIL).toBe(id.GIT_COMMITTER_EMAIL);
  });

  it('falls back to defaults on empty-string env', () => {
    const id = resolveCommitAuthor({
      MAAD_COMMIT_AUTHOR_NAME: '',
      MAAD_COMMIT_AUTHOR_EMAIL: '',
    });
    expect(id.GIT_AUTHOR_NAME).toBe('maadb-engine');
    expect(id.GIT_AUTHOR_EMAIL).toBe('engine@maadb.local');
  });
});
