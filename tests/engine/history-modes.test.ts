import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import { MaadEngine } from '../../src/engine.js';
import { resolveHistoryConfig } from '../../src/history/config.js';
import type { HistoryMode, HistoryOptions, ResolvedHistoryConfig } from '../../src/history/types.js';
import { validateInstance, type InstanceConfig, type ProjectConfig } from '../../src/instance/config.js';
import { EnginePool } from '../../src/instance/pool.js';
import { SessionRegistry } from '../../src/instance/session.js';
import type { InstanceCtx } from '../../src/mcp/ctx.js';
import { getKindForTool } from '../../src/mcp/kinds.js';
import * as historyModeTools from '../../src/mcp/tools/history-mode.js';
import { cmdFlush } from '../../src/cli/commands/history-mode.js';
import { docId, docType } from '../../src/types.js';

const roots: string[] = [];
const engines = new Set<MaadEngine>();
let originalHistoryDefault: string | undefined;

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'maad-history-modes-'));
  roots.push(root);
  return root;
}

function scaffoldProject(root: string): void {
  mkdirSync(path.join(root, '_registry'), { recursive: true });
  mkdirSync(path.join(root, '_schema'), { recursive: true });
  mkdirSync(path.join(root, 'data', 'notes'), { recursive: true });
  writeFileSync(
    path.join(root, '_registry', 'object_types.yaml'),
    'types:\n  note:\n    path: data/notes\n    id_prefix: note\n    schema: note.v1\n',
    'utf8',
  );
  writeFileSync(
    path.join(root, '_schema', 'note.v1.yaml'),
    [
      'type: note',
      'version: 1',
      'required:',
      '  - doc_id',
      '  - title',
      'fields:',
      '  title:',
      '    type: string',
      '    index: true',
      '  status:',
      '    type: enum',
      '    values: [draft, final]',
      '    index: true',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(path.join(root, '.gitignore'), '_backend/\n', 'utf8');
}

async function initGit(root: string): Promise<SimpleGit> {
  const git = simpleGit(root);
  await git.init();
  await git.addConfig('user.email', 'noreply@example.invalid');
  await git.addConfig('user.name', 'History Mode Test');
  await git.add('.');
  await git.commit('fixture: initial state');
  return git;
}

function config(mode: HistoryMode, options: HistoryOptions = {}): ResolvedHistoryConfig {
  return {
    effectiveMode: mode,
    configuredMode: mode,
    modeSource: 'project',
    options,
    advisories: [],
  };
}

async function openEngine(
  root: string,
  mode: HistoryMode,
  options: HistoryOptions = {},
): Promise<MaadEngine> {
  const engine = new MaadEngine();
  const initialized = await engine.init(root, { history: config(mode, options) });
  expect(initialized.ok, JSON.stringify(initialized)).toBe(true);
  engines.add(engine);
  return engine;
}

async function createNote(engine: MaadEngine, id: string, title = id): Promise<void> {
  const created = await engine.createDocument(
    docType('note'),
    { title, status: 'draft' },
    `Body for ${id}`,
    id,
  );
  expect(created.ok, JSON.stringify(created)).toBe(true);
}

async function commitCount(git: SimpleGit): Promise<number> {
  return (await git.log()).total;
}

async function eventually(check: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  expect(await check()).toBe(true);
}

function fileSnapshot(root: string): Record<string, { bytes: string; mtimeMs: number }> {
  const snapshot: Record<string, { bytes: string; mtimeMs: number }> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else {
        const relative = path.relative(root, absolute).replace(/\\/g, '/');
        snapshot[relative] = {
          bytes: readFileSync(absolute).toString('base64'),
          mtimeMs: statSync(absolute).mtimeMs,
        };
      }
    }
  };
  walk(root);
  return snapshot;
}

function project(root: string, mode: HistoryMode, options: HistoryOptions = {}): ProjectConfig {
  return {
    name: 'alpha',
    path: root,
    role: 'admin',
    historyMode: mode,
    configuredHistoryMode: mode,
    historyModeSource: 'project',
    historyOptions: options,
    historyAdvisories: [],
  };
}

function instance(projectConfig: ProjectConfig): InstanceConfig {
  return { name: 'test-instance', source: 'file', projects: [projectConfig] };
}

function journalEntries(root: string): unknown[] {
  const journalPath = path.join(root, '_backend', 'journal.json');
  return existsSync(journalPath)
    ? JSON.parse(readFileSync(journalPath, 'utf8')) as unknown[]
    : [];
}

beforeEach(() => {
  originalHistoryDefault = process.env.MAAD_HISTORY_MODE_DEFAULT;
  delete process.env.MAAD_HISTORY_MODE_DEFAULT;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalHistoryDefault === undefined) delete process.env.MAAD_HISTORY_MODE_DEFAULT;
  else process.env.MAAD_HISTORY_MODE_DEFAULT = originalHistoryDefault;

  for (const engine of engines) {
    try { await engine.close(); } catch { /* cleanup is best-effort */ }
  }
  engines.clear();
  while (roots.length > 0) {
    const root = roots.pop()!;
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Windows can briefly retain Git or SQLite handles after a failed assertion.
    }
  }
});

describe('history mode configuration', () => {
  it.each<HistoryMode>(['audit', 'feed', 'read', 'batch', 'snapshot'])(
    'parses project history_mode %s',
    mode => {
      const root = makeRoot();
      if (mode === 'audit' || mode === 'batch' || mode === 'snapshot') {
        mkdirSync(path.join(root, '.git'));
      }
      const result = resolveHistoryConfig({ history_mode: mode }, root, {});
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        effectiveMode: mode,
        configuredMode: mode,
        modeSource: 'project',
        advisories: [],
      });
    },
  );

  it('applies project, environment, then compatibility inference precedence', () => {
    const root = makeRoot();
    mkdirSync(path.join(root, '.git'));

    const projectWins = resolveHistoryConfig(
      { history_mode: 'feed' },
      root,
      { MAAD_HISTORY_MODE_DEFAULT: 'read' },
    );
    expect(projectWins.ok && projectWins.value.effectiveMode).toBe('feed');
    expect(projectWins.ok && projectWins.value.modeSource).toBe('project');

    const environmentWins = resolveHistoryConfig({}, root, { MAAD_HISTORY_MODE_DEFAULT: 'read' });
    expect(environmentWins.ok && environmentWins.value.effectiveMode).toBe('read');
    expect(environmentWins.ok && environmentWins.value.configuredMode).toBeNull();
    expect(environmentWins.ok && environmentWins.value.modeSource).toBe('environment');

    const inferred = resolveHistoryConfig({}, root, {});
    expect(inferred.ok && inferred.value.effectiveMode).toBe('audit');
    expect(inferred.ok && inferred.value.modeSource).toBe('inferred');
    expect(inferred.ok && inferred.value.advisories).toHaveLength(1);
    expect(inferred.ok && inferred.value.advisories[0]?.code).toBe('HISTORY_MODE_INFERRED');
  });

  it('infers feed without Git and emits exactly one migration advisory', () => {
    const result = resolveHistoryConfig({}, makeRoot(), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.effectiveMode).toBe('feed');
    expect(result.value.modeSource).toBe('inferred');
    expect(result.value.advisories).toHaveLength(1);
  });

  it.each<HistoryMode>(['audit', 'batch', 'snapshot'])(
    'rejects explicit %s without Git',
    mode => {
      const result = resolveHistoryConfig({ history_mode: mode }, makeRoot(), {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors[0]?.code).toBe('GIT_NOT_INITIALIZED');
      expect(result.errors[0]?.details).toMatchObject({ historyMode: mode, modeSource: 'project' });
    },
  );

  it('rejects unknown modes and non-positive batch thresholds', () => {
    const root = makeRoot();
    const invalidMode = resolveHistoryConfig({ history_mode: 'archive' }, root, {});
    expect(invalidMode.ok).toBe(false);
    if (!invalidMode.ok) expect(invalidMode.errors[0]?.code).toBe('INSTANCE_CONFIG_INVALID');

    for (const history_options of [
      { max_writes: 0 },
      { max_writes: -1 },
      { max_delay_ms: 1.5 },
      { max_delay_ms: '10' },
      { extra: 1 },
    ]) {
      const result = resolveHistoryConfig({ history_mode: 'feed', history_options }, root, {});
      expect(result.ok, JSON.stringify(history_options)).toBe(false);
      if (!result.ok) expect(result.errors[0]?.code).toBe('INSTANCE_CONFIG_INVALID');
    }
  });

  it('loads history fields from instance YAML data with environment precedence intact', () => {
    const root = makeRoot();
    const result = validateInstance({
      name: 'acceptance',
      projects: [{
        name: 'alpha',
        path: root,
        history_mode: 'feed',
        history_options: { max_writes: 7, max_delay_ms: 250 },
      }],
    }, path.join(root, 'instance.yaml'), { MAAD_HISTORY_MODE_DEFAULT: 'read' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projects[0]).toMatchObject({
      historyMode: 'feed',
      configuredHistoryMode: 'feed',
      historyModeSource: 'project',
      historyOptions: { max_writes: 7, max_delay_ms: 250 },
    });
  });
});

describe('audit, feed, and read behavior', () => {
  it('audit creates one Git commit for every logical mutation', async () => {
    const root = makeRoot();
    scaffoldProject(root);
    const git = await initGit(root);
    const engine = await openEngine(root, 'audit');
    const initial = await commitCount(git);

    await createNote(engine, 'note-audit');
    expect(await commitCount(git)).toBe(initial + 1);

    const updated = await engine.updateDocument(docId('note-audit'), { status: 'final' });
    expect(updated.ok, JSON.stringify(updated)).toBe(true);
    expect(await commitCount(git)).toBe(initial + 2);

    const removed = await engine.deleteDocument(docId('note-audit'), 'soft');
    expect(removed.ok, JSON.stringify(removed)).toBe(true);
    expect(await commitCount(git)).toBe(initial + 3);
    expect(journalEntries(root)).toEqual([]);
  });

  it('feed performs durable file and index work without staging or committing Git', async () => {
    const root = makeRoot();
    scaffoldProject(root);
    const git = await initGit(root);
    const engine = await openEngine(root, 'feed');
    const initialHead = await git.revparse(['HEAD']);
    const initialIndexMtime = statSync(path.join(root, '.git', 'index'), { bigint: true }).mtimeNs;

    await createNote(engine, 'note-feed');
    const found = await engine.getDocument(docId('note-feed'), 'hot');
    expect(found.ok).toBe(true);
    expect(existsSync(path.join(root, 'data', 'notes', 'note-feed.md'))).toBe(true);
    expect(await git.revparse(['HEAD'])).toBe(initialHead);
    expect(statSync(path.join(root, '.git', 'index'), { bigint: true }).mtimeNs).toBe(initialIndexMtime);
    expect((await git.status()).staged).toEqual([]);
    expect(journalEntries(root)).toEqual([]);
  });

  it.each<HistoryMode>(['feed', 'read'])(
    '%s returns HISTORY_DISABLED for Git history without a repository',
    async mode => {
      const root = makeRoot();
      scaffoldProject(root);
      const writer = await openEngine(root, 'feed');
      await createNote(writer, 'note-history-disabled');
      await writer.close();
      engines.delete(writer);

      const engine = await openEngine(root, mode);
      const result = await engine.history(docId('note-history-disabled'));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[0]?.code).toBe('HISTORY_DISABLED');
        expect(result.errors[0]?.details).toMatchObject({ historyMode: mode });
      }
    },
  );

  it('read reuses the zero-write engine path and reports PROJECT_READ_ONLY mutations', async () => {
    const root = makeRoot();
    scaffoldProject(root);
    const writer = await openEngine(root, 'feed');
    await createNote(writer, 'note-readable');
    await writer.close();
    engines.delete(writer);
    const before = fileSnapshot(root);

    const reader = await openEngine(root, 'read');
    expect(reader.health().readOnly).toBe(true);
    expect((await reader.getDocument(docId('note-readable'), 'hot')).ok).toBe(true);
    expect(reader.summary().totalDocuments).toBe(1);

    const create = await reader.createDocument(docType('note'), { title: 'blocked' });
    const reindex = await reader.indexAll({ force: true });
    const backup = await reader.backupCreate();
    expect(create.ok).toBe(false);
    if (!create.ok) expect(create.errors[0]?.code).toBe('PROJECT_READ_ONLY');
    expect('ok' in reindex && reindex.ok).toBe(false);
    if ('ok' in reindex && !reindex.ok) expect(reindex.errors[0]?.code).toBe('PROJECT_READ_ONLY');
    expect(backup.ok).toBe(false);
    if (!backup.ok) expect(backup.errors[0]?.code).toBe('PROJECT_READ_ONLY');

    await reader.close();
    engines.delete(reader);
    expect(fileSnapshot(root)).toEqual(before);
  });
});

describe('batch boundaries and recovery', () => {
  it('flushes once at max_writes and clears the pending timer', async () => {
    const root = makeRoot();
    scaffoldProject(root);
    const git = await initGit(root);
    const engine = await openEngine(root, 'batch', { max_writes: 2, max_delay_ms: 10_000 });
    const initial = await commitCount(git);

    await createNote(engine, 'note-count-a');
    expect(engine.health().history.pendingWrites).toBe(1);
    expect(await commitCount(git)).toBe(initial);

    await createNote(engine, 'note-count-b');
    expect(engine.health().history.pendingWrites).toBe(0);
    expect(await commitCount(git)).toBe(initial + 1);
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(await commitCount(git)).toBe(initial + 1);
  });

  it('flushes pending writes after max_delay_ms', async () => {
    const root = makeRoot();
    scaffoldProject(root);
    const git = await initGit(root);
    const engine = await openEngine(root, 'batch', { max_delay_ms: 40 });
    const initial = await commitCount(git);

    await createNote(engine, 'note-timer');
    expect(engine.health().history.pendingWrites).toBe(1);
    await eventually(async () =>
      await commitCount(git) === initial + 1
      && engine.health().history.pendingWrites === 0,
    );
    expect(engine.health().history.pendingWrites).toBe(0);
  });

  it('flushes through the explicit MCP boundary with a stable response contract', async () => {
    const root = makeRoot();
    scaffoldProject(root);
    await initGit(root);
    const engine = await openEngine(root, 'batch');
    await createNote(engine, 'note-explicit');

    const result = await historyModeTools.flushHistoryBoundary(engine);
    expect(result).toMatchObject({
      ok: true,
      value: {
        effectiveMode: 'batch',
        trigger: 'explicit',
        status: 'committed',
        pendingWrites: 0,
        flushed: true,
      },
    });
    if (result.ok) expect(result.value.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('flushes pending writes during normal shutdown', async () => {
    const root = makeRoot();
    scaffoldProject(root);
    const git = await initGit(root);
    const engine = await openEngine(root, 'batch');
    const initial = await commitCount(git);
    await createNote(engine, 'note-shutdown');

    await engine.close();
    engines.delete(engine);
    expect(await commitCount(git)).toBe(initial + 1);
  });

  it('bounds shutdown when Git does not return', async () => {
    const root = makeRoot();
    scaffoldProject(root);
    await initGit(root);
    const engine = await openEngine(root, 'batch');
    await createNote(engine, 'note-bounded-shutdown');
    const layer = engine.getGitLayer();
    expect(layer).not.toBeNull();
    vi.spyOn(layer!, 'commit').mockImplementation(() => new Promise(() => {}));
    const internals = engine as unknown as {
      historyRuntime: { health(): ReturnType<MaadEngine['health']>['history'] };
    };
    const history = internals.historyRuntime;

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const closing = engine.close();
    await vi.advanceTimersByTimeAsync(5_000);
    await closing;
    engines.delete(engine);
    expect(history.health().lastFlushError).toMatchObject({
      code: 'HISTORY_FLUSH_TIMEOUT',
      trigger: 'shutdown',
    });
  });

  it('recovers indexed pending journal entries on restart', async () => {
    const root = makeRoot();
    scaffoldProject(root);
    const git = await initGit(root);
    const first = await openEngine(root, 'batch');
    const initial = await commitCount(git);
    await createNote(first, 'note-restart');
    expect(first.health().history.pendingWrites).toBe(1);
    expect(journalEntries(root)).toHaveLength(1);

    // Simulate abrupt process loss: release SQLite without running the history
    // close boundary. The persisted indexed journal entry is the recovery input.
    first.getBackend().close();
    const crashed = first as unknown as { initialized: boolean; historyRuntime: null };
    crashed.initialized = false;
    crashed.historyRuntime = null;
    engines.delete(first);

    const restarted = await openEngine(root, 'batch');
    expect(restarted.getStartupRecovery()).toContain('history_recovery_completed:batch');
    expect(restarted.health().history.pendingWrites).toBe(0);
    expect(journalEntries(root)).toEqual([]);
    expect(await commitCount(git)).toBe(initial + 1);
  });

  it('preserves journal evidence after Git failure and clears it after retry', async () => {
    const root = makeRoot();
    scaffoldProject(root);
    await initGit(root);
    const engine = await openEngine(root, 'batch', { max_writes: 1 });
    const layer = engine.getGitLayer();
    expect(layer).not.toBeNull();
    const failure = vi.spyOn(layer!, 'commit').mockResolvedValueOnce({
      status: 'failed',
      code: 'GIT_COMMIT_FAILED',
      message: 'simulated index contention',
    });

    await createNote(engine, 'note-retry');
    expect(engine.health().history.pendingWrites).toBe(1);
    expect(engine.health().history.lastFlushError).toMatchObject({
      code: 'GIT_COMMIT_FAILED',
      trigger: 'threshold',
    });
    expect(journalEntries(root)).toHaveLength(1);

    failure.mockRestore();
    const retried = await engine.flushHistory('explicit');
    expect(retried.outcome.status).toBe('committed');
    expect(engine.health().history.pendingWrites).toBe(0);
    expect(engine.health().history.lastFlushError).toBeNull();
    expect(journalEntries(root)).toEqual([]);
  });

  it('serializes concurrent threshold, timer, and explicit flush requests', async () => {
    const root = makeRoot();
    scaffoldProject(root);
    await initGit(root);
    const engine = await openEngine(root, 'batch');
    await createNote(engine, 'note-serialized-a');
    await createNote(engine, 'note-serialized-b');
    const layer = engine.getGitLayer();
    expect(layer).not.toBeNull();
    const originalCommit = layer!.commit.bind(layer);
    let active = 0;
    let maximumActive = 0;
    const commitSpy = vi.spyOn(layer!, 'commit').mockImplementation(async options => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 30));
      try { return await originalCommit(options); }
      finally { active -= 1; }
    });

    const results = await Promise.all([
      engine.flushHistory('threshold'),
      engine.flushHistory('timer'),
      engine.flushHistory('explicit'),
    ]);
    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(maximumActive).toBe(1);
    expect(results.filter(result => result.outcome.status === 'committed')).toHaveLength(1);
    expect(engine.health().history.pendingWrites).toBe(0);
  });
});

describe('snapshot mode', () => {
  it('creates an annotated snapshot tag only after the pending commit succeeds', async () => {
    const root = makeRoot();
    scaffoldProject(root);
    const git = await initGit(root);
    const engine = await openEngine(root, 'snapshot');
    await createNote(engine, 'note-snapshot');

    const flushed = await engine.flushHistory('explicit');
    expect(flushed.outcome.status).toBe('committed');
    if (flushed.outcome.status !== 'committed') return;
    const tags = (await git.tags()).all.filter(tag => tag.startsWith('maad-snapshot-'));
    expect(tags).toHaveLength(1);
    const tag = tags[0]!;
    const target = await git.revparse([`${tag}^{commit}`]);
    expect(target).toBe(flushed.outcome.sha);
    expect(await git.show([`${tag}:data/notes/note-snapshot.md`])).toContain('note-snapshot');
  });

  it('retries a failed tag without creating a second commit', async () => {
    const root = makeRoot();
    scaffoldProject(root);
    const git = await initGit(root);
    const engine = await openEngine(root, 'snapshot');
    await createNote(engine, 'note-tag-retry');
    const layer = engine.getGitLayer();
    expect(layer).not.toBeNull();
    const tagFailure = vi.spyOn(layer!, 'addAnnotatedTag').mockRejectedValueOnce(new Error('simulated tag failure'));

    const failed = await engine.flushHistory('explicit');
    expect(failed.outcome).toMatchObject({ status: 'failed', code: 'GIT_TAG_FAILED' });
    expect(engine.health().history.pendingWrites).toBe(1);
    const commitsAfterFailure = await commitCount(git);
    const evidence = journalEntries(root) as Array<{ gitBoundarySha?: string; snapshotTag?: string }>;
    expect(evidence[0]?.gitBoundarySha).toMatch(/^[0-9a-f]{40}$/);
    expect(evidence[0]?.snapshotTag).toMatch(/^maad-snapshot-/);

    tagFailure.mockRestore();
    const recovered = await engine.flushHistory('recovery');
    expect(recovered.outcome.status).toBe('committed');
    expect(await commitCount(git)).toBe(commitsAfterFailure);
    expect(engine.health().history.pendingWrites).toBe(0);
    expect(journalEntries(root)).toEqual([]);
  });
});

describe('reload, health, MCP, and CLI contracts', () => {
  it('rejects an existing-project history mode or threshold change during reload', async () => {
    const root = makeRoot();
    const pool = new EnginePool(instance(project(root, 'feed', { max_writes: 2 })));
    for (const replacement of [
      project(root, 'read', { max_writes: 2 }),
      project(root, 'feed', { max_writes: 3 }),
    ]) {
      const result = await pool.applyDiff(instance(replacement));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors[0]?.code).toBe('INSTANCE_MUTATION_UNSUPPORTED');
    }
    await pool.closeAll();
  });

  it('health exposes effective/configured/source/pending/success/error without dropping legacy fields', async () => {
    const root = makeRoot();
    scaffoldProject(root);
    await initGit(root);
    const engine = await openEngine(root, 'batch');
    await createNote(engine, 'note-health');
    const before = engine.health();
    expect(before).toMatchObject({
      initialized: true,
      gitAvailable: true,
      registeredTypes: 1,
      history: {
        effectiveMode: 'batch',
        configuredMode: 'batch',
        modeSource: 'project',
        pendingWrites: 1,
        lastSuccessfulFlush: null,
        lastFlushError: null,
        advisories: [],
      },
    });

    await engine.flushHistory('explicit');
    const after = engine.health().history;
    expect(after.pendingWrites).toBe(0);
    expect(after.lastSuccessfulFlush).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(after.lastFlushError).toBeNull();
  });

  it('registers maad_flush as a write tool with an empty-input schema', () => {
    const server = new McpServer({ name: 'probe', version: '0.0.0' });
    let registeredName: string | undefined;
    let registeredConfig: unknown;
    (server as unknown as {
      registerTool(name: string, toolConfig: unknown, handler: unknown): unknown;
    }).registerTool = (name, toolConfig) => {
      registeredName = name;
      registeredConfig = toolConfig;
      return undefined;
    };
    const emptyInstance: InstanceConfig = { name: 'probe', source: 'synthetic', projects: [] };
    const ctx: InstanceCtx = {
      instance: emptyInstance,
      pool: new EnginePool(emptyInstance),
      sessions: new SessionRegistry(emptyInstance),
      tokens: null,
    };

    expect(historyModeTools.register(server, ctx)).toBe(1);
    expect(registeredName).toBe('maad_flush');
    expect(getKindForTool('maad_flush')).toBe('write');
    const schema = (registeredConfig as {
      inputSchema: { parse(value: unknown): Record<string, unknown> };
    }).inputSchema;
    expect(schema.parse({})).toEqual({});
    expect(schema.parse({ project: 'alpha' })).toEqual({ project: 'alpha' });
  });

  it('returns explicit no-op boundaries in non-flushing modes', async () => {
    for (const mode of ['feed', 'read'] as const) {
      const root = makeRoot();
      scaffoldProject(root);
      if (mode === 'read') {
        const writer = await openEngine(root, 'feed');
        await writer.close();
        engines.delete(writer);
      }
      const engine = await openEngine(root, mode);
      expect(await historyModeTools.flushHistoryBoundary(engine)).toEqual({
        ok: true,
        value: {
          effectiveMode: mode,
          trigger: 'explicit',
          status: 'noop',
          pendingWrites: 0,
          flushed: false,
        },
      });
      await engine.close();
      engines.delete(engine);
    }
  });

  it('prints the CLI flush contract for an inferred feed project', async () => {
    const root = makeRoot();
    scaffoldProject(root);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await cmdFlush({ args: ['flush'], projectRoot: root, __dirname });
    expect(error).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    const output = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(output).toEqual({
      effectiveMode: 'feed',
      trigger: 'explicit',
      status: 'noop',
      pendingWrites: 0,
      flushed: false,
    });
  });
});
