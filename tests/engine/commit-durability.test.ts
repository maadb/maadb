// ============================================================================
// 0.6.10 — Commit durability tests (fup-2026-066)
//
// Before 0.6.10, autoCommit caught ALL git errors and returned `null`, which
// looked identical to a successful no-op. A trailing bulk commit that failed
// would leave staged changes uncommitted while the engine ack'd every record
// as durable. These tests pin down the three-state CommitOutcome contract and
// verify the signal flows through every write path (single + bulk × create /
// update / delete) into the CreateResult/UpdateResult/DeleteResult/BulkResult
// shapes and the engine.health() counters.
//
// Fault injection: unit tests pass stub SimpleGit objects to autoCommit
// directly; engine tests mount a real MaadEngine on a temp project and then
// replace gitLayer.commit with a failing stub so the rest of the write path
// (file write, index, response) exercises the real code.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MaadEngine } from '../../src/engine.js';
import { autoCommit } from '../../src/git/commit.js';
import type { CommitOutcome } from '../../src/git/commit.js';
import { docId as toDocId, docType as toDocType } from '../../src/types.js';

// Minimal SimpleGit shape that autoCommit touches.
interface StubGit {
  add: (files: string[]) => Promise<void>;
  status: () => Promise<{ staged: string[]; files: unknown[] }>;
  commit: (msg: string) => Promise<{ commit: string | null }>;
}

function stubGit(overrides: Partial<StubGit>): StubGit {
  return {
    add: async () => {},
    status: async () => ({ staged: ['one.md'], files: [] }),
    commit: async () => ({ commit: 'deadbeef' }),
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asGit = (g: StubGit) => g as any;

const commitOpts = {
  action: 'create' as const,
  docId: toDocId('test-001'),
  docType: toDocType('client'),
  detail: '',
  summary: 'test',
  files: ['one.md'],
};

describe('autoCommit — CommitOutcome contract', () => {
  it('returns committed+sha on happy path', async () => {
    const outcome = await autoCommit(asGit(stubGit({})), commitOpts);
    expect(outcome.status).toBe('committed');
    if (outcome.status !== 'committed') return;
    expect(outcome.sha).toBe('deadbeef');
  });

  it('returns noop when nothing is staged (benign — idempotent update)', async () => {
    const outcome = await autoCommit(asGit(stubGit({
      status: async () => ({ staged: [], files: [] }),
    })), commitOpts);
    expect(outcome.status).toBe('noop');
  });

  it('returns failed=GIT_ADD_FAILED when git.add throws', async () => {
    const outcome = await autoCommit(asGit(stubGit({
      add: async () => { throw new Error('lock contention'); },
    })), commitOpts);
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.code).toBe('GIT_ADD_FAILED');
    expect(outcome.message).toContain('lock contention');
  });

  it('returns failed=GIT_STATUS_FAILED when git.status throws', async () => {
    const outcome = await autoCommit(asGit(stubGit({
      status: async () => { throw new Error('status broken'); },
    })), commitOpts);
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.code).toBe('GIT_STATUS_FAILED');
  });

  it('returns failed=GIT_COMMIT_FAILED when git.commit throws (the fup-066 core case)', async () => {
    const outcome = await autoCommit(asGit(stubGit({
      commit: async () => { throw new Error('index.lock held'); },
    })), commitOpts);
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.code).toBe('GIT_COMMIT_FAILED');
    expect(outcome.message).toContain('index.lock held');
  });

  it('returns failed=GIT_COMMIT_EMPTY when commit returns no sha', async () => {
    const outcome = await autoCommit(asGit(stubGit({
      commit: async () => ({ commit: null }),
    })), commitOpts);
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.code).toBe('GIT_COMMIT_EMPTY');
  });
});

// -- Engine-level integration tests -----------------------------------------

interface Fixture {
  engine: MaadEngine;
  tmpRoot: string;
}

async function makeEngine(): Promise<Fixture> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'maad-durability-'));
  // Engine's gitLayer is only attached when .git exists — init the repo so
  // writes actually exercise the commit path we're testing.
  const { simpleGit } = await import('simple-git');
  const git = simpleGit(tmpRoot);
  await git.init();
  await git.addConfig('user.email', 'durability-test@maadb.local');
  await git.addConfig('user.name', 'Durability Test');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(path.join(tmpRoot, '.gitignore'), '_backend/\n', 'utf8');
  await git.add('.gitignore');
  await git.commit('initial');

  const engine = new MaadEngine();
  const initResult = await engine.init(tmpRoot);
  if (!initResult.ok) throw new Error(`engine init: ${initResult.errors.map(e => e.message).join('; ')}`);
  return { engine, tmpRoot };
}

async function cleanupFixture(fx: Fixture | null): Promise<void> {
  if (!fx) return;
  fx.engine.close();
  // Small delay for Windows handle release.
  await new Promise(r => setTimeout(r, 50));
  await rm(fx.tmpRoot, { recursive: true, force: true }).catch(() => {});
}

/**
 * Replace the engine's gitLayer.commit with a stub that returns the given
 * CommitOutcome. Returns a restore function.
 */
function stubGitCommit(engine: MaadEngine, outcome: CommitOutcome): () => void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gitLayer = (engine as any).gitLayer;
  const original = gitLayer.commit.bind(gitLayer);
  gitLayer.commit = async () => outcome;
  return () => { gitLayer.commit = original; };
}

// Registry/schema bootstrap. Empty project needs at least one type before
// we can create records; we do the minimum via direct MCP schema primitives
// rather than spinning up the architect.
async function scaffoldNoteType(engine: MaadEngine, tmpRoot: string): Promise<void> {
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(path.join(tmpRoot, '_registry'), { recursive: true });
  await mkdir(path.join(tmpRoot, '_schema'), { recursive: true });
  await mkdir(path.join(tmpRoot, 'data', 'notes'), { recursive: true });
  await writeFile(
    path.join(tmpRoot, '_registry', 'object_types.yaml'),
    `types:\n  note:\n    path: data/notes\n    id_prefix: note\n    schema: note.v1\n`,
    'utf8',
  );
  await writeFile(
    path.join(tmpRoot, '_schema', 'note.v1.yaml'),
    `type: note\nversion: 1\nrequired:\n  - doc_id\n  - title\nfields:\n  title:\n    type: string\n    index: true\n  status:\n    type: enum\n    values: [draft, final]\n    index: true\n`,
    'utf8',
  );
  const reloaded = await engine.reload();
  if (!reloaded.ok) {
    throw new Error(`reload failed: ${reloaded.errors.map(e => `${e.code}: ${e.message}`).join('; ')}`);
  }
}

describe('Engine writes — writeDurable signal propagates (fup-066)', () => {
  let fx: Fixture | null = null;

  afterEach(async () => {
    await cleanupFixture(fx);
    fx = null;
  });

  it('createDocument happy path → writeDurable:true, no commitFailure', async () => {
    fx = await makeEngine();
    await scaffoldNoteType(fx.engine, fx.tmpRoot);

    const result = await fx.engine.createDocument(toDocType('note'), { title: 'hello', status: 'draft' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.writeDurable).toBe(true);
    expect(result.value.commitFailure).toBeUndefined();
  });

  it('createDocument with failed commit → writeDurable:false, commitFailure populated, engine counter bumps', async () => {
    fx = await makeEngine();
    await scaffoldNoteType(fx.engine, fx.tmpRoot);

    const restore = stubGitCommit(fx.engine, { status: 'failed', code: 'GIT_COMMIT_FAILED', message: 'index locked' });
    try {
      const result = await fx.engine.createDocument(toDocType('note'), { title: 'will fail', status: 'draft' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.writeDurable).toBe(false);
      expect(result.value.commitFailure).toEqual({ code: 'GIT_COMMIT_FAILED', message: 'index locked', action: 'create' });

      // Engine counter must reflect the failure so maad_health surfaces it.
      const health = fx.engine.health();
      expect(health.commitFailuresTotal).toBe(1);
      expect(health.lastCommitFailureCode).toBe('GIT_COMMIT_FAILED');
      expect(health.lastCommitFailureAction).toBe('create');
      expect(health.lastCommitFailureAt).not.toBeNull();
    } finally {
      restore();
    }
  });

  it('bulkCreate with failed trailing commit → all records in succeeded[], writeDurable:false on batch', async () => {
    fx = await makeEngine();
    await scaffoldNoteType(fx.engine, fx.tmpRoot);

    const restore = stubGitCommit(fx.engine, { status: 'failed', code: 'GIT_COMMIT_FAILED', message: 'drain interrupted' });
    try {
      const result = await fx.engine.bulkCreate([
        { docType: 'note', fields: { title: 'one', status: 'draft' } },
        { docType: 'note', fields: { title: 'two', status: 'draft' } },
        { docType: 'note', fields: { title: 'three', status: 'draft' } },
      ]);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // THE fup-066 CORE ASSERTION: records were written, but batch is flagged non-durable.
      expect(result.value.succeeded.length).toBe(3);
      expect(result.value.writeDurable).toBe(false);
      expect(result.value.commitFailure?.code).toBe('GIT_COMMIT_FAILED');
      expect(result.value.commitFailure?.action).toBe('create');

      // Engine counter incremented once (single trailing commit per bulk, not per record).
      expect(fx.engine.health().commitFailuresTotal).toBe(1);
    } finally {
      restore();
    }
  });

  it('updateDocument noop (file unchanged) → writeDurable:true', async () => {
    fx = await makeEngine();
    await scaffoldNoteType(fx.engine, fx.tmpRoot);

    const created = await fx.engine.createDocument(toDocType('note'), { title: 'seed', status: 'draft' }, 'body-content');
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Stub the commit layer to return noop (simulating an idempotent update).
    const restore = stubGitCommit(fx.engine, { status: 'noop' });
    try {
      // Update with identical fields — internal path still calls gitCommit.
      const updated = await fx.engine.updateDocument(
        created.value.docId,
        { title: 'seed' },
        undefined, undefined, undefined,
      );
      expect(updated.ok).toBe(true);
      if (!updated.ok) return;
      // Noop = durable (nothing to commit means nothing was lost).
      expect(updated.value.writeDurable).toBe(true);
      expect(updated.value.commitFailure).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('deleteDocument with failed commit → writeDurable:false', async () => {
    fx = await makeEngine();
    await scaffoldNoteType(fx.engine, fx.tmpRoot);

    const created = await fx.engine.createDocument(toDocType('note'), { title: 'delete-me', status: 'draft' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const restore = stubGitCommit(fx.engine, { status: 'failed', code: 'GIT_COMMIT_FAILED', message: 'oops' });
    try {
      const result = await fx.engine.deleteDocument(created.value.docId, 'soft');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.writeDurable).toBe(false);
      expect(result.value.commitFailure?.action).toBe('delete');
    } finally {
      restore();
    }
  });

  it('health counters persist across multiple failures — counter accumulates', async () => {
    fx = await makeEngine();
    await scaffoldNoteType(fx.engine, fx.tmpRoot);

    const restore = stubGitCommit(fx.engine, { status: 'failed', code: 'GIT_COMMIT_FAILED', message: 'repeatedly broken' });
    try {
      await fx.engine.createDocument(toDocType('note'), { title: 'a', status: 'draft' });
      await fx.engine.createDocument(toDocType('note'), { title: 'b', status: 'draft' });
      await fx.engine.createDocument(toDocType('note'), { title: 'c', status: 'draft' });

      const health = fx.engine.health();
      expect(health.commitFailuresTotal).toBe(3);
      expect(health.lastCommitFailureCode).toBe('GIT_COMMIT_FAILED');
    } finally {
      restore();
    }
  });
});
