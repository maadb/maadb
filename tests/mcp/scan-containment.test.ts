// ============================================================================
// Scan path containment — link-escape regression
//
// maad_scan gates its target with a lexical containment check and then a
// canonical (link-following) one. The lexical check alone is not sufficient:
// every segment of `<root>/link/secret.md` is nominally inside the root, so it
// passes string comparison while resolving to wherever `link` points.
//
// These tests build a real link out of a project root to an external sentinel
// file and assert the canonical gate refuses it. The sentinel content must
// never be reachable through the gate.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { isContainedIn, isReallyContainedIn } from '../../src/engine/pathguard.js';
import { resolveScanTarget } from '../../src/mcp/tools/discover.js';
import { scanDirectory } from '../../src/scanner.js';

const SENTINEL = '# SENTINEL-OUTSIDE-ROOT\n';

let base: string;
let projectRoot: string;
let outside: string;
/** Link creation needs privilege on some platforms; skip rather than fail. */
let linkCreated = false;

beforeAll(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'maad-scan-containment-'));
  projectRoot = path.join(base, 'root');
  outside = path.join(base, 'outside');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'secret.md'), SENTINEL, 'utf8');
  // A directory link inside the root pointing out of it. 'junction' is the
  // unprivileged form on Windows; 'dir' is the POSIX equivalent.
  try {
    await symlink(outside, path.join(projectRoot, 'linkdir'),
      process.platform === 'win32' ? 'junction' : 'dir');
    linkCreated = true;
  } catch {
    linkCreated = false;
  }
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true }).catch(() => {});
});

describe('maad_scan target containment', () => {
  it('lexical containment alone accepts a path that escapes through a link', () => {
    if (!linkCreated) return;
    const target = path.resolve(projectRoot, 'linkdir/secret.md');
    // Documents WHY the second gate exists — this is the hole, not the fix.
    expect(isContainedIn(target, projectRoot)).toBe(true);
  });

  it('the escaping path really does resolve to the external sentinel', async () => {
    if (!linkCreated) return;
    const target = path.resolve(projectRoot, 'linkdir/secret.md');
    // Proves the fixture is a genuine escape and not a no-op: the file is
    // readable and is the sentinel, so the gate is the only thing standing
    // between maad_scan and content outside the project.
    expect(statSync(target).isFile()).toBe(true);
    expect(await readFile(target, 'utf8')).toBe(SENTINEL);
    expect(isReallyContainedIn(target, projectRoot)).toBe(false);
  });

  it('the scan gate refuses a file reached through a link', () => {
    if (!linkCreated) return;
    const result = resolveScanTarget(projectRoot, 'linkdir/secret.md');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PATH_OUTSIDE_PROJECT');
  });

  it('the scan gate refuses a directory reached through a link', () => {
    if (!linkCreated) return;
    const result = resolveScanTarget(projectRoot, 'linkdir');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PATH_OUTSIDE_PROJECT');
  });

  it('the scan gate still rejects plain traversal', () => {
    const result = resolveScanTarget(projectRoot, '../outside/secret.md');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PATH_OUTSIDE_PROJECT');
  });

  it('the scan gate reports a missing file as not-found, not as an escape', () => {
    // Ordering regression: running the canonical check before the stat would
    // turn every typo into PATH_OUTSIDE_PROJECT, because realpath throws on a
    // path that does not exist.
    const result = resolveScanTarget(projectRoot, 'no-such-file.md');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PATH_NOT_FOUND');
  });

  it('the scan gate still admits ordinary paths inside the root', async () => {
    await writeFile(path.join(projectRoot, 'real.md'), '# real\n', 'utf8');

    const file = resolveScanTarget(projectRoot, 'real.md');
    expect(file.ok).toBe(true);
    if (file.ok) expect(file.kind).toBe('file');

    const dir = resolveScanTarget(projectRoot, '.');
    expect(dir.ok).toBe(true);
    if (dir.ok) expect(dir.kind).toBe('directory');
  });

  it('directory scan does not traverse a link out of the root', async () => {
    if (!linkCreated) return;
    const result = await scanDirectory(projectRoot);
    // readdir(withFileTypes) reports links as links, so the walker takes
    // neither the directory nor the file branch and skips them. Asserted here
    // so that behaviour cannot regress silently into a corpus-level escape.
    const escaped = result.files.filter(f => f.path.includes('linkdir'));
    expect(escaped).toEqual([]);
    for (const f of result.files) {
      expect(isReallyContainedIn(path.resolve(projectRoot, f.path), projectRoot)).toBe(true);
    }
  });
});
