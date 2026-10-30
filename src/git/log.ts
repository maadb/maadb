// ============================================================================
// Git Log Parser
// Queries git history and parses structured MAAD commit messages.
// ============================================================================

import type { SimpleGit } from 'simple-git';
import { parseCommitMessage } from './commit.js';
import { logger } from '../engine/logger.js';
import {
  docId as toDocId,
  docType as toDocType,
  commitSha as toCommitSha,
  type DocId,
  type DocType,
  type ParsedCommit,
  type AuditEntry,
} from '../types.js';

// Git --since="2026-04-08" excludes commits from that day.
// Appending T00:00:00 makes it inclusive of the specified date.
function normalizeDateArg(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00`;
  return value;
}

export async function getHistory(
  git: SimpleGit,
  filePath: string,
  opts?: { limit?: number; since?: string },
): Promise<ParsedCommit[]> {
  // Git's -n counts commits before the MAAD filter below, so widen the window
  // until the limit is met or the file's history runs out.
  for (let window = opts?.limit; ; window = (window as number) * 4) {
    const args = ['--follow', '--format=%H|%an|%aI|%s'];

    if (window) args.push(`-n`, String(window));
    if (opts?.since) args.push(`--since=${normalizeDateArg(opts.since)}`);

    args.push('--', filePath);

    let logOutput: string;
    try {
      logOutput = await git.raw(['log', ...args]);
    } catch (e) {
      logger.bestEffort('git', 'history', `Git log failed for ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }

    const lines = logOutput.trim() ? logOutput.trim().split('\n') : [];
    const commits = parseHistoryLines(lines);
    if (!window || lines.length < window || commits.length >= (opts?.limit as number)) {
      return opts?.limit ? commits.slice(0, opts.limit) : commits;
    }
  }
}

function parseHistoryLines(lines: string[]): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 4) continue;

    const sha = parts[0]!;
    const author = parts[1]!;
    const timestamp = parts[2]!;
    const subject = parts.slice(3).join('|'); // subject may contain |

    const parsed = parseCommitMessage(subject);
    if (!parsed) continue; // skip non-MAAD commits

    commits.push({
      action: parsed.action,
      docId: toDocId(parsed.docId),
      docType: toDocType(parsed.docType),
      detail: parsed.detail,
      summary: parsed.summary,
      sha: toCommitSha(sha),
      author,
      timestamp,
    });
  }

  return commits;
}

export async function getAudit(
  git: SimpleGit,
  opts?: { since?: string; until?: string; docType?: DocType; action?: string },
): Promise<AuditEntry[]> {
  const args = ['--format=%H|%an|%aI|%s'];

  if (opts?.since) args.push(`--since=${normalizeDateArg(opts.since)}`);
  if (opts?.until) args.push(`--until=${normalizeDateArg(opts.until)}`);

  let logOutput: string;
  try {
    logOutput = await git.raw(['log', ...args]);
  } catch (e) {
    logger.bestEffort('git', 'audit', `Git log failed: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }

  if (!logOutput.trim()) return [];

  // Aggregate by docId
  const byDoc = new Map<string, {
    docType: string;
    actions: number;
    lastAction: string;
    lastSummary: string;
    lastAuthor: string;
    lastTimestamp: string;
  }>();

  for (const line of logOutput.trim().split('\n')) {
    const parts = line.split('|');
    if (parts.length < 4) continue;

    const author = parts[1]!;
    const timestamp = parts[2]!;
    const subject = parts.slice(3).join('|');

    const parsed = parseCommitMessage(subject);
    if (!parsed) continue;

    // Apply filters
    if (opts?.docType && parsed.docType !== (opts.docType as string)) continue;
    if (opts?.action && parsed.action !== opts.action) continue;

    const existing = byDoc.get(parsed.docId);
    if (existing) {
      existing.actions++;
      // Keep the most recent (first in git log, which is newest)
    } else {
      byDoc.set(parsed.docId, {
        docType: parsed.docType,
        actions: 1,
        lastAction: parsed.action,
        lastSummary: parsed.summary,
        lastAuthor: author,
        lastTimestamp: timestamp,
      });
    }
  }

  return [...byDoc.entries()].map(([id, data]): AuditEntry => ({
    docId: toDocId(id),
    docType: toDocType(data.docType),
    actions: data.actions,
    lastAction: data.lastAction,
    lastSummary: data.lastSummary,
    lastAuthor: data.lastAuthor,
    lastTimestamp: data.lastTimestamp,
  }));
}
