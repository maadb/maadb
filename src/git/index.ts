// ============================================================================
// Git Layer — Public API
// Thin integration layer wrapping simple-git for MAAD operations.
// ============================================================================

import { simpleGit, type SimpleGit } from 'simple-git';
import { existsSync, writeFileSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import type {
  DocId,
  DocType,
  CommitSha,
  ParsedCommit,
  AuditEntry,
  DiffResult,
  SnapshotResult,
} from '../types.js';
import { autoCommit, buildGitEnv, type CommitOptions, type CommitOutcome } from './commit.js';
import { getHistory, getAudit } from './log.js';
import { getDiff } from './diff.js';
import { getSnapshot } from './snapshot.js';

export { formatCommitMessage, parseCommitMessage } from './commit.js';
export type { CommitOptions, CommitOutcome } from './commit.js';

export class GitLayer {
  private git: SimpleGit;
  private projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.git = simpleGit(projectRoot);
  }

  async isRepo(): Promise<boolean> {
    // Check if .git exists at the project root specifically — not a parent repo
    const gitDir = path.join(this.projectRoot, '.git');
    return existsSync(gitDir);
  }

  /**
   * Detect and recover from a stale .git/index.lock left by a prior crashed
   * process. Returns a recovery action string if the lock was removed, or
   * throws if the lock is recent (likely live) and should block startup.
   *
   * Threshold: 30 seconds. A lock younger than that is treated as a concurrent
   * process signal and not touched.
   */
  recoverStaleIndexLock(): { action: 'none' | 'removed' } | { action: 'conflict'; mtime: Date } {
    const lockPath = path.join(this.projectRoot, '.git', 'index.lock');
    if (!existsSync(lockPath)) return { action: 'none' };

    const stat = statSync(lockPath);
    const ageMs = Date.now() - stat.mtimeMs;
    const STALE_MS = 30_000;

    if (ageMs < STALE_MS) {
      return { action: 'conflict', mtime: stat.mtime };
    }

    unlinkSync(lockPath);
    return { action: 'removed' };
  }

  async initRepo(): Promise<void> {
    if (await this.isRepo()) return;

    await this.git.init();

    // Create .gitignore if it doesn't exist
    const gitignorePath = path.join(this.projectRoot, '.gitignore');
    if (!existsSync(gitignorePath)) {
      writeFileSync(gitignorePath, '_backend/\n', 'utf-8');
    }

    // Initial commit. Per-invocation identity env — same fragility as
    // autoCommit: a host without `git config user.name/email` would otherwise
    // fail this initial commit too. See buildGitEnv for the merge + askpass
    // stripping rationale.
    await this.git.add('.gitignore');
    await this.git
      .env(buildGitEnv())
      .commit('maad:init — Initialize MAAD project');
  }

  async commit(opts: CommitOptions): Promise<CommitOutcome> {
    return autoCommit(this.git, opts);
  }

  async history(
    filePath: string,
    opts?: { limit?: number; since?: string },
  ): Promise<ParsedCommit[]> {
    return getHistory(this.git, filePath, opts);
  }

  async audit(opts?: {
    since?: string;
    until?: string;
    docType?: DocType;
    action?: string;
  }): Promise<AuditEntry[]> {
    return getAudit(this.git, opts);
  }

  async diff(
    filePath: string,
    docId: DocId,
    from: string,
    to?: string,
  ): Promise<DiffResult | null> {
    return getDiff(this.git, filePath, docId, from, to);
  }

  async snapshot(
    filePath: string,
    docId: DocId,
    at: string,
  ): Promise<SnapshotResult | null> {
    return getSnapshot(this.git, filePath, docId, at);
  }

  getSimpleGit(): SimpleGit {
    return this.git;
  }

  // ---- 0.7.10 — tag operations for maad_backup ---------------------------

  async addAnnotatedTag(name: string, message: string, targetSha?: string): Promise<void> {
    // Inject the committer identity env — annotated tags need a tagger
    // identity and we can't depend on the host having `git config
    // user.name/user.email` set. Same pattern as autoCommit + initRepo
    // (0.7.3); see buildGitEnv for the merge + askpass
    // stripping rationale.
    const git = this.git.env(buildGitEnv());
    if (targetSha === undefined) {
      await git.addAnnotatedTag(name, message);
    } else {
      await git.raw(['tag', '-a', name, targetSha, '-m', message]);
    }
  }

  /**
   * List annotated tags whose name starts with the given prefix. Uses
   * for-each-ref so name + commit sha + tagger date + subject all come back
   * in one git call. Returns [] when no tags match.
   *
   * For annotated tags, `%(*objectname)` is the underlying commit sha.
   * For lightweight tags, that field is empty — we surface the empty sha
   * verbatim rather than fall back to the tag object's own sha, since
   * lightweight tags shouldn't appear under our prefix in practice.
   */
  async listTagsByPrefix(prefix: string): Promise<Array<{ tag: string; sha: string; message: string; createdAt: string }>> {
    const sep = '\x1f'; // ASCII unit separator — safe vs '|' in messages.
    const format = `%(refname:short)${sep}%(*objectname)${sep}%(taggerdate:iso-strict)${sep}%(contents:subject)`;
    const raw = await this.git.raw(['for-each-ref', `--format=${format}`, `refs/tags/${prefix}*`]);
    if (!raw.trim()) return [];
    return raw.trim().split('\n').map(line => {
      const parts = line.split(sep);
      return {
        tag: parts[0] ?? '',
        sha: parts[1] ?? '',
        createdAt: parts[2] ?? '',
        message: parts[3] ?? '',
      };
    });
  }

  async deleteTag(name: string): Promise<void> {
    await this.git.tag(['-d', name]);
  }

  /** Returns the HEAD commit sha, or null if the repo has no commits yet. */
  async headSha(): Promise<string | null> {
    try {
      const out = await this.git.revparse(['HEAD']);
      return out.trim() || null;
    } catch {
      return null;
    }
  }

  /** Returns the short branch name (e.g. "main") or "HEAD" when detached. */
  async currentBranch(): Promise<string> {
    try {
      const out = await this.git.revparse(['--abbrev-ref', 'HEAD']);
      return out.trim() || 'HEAD';
    } catch {
      return 'HEAD';
    }
  }
}
