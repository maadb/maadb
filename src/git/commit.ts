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
    if (status.staged.length === 0) {
      return { status: 'noop' };
    }

    const message = formatCommitMessage(opts);
    let result;
    try {
      result = await git.commit(message);
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
