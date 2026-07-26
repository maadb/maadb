// ============================================================================
// 0.7.0 P1 — TokenStore primitives
//
// Covers the registry primitives shipped in Phase 1: load, lookup, issue,
// revoke, rotate, atomic persistence. Auth middleware (resolveToken) and
// three-cap role composition are P2 and tested separately.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import {
  TokenStore,
  generatePlaintext,
  hashPlaintext,
  looksLikeToken,
  TOKENS_FILE_RELATIVE,
} from '../../src/auth/token-store.js';
import { tokenId, type TokenId } from '../../src/auth/types.js';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'maad-tokens-'));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

async function seedFile(contents: string): Promise<void> {
  const dir = path.join(tmpRoot, '_auth');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'tokens.yaml'), contents, 'utf8');
}

describe('plaintext + hash primitives', () => {
  it('generatePlaintext produces the locked format maad_pat_<32hex>', () => {
    const t = generatePlaintext();
    expect(t).toMatch(/^maad_pat_[0-9a-f]{32}$/);
  });

  it('hashPlaintext returns SHA-256 hex of the plaintext', () => {
    const plain = 'maad_pat_' + 'a'.repeat(32);
    const expected = createHash('sha256').update(plain, 'utf8').digest('hex');
    expect(hashPlaintext(plain)).toBe(expected);
  });

  it('looksLikeToken accepts valid plaintext and rejects the rest', () => {
    expect(looksLikeToken(generatePlaintext())).toBe(true);
    expect(looksLikeToken('maad_pat_short')).toBe(false);
    expect(looksLikeToken('bearer-xyz')).toBe(false);
    expect(looksLikeToken('')).toBe(false);
  });
});

describe('TokenStore.load', () => {
  it('returns an empty store when the file is absent (HTTP boot still decides)', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.size()).toBe(0);
    expect(loaded.value.activeCount()).toBe(0);
    expect(loaded.value.list()).toEqual([]);
  });

  it('rejects parse errors with TOKENS_FILE_INVALID including file path', async () => {
    await seedFile('tokens: [not valid: yaml');
    const loaded = await TokenStore.load(tmpRoot);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.errors[0]?.code).toBe('TOKENS_FILE_INVALID');
    expect(loaded.errors[0]?.message).toContain('tokens.yaml parse error');
  });

  it('rejects invalid top-level shape (not a mapping)', async () => {
    await seedFile('- just\n- a\n- sequence');
    const loaded = await TokenStore.load(tmpRoot);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.errors[0]?.code).toBe('TOKENS_FILE_INVALID');
  });

  it('treats empty file as an empty registry', async () => {
    await seedFile('');
    const loaded = await TokenStore.load(tmpRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.size()).toBe(0);
  });

  it('loads valid records and populates hash + id indexes', async () => {
    await seedFile(`
name: "test-registry"
tokens:
  - id: tok-aaa111
    hash: deadbeef
    role: admin
    projects:
      - name: "*"
    created_at: "2026-04-21T00:00:00Z"
  - id: tok-bbb222
    hash: cafebabe
    role: reader
    projects:
      - name: proj-alpha
      - name: proj-beta
        role: reader
    agent_id: agt-test
    created_at: "2026-04-21T01:00:00Z"
`);
    const loaded = await TokenStore.load(tmpRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const store = loaded.value;

    expect(store.size()).toBe(2);
    expect(store.name()).toBe('test-registry');

    const found = store.lookupByHash('deadbeef' as import('../../src/auth/types.js').TokenHash);
    expect(found?.id).toBe('tok-aaa111');
    expect(found?.role).toBe('admin');
    expect(found?.projects).toEqual([{ name: '*' }]);

    const byId = store.lookupById(tokenId('tok-bbb222'));
    expect(byId?.hash).toBe('cafebabe');
    expect(byId?.agentId).toBe('agt-test');
    expect(byId?.projects).toEqual([{ name: 'proj-alpha' }, { name: 'proj-beta', role: 'reader' }]);
  });

  it('rejects invalid role values', async () => {
    await seedFile(`
tokens:
  - id: tok-xxx
    hash: abc
    role: superuser
    projects: []
    created_at: "2026-04-21T00:00:00Z"
`);
    const loaded = await TokenStore.load(tmpRoot);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.errors[0]?.code).toBe('TOKENS_FILE_INVALID');
    expect(loaded.errors[0]?.message).toContain('role');
  });

  it('rejects missing required fields', async () => {
    await seedFile(`
tokens:
  - id: tok-xxx
    role: admin
    projects: []
    created_at: "2026-04-21T00:00:00Z"
`);
    const loaded = await TokenStore.load(tmpRoot);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.errors[0]?.code).toBe('TOKENS_FILE_INVALID');
    expect(loaded.errors[0]?.message).toContain('hash');
  });
});

describe('TokenStore.issue', () => {
  it('generates plaintext + hash, persists atomically, returns both', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const store = loaded.value;

    const issued = await store.issue({
      name: 'brain-app gateway',
      role: 'admin',
      projects: [{ name: '*' }],
      agentId: 'agt-brain-app',
    });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    // Plaintext matches locked format + hash is SHA-256 of plaintext.
    expect(issued.value.plaintext).toMatch(/^maad_pat_[0-9a-f]{32}$/);
    expect(hashPlaintext(issued.value.plaintext)).toBe(issued.value.record.hash);
    expect(issued.value.record.id).toMatch(/^tok-[0-9a-f]{12}$/);
    expect(issued.value.record.agentId).toBe('agt-brain-app');
    expect(issued.value.record.role).toBe('admin');
    expect(issued.value.record.revokedAt).toBeUndefined();

    // In-memory index updated.
    expect(store.size()).toBe(1);
    expect(store.lookupByHash(issued.value.record.hash)).toBeDefined();
    expect(store.lookupById(issued.value.record.id)).toBeDefined();

    // Persisted to disk.
    const reloaded = await TokenStore.load(tmpRoot);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.value.size()).toBe(1);
    const found = reloaded.value.lookupByHash(issued.value.record.hash);
    expect(found?.id).toBe(issued.value.record.id);
  });

  it('creates the _auth/ directory when absent', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    await loaded.value.issue({ role: 'writer', projects: [{ name: 'proj-x' }] });

    const contents = await readFile(path.join(tmpRoot, TOKENS_FILE_RELATIVE), 'utf8');
    expect(contents).toContain('tokens:');
    expect(contents).toContain('role: writer');
  });

  it('two issues produce distinct ids and hashes', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    if (!loaded.ok) return;
    const store = loaded.value;

    const a = await store.issue({ role: 'reader', projects: [{ name: '*' }] });
    const b = await store.issue({ role: 'reader', projects: [{ name: '*' }] });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    expect(a.value.record.id).not.toBe(b.value.record.id);
    expect(a.value.record.hash).not.toBe(b.value.record.hash);
    expect(a.value.plaintext).not.toBe(b.value.plaintext);
  });
});

describe('TokenStore.revoke', () => {
  it('sets revokedAt, record stays in registry for audit lookups', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    if (!loaded.ok) return;
    const store = loaded.value;
    const issued = await store.issue({ role: 'admin', projects: [{ name: '*' }] });
    if (!issued.ok) return;

    const revoked = await store.revoke(issued.value.record.id);
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) return;
    expect(revoked.value.revokedAt).toBeDefined();
    expect(store.size()).toBe(1); // still in store
    expect(store.activeCount()).toBe(0); // but not active
  });

  it('is idempotent — second revoke is a no-op', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    if (!loaded.ok) return;
    const store = loaded.value;
    const issued = await store.issue({ role: 'admin', projects: [{ name: '*' }] });
    if (!issued.ok) return;

    const first = await store.revoke(issued.value.record.id);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const firstStamp = first.value.revokedAt;

    const second = await store.revoke(issued.value.record.id);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.revokedAt).toBe(firstStamp);
  });

  it('returns TOKEN_NOT_FOUND for unknown id', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    if (!loaded.ok) return;
    const revoked = await loaded.value.revoke(tokenId('tok-does-not-exist'));
    expect(revoked.ok).toBe(false);
    if (revoked.ok) return;
    expect(revoked.errors[0]?.code).toBe('TOKEN_NOT_FOUND');
  });
});

describe('TokenStore.rotate', () => {
  it('revokes old + issues new with preserved capabilities', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    if (!loaded.ok) return;
    const store = loaded.value;

    const original = await store.issue({
      name: 'gateway',
      role: 'writer',
      projects: [{ name: 'proj-a' }, { name: 'proj-b', role: 'reader' }],
      agentId: 'agt-gateway',
    });
    if (!original.ok) return;

    const rotated = await store.rotate(original.value.record.id);
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;

    // New record: different id + hash + plaintext, SAME capabilities.
    expect(rotated.value.record.id).not.toBe(original.value.record.id);
    expect(rotated.value.record.hash).not.toBe(original.value.record.hash);
    expect(rotated.value.plaintext).not.toBe(original.value.plaintext);
    expect(rotated.value.record.name).toBe('gateway');
    expect(rotated.value.record.role).toBe('writer');
    expect(rotated.value.record.agentId).toBe('agt-gateway');
    expect(rotated.value.record.projects).toEqual([
      { name: 'proj-a' },
      { name: 'proj-b', role: 'reader' },
    ]);
    expect(rotated.value.record.revokedAt).toBeUndefined();

    // Old record: revokedAt set, still in store.
    const old = store.lookupById(original.value.record.id);
    expect(old?.revokedAt).toBeDefined();
    expect(store.size()).toBe(2); // both records
    expect(store.activeCount()).toBe(1); // only the new one is active
  });

  it('refuses to rotate an already-revoked token', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    if (!loaded.ok) return;
    const store = loaded.value;
    const issued = await store.issue({ role: 'admin', projects: [{ name: '*' }] });
    if (!issued.ok) return;
    await store.revoke(issued.value.record.id);

    const rotated = await store.rotate(issued.value.record.id);
    expect(rotated.ok).toBe(false);
    if (rotated.ok) return;
    expect(rotated.errors[0]?.code).toBe('TOKEN_REVOKED');
  });

  it('returns TOKEN_NOT_FOUND for unknown id', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    if (!loaded.ok) return;
    const rotated = await loaded.value.rotate(tokenId('tok-missing'));
    expect(rotated.ok).toBe(false);
    if (rotated.ok) return;
    expect(rotated.errors[0]?.code).toBe('TOKEN_NOT_FOUND');
  });
});

describe('TokenStore.reload — in-place refresh for SIGHUP', () => {
  it('picks up new tokens added to disk without replacing the store reference', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    if (!loaded.ok) return;
    const store = loaded.value;
    await store.issue({ role: 'admin', projects: [{ name: '*' }], name: 'original' });
    expect(store.size()).toBe(1);

    // Externally append a new entry (simulates maad auth issue-token run
    // in a separate process, or an operator editing tokens.yaml directly).
    const externalPlain = 'maad_pat_' + 'c'.repeat(32);
    const externalHash = createHash('sha256').update(externalPlain, 'utf8').digest('hex');
    await seedFile(`
tokens:
${store.list().map(r => `  - id: ${r.id}\n    hash: ${r.hash}\n    role: ${r.role}\n    projects:\n      - name: "*"\n    created_at: "${r.createdAt}"`).join('\n')}
  - id: tok-external
    hash: ${externalHash}
    role: reader
    projects:
      - name: proj-x
    created_at: "2026-04-21T20:00:00Z"
`);

    // Reference retained before reload
    const reloaded = await store.reload();
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.value.total).toBe(2);
    expect(reloaded.value.active).toBe(2);

    // Same store instance — captures by upstream code see the new data.
    expect(store.size()).toBe(2);
    expect(store.lookupById(tokenId('tok-external'))?.role).toBe('reader');
  });

  it('leaves state untouched on parse error', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    if (!loaded.ok) return;
    const store = loaded.value;
    await store.issue({ role: 'admin', projects: [{ name: '*' }] });
    const beforeSize = store.size();

    // Clobber the file with garbage
    await seedFile('this is: [definitely: [not valid');
    const result = await store.reload();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe('TOKENS_FILE_INVALID');
    // In-memory state unchanged
    expect(store.size()).toBe(beforeSize);
  });

  it('empties the store when the file is deleted externally', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    if (!loaded.ok) return;
    const store = loaded.value;
    await store.issue({ role: 'admin', projects: [{ name: '*' }] });
    expect(store.size()).toBe(1);

    await rm(path.join(tmpRoot, '_auth'), { recursive: true, force: true });
    const result = await store.reload();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(0);
    expect(store.size()).toBe(0);
  });
});

describe('TokenStore.activeCount — expiry semantics', () => {
  it('excludes expired tokens without mutating them', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    if (!loaded.ok) return;
    const store = loaded.value;

    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();

    await store.issue({ role: 'admin', projects: [{ name: '*' }], expiresAt: past });
    await store.issue({ role: 'admin', projects: [{ name: '*' }], expiresAt: future });
    await store.issue({ role: 'admin', projects: [{ name: '*' }] });

    expect(store.size()).toBe(3);
    expect(store.activeCount()).toBe(2); // future + never-expires
  });
});

// ============================================================================
// Concurrent mutation
//
// issue/revoke/rotate each mutate the in-memory indexes and then serialize the
// whole record set to disk. Overlapping calls therefore contend on two pieces
// of shared state: the temp file used for the atomic rename, and the snapshot
// of `records` each persist writes. Both are covered here.
// ============================================================================

describe('TokenStore — concurrent mutation', () => {
  it('concurrent issue keeps memory and disk in agreement', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const store = loaded.value;

    const N = 25;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.issue({ role: 'writer', projects: [{ name: `proj-${i}` }] })),
    );

    // Every issue reports success — a shared temp path surfaces here as a
    // rename failure on whichever call loses the race.
    for (const r of results) expect(r.ok).toBe(true);

    const issuedIds = results.flatMap(r => (r.ok ? [r.value.record.id] : []));
    expect(new Set(issuedIds).size).toBe(N);
    expect(store.size()).toBe(N);

    // Disk must carry the same set — not merely the same count. A lost write
    // shows up as a token that still authenticates from memory but is absent
    // from the file, so compare identities.
    const reloaded = await TokenStore.load(tmpRoot);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    expect(reloaded.value.size()).toBe(N);
    for (const id of issuedIds) {
      expect(reloaded.value.lookupById(id)).toBeDefined();
    }
  });

  it('leaves no temp files behind after concurrent issue', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    if (!loaded.ok) return;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        loaded.value.issue({ role: 'reader', projects: [{ name: 'p' }] })),
    );

    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(path.join(tmpRoot, '_auth'));
    expect(entries.filter(e => e.endsWith('.tmp'))).toEqual([]);
  });

  // Note: with mutations serialized, the record being rolled back is always the
  // one this call pushed, so removal by identity and removal by position agree.
  // This asserts the invariant itself — that a failed persist leaves prior
  // state intact — rather than the identity-vs-position distinction, which is
  // not reachable while the mutation chain holds.
  it('a failed persist rolls back only the failing record', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    if (!loaded.ok) return;
    const store = loaded.value;

    const first = await store.issue({ role: 'admin', projects: [{ name: '*' }] });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // Force the next persist to fail by replacing _auth/ with a file, so the
    // directory create inside persist() errors.
    const { rm: rmPath, writeFile: write } = await import('node:fs/promises');
    await rmPath(path.join(tmpRoot, '_auth'), { recursive: true, force: true });
    await write(path.join(tmpRoot, '_auth'), 'not a directory', 'utf8');

    const failed = await store.issue({ role: 'reader', projects: [{ name: 'p' }] });
    expect(failed.ok).toBe(false);

    // The rollback must remove the record that failed — and only that one.
    // Removing by position instead of identity drops whichever record landed
    // last, which is the previously committed token.
    expect(store.lookupById(first.value.record.id)).toBeDefined();
    expect(store.size()).toBe(1);
    expect(store.list()[0]!.id).toBe(first.value.record.id);
  });

  it('concurrent revoke and issue both land on disk', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    if (!loaded.ok) return;
    const store = loaded.value;

    const seed = await store.issue({ role: 'admin', projects: [{ name: '*' }] });
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;

    const [revoked, issued] = await Promise.all([
      store.revoke(seed.value.record.id),
      store.issue({ role: 'writer', projects: [{ name: 'other' }] }),
    ]);
    expect(revoked.ok).toBe(true);
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const reloaded = await TokenStore.load(tmpRoot);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    // The revocation and the new token were produced by overlapping calls;
    // both must survive the round trip.
    expect(reloaded.value.lookupById(seed.value.record.id)?.revokedAt).toBeDefined();
    expect(reloaded.value.lookupById(issued.value.record.id)).toBeDefined();
    expect(reloaded.value.activeCount()).toBe(1);
  });

  it('reload during an in-flight issue does not lose the issued token', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    if (!loaded.ok) return;
    const store = loaded.value;

    // Seed so tokens.yaml exists — otherwise reload takes its file-absent
    // branch and empties the store, which is a different (louder) failure.
    const seed = await store.issue({ role: 'admin', projects: [{ name: '*' }] });
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;

    // SIGHUP lands while an issue is mid-persist. Reload replaces the same
    // indexes the issue is writing, so without serialization it re-reads the
    // still-old file and repopulates without the new record.
    const issuing = store.issue({ role: 'writer', projects: [{ name: 'p' }] });
    const reloading = store.reload();
    const [issued, reloaded] = await Promise.all([issuing, reloading]);

    expect(issued.ok).toBe(true);
    expect(reloaded.ok).toBe(true);
    if (!issued.ok) return;

    // The bearer handed to the caller must actually authenticate. This is the
    // assertion that fails when reload is unserialized: issue returns ok, but
    // the hash is missing from the index it was just evicted from.
    expect(store.lookupByHash(hashPlaintext(issued.value.plaintext))).toBeDefined();
    expect(store.lookupById(issued.value.record.id)).toBeDefined();

    // ...and it must be on disk, so a later restart still honours it.
    const fresh = await TokenStore.load(tmpRoot);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.value.lookupById(issued.value.record.id)).toBeDefined();
    expect(fresh.value.lookupById(seed.value.record.id)).toBeDefined();
  });

  it('reload during an in-flight revoke preserves the revocation', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    if (!loaded.ok) return;
    const store = loaded.value;

    const seed = await store.issue({ role: 'admin', projects: [{ name: '*' }] });
    expect(seed.ok).toBe(true);
    if (!seed.ok) return;

    // A revocation losing its race with reload is the dangerous direction:
    // the token would keep authenticating after the operator revoked it.
    const revoking = store.revoke(seed.value.record.id);
    const reloading = store.reload();
    const [revoked] = await Promise.all([revoking, reloading]);
    expect(revoked.ok).toBe(true);

    expect(store.lookupById(seed.value.record.id)?.revokedAt).toBeDefined();
    expect(store.activeCount()).toBe(0);

    const fresh = await TokenStore.load(tmpRoot);
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.value.lookupById(seed.value.record.id)?.revokedAt).toBeDefined();
  });

  it('concurrent rotate does not deadlock and revokes each predecessor', async () => {
    const loaded = await TokenStore.load(tmpRoot);
    if (!loaded.ok) return;
    const store = loaded.value;

    const seeds = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.issue({ role: 'writer', projects: [{ name: `p-${i}` }] })),
    );
    const seedIds = seeds.flatMap(s => (s.ok ? [s.value.record.id] : []));
    expect(seedIds.length).toBe(5);

    // rotate() issues internally; if it queued behind its own critical section
    // this would never settle.
    const rotated = await Promise.all(seedIds.map(id => store.rotate(id)));
    for (const r of rotated) expect(r.ok).toBe(true);

    const reloaded = await TokenStore.load(tmpRoot);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) return;
    for (const id of seedIds) {
      expect(reloaded.value.lookupById(id)?.revokedAt).toBeDefined();
    }
    expect(reloaded.value.size()).toBe(10);      // 5 superseded + 5 replacements
    expect(reloaded.value.activeCount()).toBe(5);
  });
});
