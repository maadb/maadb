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
import { autoCommit, type CommitOptions, type CommitOutcome } from './commit.js';
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

    // Initial commit
    await this.git.add('.gitignore');
    await this.git.commit('maad:init — Initialize MAAD project');
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
}
