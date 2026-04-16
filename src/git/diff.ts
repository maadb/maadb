// ============================================================================
// Git Diff Parser
// Compares two versions of a document and returns structured changes.
// ============================================================================

import type { SimpleGit } from 'simple-git';
import { parseMatter } from '../parser/matter.js';
import {
  commitSha as toCommitSha,
  type DocId,
  type CommitSha,
  type DiffResult,
} from '../types.js';

export async function getDiff(
  git: SimpleGit,
  filePath: string,
  docId: DocId,
  from: string,
  to?: string,
): Promise<DiffResult | null> {
  const toRef = to ?? 'HEAD';

  // Get old and new file contents
  let oldContent: string;
  let newContent: string;
  try {
    oldContent = await git.show(`${from}:${filePath}`);
    newContent = await git.show(`${toRef}:${filePath}`);
  } catch {
    return null;
  }

  // Parse frontmatter from both versions
  const oldFm = parseFm(oldContent);
  const newFm = parseFm(newContent);

  // Diff frontmatter field by field
  const frontmatterChanges: Record<string, { from: unknown; to: unknown }> = {};
  const allKeys = new Set([...Object.keys(oldFm), ...Object.keys(newFm)]);
  for (const key of allKeys) {
    const oldVal = oldFm[key];
    const newVal = newFm[key];
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      frontmatterChanges[key] = { from: oldVal ?? null, to: newVal ?? null };
    }
  }

  // Get unified diff for the body
  let bodyDiff = '';
  try {
    bodyDiff = await git.diff([`${from}..${toRef}`, '--', filePath]);
  } catch {
    bodyDiff = '';
  }

  return {
    docId,
    from: toCommitSha(from),
    to: toCommitSha(toRef),
    frontmatterChanges,
    bodyDiff,
  };
}

function parseFm(content: string): Record<string, unknown> {
  try {
    return parseMatter(content).data as Record<string, unknown>;
  } catch {
    return {};
  }
}
