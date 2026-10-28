// ============================================================================
// Git Diff Parser
// Compares two versions of a document and returns structured changes.
// ============================================================================

import type { SimpleGit } from 'simple-git';
import { parseMatter } from '../parser/matter.js';
import { readHistoricalFile, resolveCommit } from './historical-file.js';
import {
  commitSha as toCommitSha,
  type DocId,
  type DiffResult,
} from '../types.js';

export async function getDiff(
  git: SimpleGit,
  filePath: string,
  docId: DocId,
  from: string,
  to?: string,
): Promise<DiffResult | null> {
  const head = await resolveCommit(git, 'HEAD');
  if (!head) return null;
  const fromSha = from === 'HEAD' ? head : await resolveCommit(git, from);
  const toSha = to === undefined || to === 'HEAD' ? head : await resolveCommit(git, to);
  if (!fromSha || !toSha) return null;

  const oldFile = await readHistoricalFile(git, filePath, docId, fromSha, head);
  const newFile = await readHistoricalFile(git, filePath, docId, toSha, head);
  if (!oldFile || !newFile) return null;
  const oldFm = parseMatter(oldFile.content).data as Record<string, unknown>;
  const newFm = parseMatter(newFile.content).data as Record<string, unknown>;

  const frontmatterChanges: Record<string, { from: unknown; to: unknown }> = {};
  const allKeys = new Set([...Object.keys(oldFm), ...Object.keys(newFm)]);
  for (const key of allKeys) {
    const oldVal = oldFm[key];
    const newVal = newFm[key];
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      frontmatterChanges[key] = { from: oldVal ?? null, to: newVal ?? null };
    }
  }

  // Compare the two resolved blobs. A path-filtered tree diff can include
  // unrelated files after renames, or report a pure move as a deletion.
  let bodyDiff: string;
  try {
    bodyDiff = await git.diff([
      '--no-ext-diff', '--no-textconv',
      `${fromSha}:${oldFile.path}`, `${toSha}:${newFile.path}`, '--',
    ]);
  } catch {
    return null;
  }

  return {
    docId,
    from: toCommitSha(from),
    to: toCommitSha(to ?? 'HEAD'),
    frontmatterChanges,
    bodyDiff,
  };
}
