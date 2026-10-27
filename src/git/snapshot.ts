// ============================================================================
// Git Snapshot Reader
// Reads a document as it existed at a specific commit or date.
// ============================================================================

import type { SimpleGit } from 'simple-git';
import { parseMatter } from '../parser/matter.js';
import { readHistoricalFile, resolveCommit } from './historical-file.js';
import {
  commitSha as toCommitSha,
  type DocId,
  type SnapshotResult,
} from '../types.js';

export async function getSnapshot(
  git: SimpleGit,
  filePath: string,
  docId: DocId,
  at: string,
): Promise<SnapshotResult | null> {
  const head = await resolveCommit(git, 'HEAD');
  if (!head) return null;

  let sha: string;
  let timestamp: string;
  if (/^[0-9a-f]{6,64}$/i.test(at)) {
    const resolved = await resolveCommit(git, at);
    if (!resolved) return null;
    sha = resolved;
    try {
      timestamp = (await git.raw(['log', '-1', '--format=%aI', sha])).trim();
    } catch {
      return null;
    }
  } else {
    try {
      // Filtering --follow with --before can hide the later rename before Git
      // learns the old path. Walk first, then apply Git's date interpretation
      // to the committer timestamp (the same clock used by --before).
      const cutoffArg = (await git.raw(['rev-parse', `--until=${at}`])).trim();
      const cutoff = /^--min-age=(\d+)$/.exec(cutoffArg);
      if (!cutoff) return null;
      const result = await git.raw([
        '--literal-pathspecs', 'log', '-m', '--follow', '--find-renames',
        '--format=%H|%aI|%ct', head, '--', filePath,
      ]);
      const entry = result.trim().split('\n')
        .map(line => line.split('|'))
        .find(parts => parts.length === 3 && Number(parts[2]) <= Number(cutoff[1]));
      if (!entry) return null;
      sha = entry[0]!;
      timestamp = entry[1]!;
    } catch {
      return null;
    }
  }

  const historical = await readHistoricalFile(git, filePath, docId, sha, head);
  if (!historical) return null;
  const parsed = parseMatter(historical.content);
  return {
    docId,
    commit: toCommitSha(sha),
    timestamp,
    frontmatter: parsed.data as Record<string, unknown>,
    body: parsed.content.trim(),
  };
}
