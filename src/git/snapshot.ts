// ============================================================================
// Git Snapshot Reader
// Reads a document as it existed at a specific commit or date.
// ============================================================================

import type { SimpleGit } from 'simple-git';
import { parseMatter } from '../parser/matter.js';
import {
  commitSha as toCommitSha,
  type DocId,
  type CommitSha,
  type SnapshotResult,
} from '../types.js';

export async function getSnapshot(
  git: SimpleGit,
  filePath: string,
  docId: DocId,
  at: string,
): Promise<SnapshotResult | null> {
  // Resolve 'at' to a commit SHA
  let sha: string;
  let timestamp: string;

  if (/^[0-9a-f]{6,40}$/i.test(at)) {
    // Already a SHA
    sha = at;
    try {
      const info = await git.raw(['log', '-1', '--format=%aI', sha]);
      timestamp = info.trim();
    } catch {
      return null;
    }
  } else {
    // Treat as a date — find the last commit before that date
    try {
      const result = await git.raw([
        'log', '-1', `--before=${at}`, '--format=%H|%aI', '--', filePath,
      ]);
      if (!result.trim()) return null;
      const parts = result.trim().split('|');
      sha = parts[0]!;
      timestamp = parts[1]!;
    } catch {
      return null;
    }
  }

  // Read file content at that commit
  let content: string;
  try {
    content = await git.show(`${sha}:${filePath}`);
  } catch {
    return null;
  }

  // Parse frontmatter and body
  let frontmatter: Record<string, unknown> = {};
  let body = content;
  try {
    const parsed = parseMatter(content);
    frontmatter = parsed.data as Record<string, unknown>;
    body = parsed.content.trim();
  } catch {
    // If parsing fails, return raw content as body
  }

  return {
    docId,
    commit: toCommitSha(sha),
    timestamp,
    frontmatter,
    body,
  };
}
