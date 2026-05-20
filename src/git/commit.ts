// ============================================================================
// Git Commit Builder
// Formats structured commit messages and auto-commits on write operations.
//
// CommitOutcome is a three-state discriminated union so callers can tell
// (a) we committed and here's the sha; (b) nothing was staged so no commit
// was needed (benign — e.g. an update that didn't actually change the file);
// (c) git failed and the working tree may now hold staged-but-uncommitted
// changes. Before 0.6.10 we returned `sha | null` and swallowed all errors
// silently — bulk_create races or a mid-run lock conflict would leave the
// engine ack'ing writes as durable while git quietly held staged state.
// ============================================================================

import type { SimpleGit } from 'simple-git';
import type { DocId, DocType, CommitSha } from '../types.js';
import { commitSha } from '../types.js';

/**
 * 0.7.3 (fup-2026-095) — Per-invocation git identity. The engine should never
 * depend on the host user's `git config user.name/user.email` — when the host
 * lacks identity, every autoCommit silently fails with "Author identity
 * unknown" and the working tree drifts (observed 2026-04-23 on the brain-app
 * droplet: 21 staged-uncommitted files, gitClean=false stuck).
 *
 * Set GIT_AUTHOR_* / GIT_COMMITTER_* env vars per-invocation so simple-git
 * passes them to the spawned git process. These take precedence over
 * `git config` and don't require touching repo state. Defaults are stable
 * synthetic values; override per-deployment with MAAD_COMMIT_AUTHOR_NAME /
 * MAAD_COMMIT_AUTHOR_EMAIL.
 */
const DEFAULT_COMMIT_AUTHOR_NAME = 'maadb-engine';
const DEFAULT_COMMIT_AUTHOR_EMAIL = 'engine@maadb.local';

interface GitCommitIdentityEnv {
  GIT_AUTHOR_NAME: string;
  GIT_AUTHOR_EMAIL: string;
  GIT_COMMITTER_NAME: string;
  GIT_COMMITTER_EMAIL: string;
}

export function resolveCommitAuthor(env: NodeJS.ProcessEnv = process.env): GitCommitIdentityEnv {
  const name = env.MAAD_COMMIT_AUTHOR_NAME && env.MAAD_COMMIT_AUTHOR_NAME.length > 0
    ? env.MAAD_COMMIT_AUTHOR_NAME
    : DEFAULT_COMMIT_AUTHOR_NAME;
  const email = env.MAAD_COMMIT_AUTHOR_EMAIL && env.MAAD_COMMIT_AUTHOR_EMAIL.length > 0
    ? env.MAAD_COMMIT_AUTHOR_EMAIL
    : DEFAULT_COMMIT_AUTHOR_EMAIL;
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

/**
 * 0.7.0 — Identity snapshot for commit-message enrichment. Populated from
 * the session's token when `MAAD_COMMIT_IDENTITY` is on (default true in
 * 0.7.0 per dec-maadb-071 since fup-066 resolved). Set to false in the
 * deploy env to opt out for cautious deployments.
 */
export interface CommitIdentity {
  role: string;
  tokenId?: string;
  agentId?: string;
  userId?: string;
}

export interface CommitOptions {
  action: 'create' | 'update' | 'delete';
  docId: DocId;
  docType: DocType;
  detail: string;
  summary: string;
  files: string[];
  identity?: CommitIdentity;
}

/**
 * 0.6.10 — Three-state commit outcome. Replaces the prior `CommitSha | null`
 * return on autoCommit so callers can distinguish benign no-ops from real
 * failures that left staged changes uncommitted.
 */
export type CommitOutcome =
  | { status: 'committed'; sha: CommitSha }
  | { status: 'noop' }
  | { status: 'failed'; code: string; message: string };

// Format: maad:<action> <doc_id> [<doc_type>] <detail> — <summary>
// With identity (0.7.0 MAAD_COMMIT_IDENTITY=true): title unchanged, body
// appended with role/token/agent/user lines so `git log --grep` queries on
// identity stay simple without polluting the summary line.
export function formatCommitMessage(opts: CommitOptions): string {
  const detail = opts.detail ? `${opts.detail} ` : '';
  const title = `maad:${opts.action} ${opts.docId as string} [${opts.docType as string}] ${detail}— ${opts.summary}`;
  if (!opts.identity) return title;
  const lines = [`role: ${opts.identity.role}`];
  if (opts.identity.tokenId !== undefined) lines.push(`token: ${opts.identity.tokenId}`);
  if (opts.identity.agentId !== undefined) lines.push(`agent: ${opts.identity.agentId}`);
  if (opts.identity.userId !== undefined) lines.push(`user: ${opts.identity.userId}`);
  return `${title}\n\n${lines.join('\n')}`;
}

/**
 * 0.7.0 — Default ON in 0.7.0 per dec-maadb-071 (fup-066 resolved in 0.6.10
 * removed the silent-commit-failure concern that gated this). Operators opt
 * out with MAAD_COMMIT_IDENTITY=false.
 */
export function isCommitIdentityEnabled(): boolean {
  return process.env['MAAD_COMMIT_IDENTITY'] !== 'false';
}

// Parse a structured commit message back into components
const COMMIT_PARSE_REGEX = /^maad:(\w+)\s+([\w.-]+)\s+\[(\w+)\]\s*(.*?)\s*—\s*(.+)$/;

export interface ParsedCommitMessage {
  action: string;
  docId: string;
  docType: string;
  detail: string;
  summary: string;
}

export function parseCommitMessage(message: string): ParsedCommitMessage | null {
  const match = COMMIT_PARSE_REGEX.exec(message.split('\n')[0] ?? '');
  if (!match) return null;
  return {
    action: match[1]!,
    docId: match[2]!,
    docType: match[3]!,
    detail: match[4]!.trim(),
    summary: match[5]!.trim(),
  };
}

export async function autoCommit(
  git: SimpleGit,
  opts: CommitOptions,
): Promise<CommitOutcome> {
  try {
    // Stage specified files
    try {
      await git.add(opts.files);
    } catch (e) {
      return {
        status: 'failed',
        code: 'GIT_ADD_FAILED',
        message: `git add failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    // Check if there's anything to commit. Update paths where the file
    // actually equals its on-disk form produce an empty staged list — this
    // is benign (record is durable; git history matches state).
    let status;
    try {
      status = await git.status();
    } catch (e) {
      return {
        status: 'failed',
        code: 'GIT_STATUS_FAILED',
        message: `git status failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    // simple-git's StatusSummary.staged misses renames — `R` entries land in
    // `renamed[]` (with a parallel FileStatusSummary in `files[]` carrying
    // `index: 'R'`) and never appear in `staged[]`. Pre-0.7.10 this caused
    // soft-delete autoCommit to silently noop because soft-delete writes a
    // rename pair (cli-x.md → _deleted_cli-x.md) which git's rename detection
    // collapses. Fall back to the full files[] index column: anything other
    // than ' ' (clean) or '?' (untracked) is a real index entry the next
    // commit will pick up. The staged.length check stays as the fast path
    // (and to keep stubs that only populate `staged` working).
    const hasStagedChange =
      status.staged.length > 0
      || status.files.some(f => f.index !== ' ' && f.index !== '?');
    if (!hasStagedChange) {
      return { status: 'noop' };
    }

    const message = formatCommitMessage(opts);
    let result;
    try {
      // 0.7.3 (fup-2026-095) — set identity env per-call so we never depend
      // on the host's `git config user.name/user.email`. simple-git's .env()
      // is chainable and applies to the next spawned git process.
      const identity = resolveCommitAuthor();
      result = await git
        .env('GIT_AUTHOR_NAME', identity.GIT_AUTHOR_NAME)
        .env('GIT_AUTHOR_EMAIL', identity.GIT_AUTHOR_EMAIL)
        .env('GIT_COMMITTER_NAME', identity.GIT_COMMITTER_NAME)
        .env('GIT_COMMITTER_EMAIL', identity.GIT_COMMITTER_EMAIL)
        .commit(message);
    } catch (e) {
      // The add succeeded but the commit itself failed — worst case, since
      // the working tree is now dirty with staged but uncommitted changes.
      // Callers use this signal to stamp `write_durable: false` on the MCP
      // response so clients know to retry (or reconcile out-of-band).
      return {
        status: 'failed',
        code: 'GIT_COMMIT_FAILED',
        message: `git commit failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    if (!result.commit) {
      // simple-git returned an empty commit field — shouldn't happen after a
      // successful commit, but defend against it so durability tracking is
      // truthful rather than optimistic.
      return {
        status: 'failed',
        code: 'GIT_COMMIT_EMPTY',
        message: 'git commit returned no commit sha',
      };
    }
    return { status: 'committed', sha: commitSha(result.commit) };
  } catch (e) {
    // Defense-in-depth: anything that escapes the inner try/catches above
    // lands here so we never return undefined. Should be unreachable in
    // practice.
    return {
      status: 'failed',
      code: 'GIT_UNKNOWN_ERROR',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
