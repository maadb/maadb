// ============================================================================
// TokenStore — writes by another process are not undone.
//
// The server and `maad auth` each hold a TokenStore on the same tokens.yaml.
// The server only notices the CLI's writes on its next change check, so a
// mutation must re-read a changed file first, and persist must refuse to
// rename over a file written after that read. Otherwise the server serializes
// its stale records and, for example, brings back a token just revoked.
// ============================================================================

import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { makeTokenFixture, type TokenFixture } from '../support/token-fixture.js';
import { TokenStore } from '../../src/auth/token-store.js';

const fsHooks = vi.hoisted(() => ({
  afterTmpWrite: null as null | (() => Promise<void>),
  failRename: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const writeFile = async (...args: Parameters<typeof actual.writeFile>): Promise<void> => {
    await actual.writeFile(...args);
    const hook = fsHooks.afterTmpWrite;
    if (hook && String(args[0]).endsWith('.tmp')) {
      fsHooks.afterTmpWrite = null;
      await hook();
    }
  };
  const rename = async (...args: Parameters<typeof actual.rename>): Promise<void> => {
    if (fsHooks.failRename) {
      fsHooks.failRename = false;
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    }
    return actual.rename(...args);
  };
  return { ...actual, writeFile, rename };
});

async function loadStore(root: string): Promise<TokenStore> {
  const loaded = await TokenStore.load(root);
  if (!loaded.ok) throw new Error(loaded.errors.map(e => e.message).join('; '));
  return loaded.value;
}

describe('TokenStore — writes by another process', () => {
  let fixture: TokenFixture | null = null;
  afterEach(async () => {
    fsHooks.afterTmpWrite = null;
    fsHooks.failRename = false;
    if (fixture) { await fixture.cleanup(); fixture = null; }
  });

  it('keeps a revocation made by another process when the server issues next', async () => {
    fixture = await makeTokenFixture();
    const server = fixture.store;
    const cli = await loadStore(fixture.tmpRoot);

    expect((await cli.revoke(fixture.record.id)).ok).toBe(true);
    // The server has not polled yet; its next mutation must not undo the revoke.
    const issued = await server.issue({ role: 'reader', projects: [{ name: '*' }] });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    expect(server.lookupById(fixture.record.id)?.revokedAt).toBeDefined();
    const onDisk = await loadStore(fixture.tmpRoot);
    expect(onDisk.lookupById(fixture.record.id)?.revokedAt).toBeDefined();
    expect(onDisk.lookupById(issued.value.record.id)).toBeDefined();
  });

  it('keeps a token the server issued when another process revokes next', async () => {
    fixture = await makeTokenFixture();
    const server = fixture.store;
    const cli = await loadStore(fixture.tmpRoot);

    const issued = await server.issue({ role: 'writer', projects: [{ name: '*' }] });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect((await cli.revoke(fixture.record.id)).ok).toBe(true);

    const onDisk = await loadStore(fixture.tmpRoot);
    expect(onDisk.lookupById(issued.value.record.id)?.revokedAt).toBeUndefined();
    expect(onDisk.lookupById(fixture.record.id)?.revokedAt).toBeDefined();
  });

  it('reports a reload done by a mutation to the next change check once', async () => {
    fixture = await makeTokenFixture();
    const server = fixture.store;
    const cli = await loadStore(fixture.tmpRoot);

    expect((await cli.revoke(fixture.record.id)).ok).toBe(true);
    expect((await server.issue({ role: 'reader', projects: [{ name: '*' }] })).ok).toBe(true);

    // The watcher still learns about the external revoke, so it can tear down
    // sessions bound to that token.
    const first = await server.reloadIfChanged();
    expect(first.changed).toBe(true);
    if (first.changed) expect(first.result.ok).toBe(true);
    expect(await server.reloadIfChanged()).toEqual({ changed: false });
  });

  it('refuses to overwrite a file written after the mutation read it', async () => {
    fixture = await makeTokenFixture();
    const server = fixture.store;
    const cli = await loadStore(fixture.tmpRoot);

    // The other process writes after this mutation re-read the file but
    // before it renames its own temp file into place.
    fsHooks.afterTmpWrite = async () => {
      expect((await cli.revoke(fixture!.record.id)).ok).toBe(true);
    };
    const issued = await server.issue({ role: 'reader', projects: [{ name: '*' }] });
    expect(issued.ok).toBe(false);
    if (issued.ok) return;
    expect(issued.errors[0]!.message).toMatch(/changed on disk during this update/);

    // The other process's revoke survived, and the failed issue left no trace.
    const onDisk = await loadStore(fixture.tmpRoot);
    expect(onDisk.lookupById(fixture.record.id)?.revokedAt).toBeDefined();
    expect(onDisk.size()).toBe(1);
    expect(server.size()).toBe(1);

    // A retry builds on the new file.
    const retried = await server.issue({ role: 'reader', projects: [{ name: '*' }] });
    expect(retried.ok).toBe(true);
    expect((await loadStore(fixture.tmpRoot)).lookupById(fixture.record.id)?.revokedAt).toBeDefined();
  });

  it('refuses to mutate while the file on disk is invalid, and leaves it as written', async () => {
    fixture = await makeTokenFixture();
    const server = fixture.store;
    const filePath = server.path();
    const broken = 'tokens: [not closed\n';
    await writeFile(filePath, broken, 'utf8');

    const first = await server.issue({ role: 'reader', projects: [{ name: '*' }] });
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.errors[0]!.code).toBe('TOKENS_FILE_INVALID');
    // Still refused on the next attempt, although the signature is now known.
    const second = await server.revoke(fixture.record.id);
    expect(second.ok).toBe(false);
    expect(await readFile(filePath, 'utf8')).toBe(broken);
  });

  // With mutations serialized, the record being rolled back is always the one
  // this call pushed, so removal by identity and removal by position agree.
  // This asserts the invariant itself: a failed persist leaves prior state
  // intact.
  it('a failed persist rolls back only the failing record', async () => {
    fixture = await makeTokenFixture();
    const store = fixture.store;
    const first = fixture.record;

    fsHooks.failRename = true;
    const failed = await store.issue({ role: 'reader', projects: [{ name: 'p' }] });
    expect(failed.ok).toBe(false);

    // The rollback must remove the record that failed — and only that one.
    // Removing by position instead of identity drops whichever record landed
    // last, which is the previously committed token.
    expect(store.lookupById(first.id)).toBeDefined();
    expect(store.size()).toBe(1);
    expect(store.list()[0]!.id).toBe(first.id);
  });
});
