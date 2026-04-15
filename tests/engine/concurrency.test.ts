import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import {
  existsSync,
  rmSync,
  cpSync,
  writeFileSync,
  utimesSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { simpleGit } from 'simple-git';
import { MaadEngine } from '../../src/engine.js';
import { docId as toDocId, docType as toDocType, filePath as toFilePath } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');

async function makeEngine(label: string): Promise<{ engine: MaadEngine; root: string }> {
  const root = path.resolve(__dirname, `../fixtures/_temp-concurrency-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  if (existsSync(root)) rmSync(root, { recursive: true });
  cpSync(FIXTURE_SRC, root, { recursive: true });
  const backendDir = path.join(root, '_backend');
  if (existsSync(backendDir)) rmSync(backendDir, { recursive: true });

  // Fresh git repo per test
  const git = simpleGit(root);
  await git.init();
  await git.addConfig('user.email', 'test@test.com');
  await git.addConfig('user.name', 'Test');
  await git.add('.');
  await git.commit('Initial commit');

  const engine = new MaadEngine();
  const result = await engine.init(root);
  expect(result.ok).toBe(true);
  await engine.indexAll({ force: true });
  return { engine, root };
}

async function cleanup(engine: MaadEngine, root: string): Promise<void> {
  engine.close();
  await new Promise((r) => setTimeout(r, 100));
  try {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows may hold handles briefly — non-fatal
  }
}

describe('T1 — two-writer race', () => {
  let engine: MaadEngine;
  let root: string;
  beforeEach(async () => ({ engine, root } = await makeEngine('t1')));
  afterEach(async () => cleanup(engine, root));

  it('serializes two concurrent creates without corruption', async () => {
    const [r1, r2] = await Promise.all([
      engine.createDocument(toDocType('client'), { name: 'T1-A', status: 'active' }, undefined, 'cli-t1a'),
      engine.createDocument(toDocType('client'), { name: 'T1-B', status: 'active' }, undefined, 'cli-t1b'),
    ]);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    expect(existsSync(path.join(root, 'clients', 'cli-t1a.md'))).toBe(true);
    expect(existsSync(path.join(root, 'clients', 'cli-t1b.md'))).toBe(true);

    const git = simpleGit(root);
    const log = await git.log({ maxCount: 5 });
    const maadCommits = log.all.filter((c) => c.message.startsWith('maad:'));
    expect(maadCommits.length).toBe(2);

    expect(engine.writeQueueDepth()).toBe(0);
  });
});

describe('T2 — N-writer flood (FIFO ordering)', () => {
  let engine: MaadEngine;
  let root: string;
  beforeEach(async () => ({ engine, root } = await makeEngine('t2')));
  afterEach(async () => cleanup(engine, root));

  it('completes 10 concurrent creates in FIFO order with no lock residue', async () => {
    const N = 10;
    const ids = Array.from({ length: N }, (_, i) => `cli-t2-${String(i).padStart(3, '0')}`);

    // Launch all N in parallel. The mutex serializes them in the order that
    // `acquire()` is called. Since we launch via a single synchronous loop
    // each await registers before the next, giving us FIFO by index.
    let peakDepth = 0;
    const depthSampler = setInterval(() => {
      const d = engine.writeQueueDepth();
      if (d > peakDepth) peakDepth = d;
    }, 2);

    const results = await Promise.all(
      ids.map((id, i) =>
        engine.createDocument(
          toDocType('client'),
          { name: `T2-${i}`, status: 'active' },
          undefined,
          id,
        ),
      ),
    );

    clearInterval(depthSampler);

    for (const r of results) expect(r.ok).toBe(true);

    // No .git/index.lock lingering
    expect(existsSync(path.join(root, '.git', 'index.lock'))).toBe(false);

    // Peak depth should be > 1 — proves writes queued rather than being no-ops
    expect(peakDepth).toBeGreaterThan(1);

    // Verify FIFO ordering via git log (reverse chronological).
    const git = simpleGit(root);
    const log = await git.log({ maxCount: N + 2 });
    const maadCommits = log.all.filter((c) => c.message.startsWith('maad:create'));
    expect(maadCommits.length).toBe(N);

    // Walk the commits newest → oldest; docIds should be in reverse-launch order.
    const commitIds = maadCommits.map((c) => {
      const m = /cli-t2-\d{3}/.exec(c.message);
      return m ? m[0] : null;
    });
    // Newest commit is the last-launched write (id index N-1), oldest is index 0.
    const expected = [...ids].reverse();
    expect(commitIds).toEqual(expected);

    expect(engine.writeQueueDepth()).toBe(0);
  }, 15_000);
});

describe('T3 — writer + concurrent readers', () => {
  let engine: MaadEngine;
  let root: string;
  beforeEach(async () => ({ engine, root } = await makeEngine('t3')));
  afterEach(async () => cleanup(engine, root));

  it('readers never block on an in-flight writer', async () => {
    // Seed a doc so reads have targets.
    const seed = await engine.createDocument(
      toDocType('client'),
      { name: 'Seed', status: 'active' },
      undefined,
      'cli-t3-seed',
    );
    expect(seed.ok).toBe(true);

    // Start a write but don't await it yet.
    const writePromise = engine.createDocument(
      toDocType('client'),
      { name: 'T3-W', status: 'active' },
      undefined,
      'cli-t3-write',
    );

    // Fire 20 reads in parallel while the write may still be in flight.
    const readPromises = Array.from({ length: 20 }, () => engine.getDocument(toDocId('cli-t3-seed'), 'hot'));

    const start = Date.now();
    const readResults = await Promise.all(readPromises);
    const readElapsed = Date.now() - start;

    for (const r of readResults) expect(r.ok).toBe(true);

    // Reads should complete roughly instantaneously — way under a git-commit's worth of wait.
    // A write commit is typically 50-200ms; reads returning in <500ms proves they didn't queue behind it.
    expect(readElapsed).toBeLessThan(500);

    const writeResult = await writePromise;
    expect(writeResult.ok).toBe(true);

    expect(engine.writeQueueDepth()).toBe(0);
  });
});

describe('T4 — stale .git/index.lock recovery', () => {
  it('removes a stale lock (mtime > 30s) on init and records the action', async () => {
    const root = path.resolve(__dirname, `../fixtures/_temp-t4-stale-${Date.now()}`);
    if (existsSync(root)) rmSync(root, { recursive: true });
    cpSync(FIXTURE_SRC, root, { recursive: true });
    const backendDir = path.join(root, '_backend');
    if (existsSync(backendDir)) rmSync(backendDir, { recursive: true });

    const git = simpleGit(root);
    await git.init();
    await git.addConfig('user.email', 'test@test.com');
    await git.addConfig('user.name', 'Test');
    await git.add('.');
    await git.commit('Initial commit');

    // Plant a stale lock — mtime 60s ago
    const lockPath = path.join(root, '.git', 'index.lock');
    writeFileSync(lockPath, '');
    const past = new Date(Date.now() - 60_000);
    utimesSync(lockPath, past, past);

    const engine = new MaadEngine();
    const result = await engine.init(root);
    expect(result.ok).toBe(true);

    expect(existsSync(lockPath)).toBe(false);
    expect(engine.health().recoveryActions).toContain('index_lock_stale_removed');

    // A subsequent write should commit cleanly.
    const createResult = await engine.createDocument(
      toDocType('client'),
      { name: 'T4-Post', status: 'active' },
      undefined,
      'cli-t4-post',
    );
    expect(createResult.ok).toBe(true);

    await cleanup(engine, root);
  });

  it('refuses init when lock is recent (mtime < 30s) and leaves lock alone', async () => {
    const root = path.resolve(__dirname, `../fixtures/_temp-t4-recent-${Date.now()}`);
    if (existsSync(root)) rmSync(root, { recursive: true });
    cpSync(FIXTURE_SRC, root, { recursive: true });
    const backendDir = path.join(root, '_backend');
    if (existsSync(backendDir)) rmSync(backendDir, { recursive: true });

    const git = simpleGit(root);
    await git.init();
    await git.addConfig('user.email', 'test@test.com');
    await git.addConfig('user.name', 'Test');
    await git.add('.');
    await git.commit('Initial commit');

    const lockPath = path.join(root, '.git', 'index.lock');
    writeFileSync(lockPath, '');
    // mtime is "now" by default — well under 30s

    const engine = new MaadEngine();
    const result = await engine.init(root);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.errors[0]!.code).toBe('GIT_ERROR');
    expect(result.errors[0]!.details?.reason).toBe('index-lock-recent');

    // Lock untouched on disk
    expect(existsSync(lockPath)).toBe(true);

    engine.close();
    await new Promise((r) => setTimeout(r, 100));
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows — non-fatal
    }
  });
});

describe('T5 — mutex releases on error paths', () => {
  let engine: MaadEngine;
  let root: string;
  beforeEach(async () => ({ engine, root } = await makeEngine('t5')));
  afterEach(async () => cleanup(engine, root));

  it('next write succeeds after a prior write returns an error result', async () => {
    // Force an error by pointing at a missing file. The engine returns
    // { ok: false, errors: [...] } and MUST release the mutex in runExclusive's
    // finally. The separate mutex.test.ts exercises the thrown-error path.
    const bogus = toFilePath(path.join(root, 'clients', 'does-not-exist-____.md'));
    const errResult = await engine.indexFile(bogus);
    expect(errResult.ok).toBe(false);

    // Mutex released — depth back to 0.
    expect(engine.writeQueueDepth()).toBe(0);

    // A subsequent valid write completes without hanging.
    const result = await engine.createDocument(
      toDocType('client'),
      { name: 'T5-After', status: 'active' },
      undefined,
      'cli-t5-after',
    );
    expect(result.ok).toBe(true);
    expect(engine.writeQueueDepth()).toBe(0);
  });

  it('duplicate-id error also releases the mutex', async () => {
    // Create once
    const first = await engine.createDocument(
      toDocType('client'),
      { name: 'T5-Dup', status: 'active' },
      undefined,
      'cli-t5-dup',
    );
    expect(first.ok).toBe(true);

    // Try to create same id — should return DUPLICATE_DOC_ID
    const dup = await engine.createDocument(
      toDocType('client'),
      { name: 'T5-Dup', status: 'active' },
      undefined,
      'cli-t5-dup',
    );
    expect(dup.ok).toBe(false);
    expect(engine.writeQueueDepth()).toBe(0);

    // Next write proceeds.
    const next = await engine.createDocument(
      toDocType('client'),
      { name: 'T5-OK', status: 'active' },
      undefined,
      'cli-t5-ok',
    );
    expect(next.ok).toBe(true);
  });
});

describe('T6 — bulk vs single write interleave', () => {
  let engine: MaadEngine;
  let root: string;
  beforeEach(async () => ({ engine, root } = await makeEngine('t6')));
  afterEach(async () => cleanup(engine, root));

  it('bulk holds the mutex for its full duration; single write commits after', async () => {
    const bulkRecords = Array.from({ length: 10 }, (_, i) => ({
      docType: 'client',
      docId: `cli-t6-bulk-${String(i).padStart(2, '0')}`,
      fields: { name: `T6-Bulk-${i}`, status: 'active' },
    }));

    const bulkPromise = engine.bulkCreate(bulkRecords);
    const singlePromise = engine.createDocument(
      toDocType('client'),
      { name: 'T6-Single', status: 'active' },
      undefined,
      'cli-t6-single',
    );

    const [bulkResult, singleResult] = await Promise.all([bulkPromise, singlePromise]);
    expect(bulkResult.ok).toBe(true);
    expect(singleResult.ok).toBe(true);

    // Git log: bulk commit (1 commit for 10 records) followed by single commit.
    // Newest-first, so single is [0], bulk is [1].
    const git = simpleGit(root);
    const log = await git.log({ maxCount: 5 });
    const maadCommits = log.all.filter((c) => c.message.startsWith('maad:'));
    expect(maadCommits.length).toBeGreaterThanOrEqual(2);

    const [newest, second] = maadCommits;
    expect(newest!.message).toContain('cli-t6-single');
    expect(second!.message).toContain('bulk:10');

    expect(engine.writeQueueDepth()).toBe(0);
  });
});
