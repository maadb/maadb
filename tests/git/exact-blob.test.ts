import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readExactBlob, RECEIPT_MAX_BYTES } from '../../src/git/exact-blob.js';
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>() }));

let root: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true }).toString().trim();
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'receipt-git-'));
  git('init');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'noreply');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(path.join(root, 'one.md'), 'first\r\n');
  git('add', 'one.md'); git('commit', '-m', 'Initial fixture');
});
afterEach(() => {
  vi.restoreAllMocks();
  const relative = path.relative(tmpdir(), root);
  expect(relative && !relative.startsWith('..') && !path.isAbsolute(relative)).toBeTruthy();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('exact committed blob', () => {
  it('returns exact bytes and independently checkable immutable object IDs', async () => {
    const result = await readExactBlob(root, 'one.md');
    expect(result?.bytes.equals(Buffer.from('first\r\n'))).toBe(true);
    expect(result?.commitOid).toBe(git('rev-parse', 'HEAD'));
    expect(result?.treeOid).toBe(git('rev-parse', 'HEAD^{tree}'));
    expect(result?.blobOid).toBe(createHash('sha1').update('blob 7\0first\r\n').digest('hex'));
  });
  it('does not follow HEAD after pinning the commit', async () => {
    const old = git('rev-parse', 'HEAD');
    const spawn = childProcess.spawn;
    let advanced = false;
    vi.spyOn(childProcess, 'spawn').mockImplementation((...args: Parameters<typeof spawn>) => {
      if (!advanced && (args[1] as string[]).includes('ls-tree')) {
        advanced = true;
        writeFileSync(path.join(root, 'one.md'), 'second');
        git('add', 'one.md'); git('commit', '-m', 'Advance fixture');
      }
      return spawn(...args);
    });
    const result = await readExactBlob(root, 'one.md');
    expect(advanced).toBe(true);
    expect(result?.commitOid).toBe(old);
    expect(result?.bytes.toString()).toBe('first\r\n');
    expect(git('rev-parse', 'HEAD')).not.toBe(old);
  });
  it('reports only current-tree absence, without searching history', async () => {
    expect(await readExactBlob(root, 'absent.md')).toBeNull();
  });
  it('rejects oversized blobs before consuming them', async () => {
    writeFileSync(path.join(root, 'one.md'), Buffer.alloc(RECEIPT_MAX_BYTES + 1));
    git('add', 'one.md'); git('commit', '-m', 'Large fixture');
    await expect(readExactBlob(root, 'one.md')).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });
  it('rejects committed symlinks without depending on OS symlink privileges', async () => {
    const oid = git('rev-parse', 'HEAD:one.md');
    git('update-index', '--cacheinfo', `120000,${oid},one.md`);
    git('commit', '-m', 'Link fixture');
    await expect(readExactBlob(root, 'one.md')).rejects.toMatchObject({ code: 'RECEIPT_CONTENT_INVALID' });
  });
  it('rejects cancellation and path injection', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(readExactBlob(root, 'one.md', controller.signal)).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    for (const target of ['../one.md', 'a\\one.md', '/one.md', 'a:one.md']) {
      await expect(readExactBlob(root, target)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
    }
  });
  it('supports SHA-256 object stores', async () => {
    // Remove only the verified temporary fixture's .git directory.
    const marker = path.resolve(root, '.git');
    expect(path.dirname(marker)).toBe(root);
    rmSync(marker, { recursive: true, force: true });
    git('init', '--object-format=sha256');
    git('config', 'user.name', 'Test'); git('config', 'user.email', 'noreply');
    git('add', 'one.md'); git('commit', '-m', 'SHA256 fixture');
    const result = await readExactBlob(root, 'one.md');
    expect(result?.objectFormat).toBe('sha256');
    expect(result?.commitOid).toHaveLength(64);
    expect(result?.blobOid).toHaveLength(64);
  });
});
