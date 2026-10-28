import type { SimpleGit } from 'simple-git';
import { parseMatter } from '../parser/matter.js';
import type { DocId } from '../types.js';

export interface HistoricalFile {
  path: string;
  content: string;
}

/** Pin revision expressions before using them in object reads or diffs. */
export async function resolveCommit(git: SimpleGit, ref: string): Promise<string | null> {
  try {
    const sha = (await git.raw(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
    return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Parse literal, NUL-delimited names, including merge-parent diffs with non-renames. */
function renamePairs(output: string): Array<[string, string]> {
  const tokens = output.split('\0');
  const renames: Array<[string, string]> = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++]!.trim();
    if (!status) continue;
    if (!/^[A-Z]\d*$/.test(status)) throw new Error('Invalid Git name-status output');
    const previous = tokens[i++];
    if (previous === undefined) throw new Error('Missing Git filename');
    if (status.startsWith('R') || status.startsWith('C')) {
      const next = tokens[i++];
      if (next === undefined) throw new Error('Missing Git destination');
      if (status.startsWith('R')) renames.push([previous, next]);
    }
  }
  return renames;
}

/**
 * Read the same document at an older path. Check the current path first, then
 * Git's rename chain. Unresolved merge paths also inspect each merge parent:
 * --follow alone chooses one parent and can omit conflict-resolution moves.
 * Reads stay in Git objects; no checkout, index write or persistent cache.
 */
export async function readHistoricalFile(
  git: SimpleGit,
  filePath: string,
  docId: DocId,
  commit: string,
  head: string,
): Promise<HistoricalFile | null> {
  const tried = new Set<string>();
  const readAt = async (candidate: string, revision: string): Promise<HistoricalFile | null> => {
    try {
      const content = await git.show(`${revision}:${candidate}`);
      // Fail closed if identity cannot be verified, including malformed YAML.
      // Filenames can be reused by unrelated documents.
      if (parseMatter(content).data.doc_id !== docId) return null;
      return { path: candidate, content };
    } catch {
      return null;
    }
  };
  const read = async (candidate: string): Promise<HistoricalFile | null> => {
    if (tried.has(candidate)) return null;
    tried.add(candidate);
    return readAt(candidate, commit);
  };
  const current = await read(filePath);
  if (current) return current;

  const pending = [{ ref: head, path: filePath }];
  const visited = new Set<string>();
  const mergeDiffs = new Map<string, Array<[string, string]>>();
  const ancestors = new Map<string, boolean>();
  try {
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const item = pending[cursor]!;
      const key = `${item.ref}:${item.path}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const names = new Set([item.path]);
      const output = await git.raw([
        '--literal-pathspecs', 'log', '-m', '--follow', '--find-renames',
        '--diff-filter=R', '--format=', '--name-status', '-z', item.ref, '--', item.path,
      ]);
      for (const [previous, next] of renamePairs(output)) {
        if (names.has(next)) names.add(previous);
      }
      for (const candidate of names) {
        const found = await read(candidate);
        if (found) return found;
      }

      // Only on an unresolved lookup: inspect merges affecting these names.
      // Diff each parent separately, then follow its old path on that branch.
      const merges = await git.raw([
        '--literal-pathspecs', 'log', '--full-history', '--sparse', '--merges',
        '--format=%H|%P', item.ref, '--', ...names,
      ]);
      for (const line of merges.trim().split('\n')) {
        if (!line) continue;
        const [merge, parents] = line.split('|');
        if (!merge || !parents) return null;
        for (const parent of parents.split(' ')) {
          let containsTarget = ancestors.get(parent);
          if (containsTarget === undefined) {
            try {
              await git.raw(['merge-base', '--is-ancestor', commit, parent]);
              containsTarget = true;
            } catch {
              containsTarget = false;
            }
            ancestors.set(parent, containsTarget);
          }
          if (!containsTarget) continue;
          // Both parents may have converged on the same filename, hiding an
          // earlier rename on the non-default branch. Follow verified paths
          // even when the merge itself has no rename entry for that parent.
          for (const candidate of names) {
            if (await readAt(candidate, parent)) pending.push({ ref: parent, path: candidate });
          }
          const pairKey = `${parent}:${merge}`;
          let pairs = mergeDiffs.get(pairKey);
          if (!pairs) {
            pairs = renamePairs(await git.raw([
              'diff-tree', '--no-commit-id', '-r', '--find-renames',
              '--name-status', '-z', parent, merge, '--',
            ]));
            mergeDiffs.set(pairKey, pairs);
          }
          for (const [previous, next] of pairs) {
            if (names.has(next)) {
              const found = await read(previous);
              if (found) return found;
              pending.push({ ref: parent, path: previous });
            }
          }
        }
      }
    }
  } catch {
    return null;
  }
  return null;
}
