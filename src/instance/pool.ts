// ============================================================================
// EnginePool — lazy, per-project MaadEngine cache for multi-project routing
//
// First call to get(name) initializes the engine and scaffolds _skills/.
// Subsequent calls return the cached engine. evict(name) is a public seam
// for future policies (LRU/TTL) layered in 0.9.0; v1 never calls it from
// inside the pool.
//
// reloadInstance(newInstance) swaps the live instance config, applying
// project additions (lazy — just make them declarable) and removals (evict
// engines + callbacks for session cancellation). Mutations of existing
// projects' path/role/history config fail the whole reload with
// INSTANCE_MUTATION_UNSUPPORTED;
// that seam opens when the 0.9.0 eviction policy lands.
// ============================================================================

import { MaadEngine } from '../engine/index.js';
import { ensureProjectSkills, emitInstructionsAdvisory } from '../skills-scaffold.js';
import { ok, singleErr, type Result } from '../errors.js';
import type { InstanceConfig, ProjectConfig } from './config.js';
import { getProject, projectHistoryConfig } from './config.js';
import { historyOptionsEqual } from '../history/config.js';
import type { EngineInitOptions } from '../engine/types.js';

export interface InstanceDiff {
  added: string[];
  removed: string[];
}

export interface InstanceReloadStats {
  lastReloadAt: Date | null;
  reloadsAttempted: number;
  reloadsSucceeded: number;
  reloadsFailed: number;
  projectsAdded: number;
  projectsRemoved: number;
}

/**
 * 0.7.3 — Idle-timeout eviction Stage 1.
 *
 * Tracks last-touched-at + in-flight refcount per loaded engine. A background
 * sweeper closes engines that have been idle longer than the configured
 * timeout AND have zero in-flight ops. Caps memory growth in multi-tenant
 * deployments where projects are touched once and never again.
 *
 * Stage 2 (LRU + hard cap) is gated on Stage 1 evidence.
 */
export interface EvictionStats {
  evictionsTotal: number;
  lastEvictionAt: Date | null;
  lastEvictionProjects: string[];
  sweepsRun: number;
  lastSweepAt: Date | null;
}

export interface IdleSweepConfig {
  /** Idle timeout threshold in ms. 0 disables eviction (just tracks touch times). */
  idleTimeoutMs: number;
  /** Sweep interval in ms. */
  sweepIntervalMs: number;
}

export class EnginePool {
  private engines = new Map<string, MaadEngine>();
  private initPromises = new Map<string, Promise<Result<MaadEngine>>>();
  private recoveryInitPromises = new Map<string, Promise<Result<MaadEngine>>>();
  private recoveryEngines = new WeakSet<MaadEngine>();
  private recoveryByName = new Map<string, MaadEngine>();
  private reloadInFlight = false;
  private stats: InstanceReloadStats = {
    lastReloadAt: null,
    reloadsAttempted: 0,
    reloadsSucceeded: 0,
    reloadsFailed: 0,
    projectsAdded: 0,
    projectsRemoved: 0,
  };

  // 0.7.3 — Idle-timeout eviction state. lastTouchedAt is bumped on every
  // successful get(); refcount is bumped by acquire() / decremented by
  // release() so the sweeper never evicts a project with in-flight ops.
  private lastTouchedAt = new Map<string, number>();
  private refcount = new Map<string, number>();
  private sweepHandle: NodeJS.Timeout | null = null;
  private sweepConfig: IdleSweepConfig | null = null;
  private evictionStats: EvictionStats = {
    evictionsTotal: 0,
    lastEvictionAt: null,
    lastEvictionProjects: [],
    sweepsRun: 0,
    lastSweepAt: null,
  };
  private nowFn: () => number = Date.now;

  constructor(private instance: InstanceConfig, private opts: { readOnly?: boolean } = {}) {}

  /** Test seam — override the time source so sweeper logic is testable. */
  setNowFn(fn: () => number): void {
    this.nowFn = fn;
  }

  getInstance(): InstanceConfig {
    return this.instance;
  }

  listProjects(): ProjectConfig[] {
    return [...this.instance.projects];
  }

  has(name: string): boolean {
    return this.engines.has(name);
  }

  reloadStats(): InstanceReloadStats {
    return { ...this.stats };
  }

  // Returns the cached engine or initializes it. Concurrent calls for the
  // same project await the same init promise so we don't double-init.
  async get(name: string, opts: { allowEmptyIndexRecovery?: boolean } = {}): Promise<Result<MaadEngine>> {
    const cached = this.engines.get(name);
    if (cached) {
      this.lastTouchedAt.set(name, this.nowFn());
      return ok(cached);
    }

    const activeRecovery = this.recoveryByName.get(name);
    if (activeRecovery) {
      if (opts.allowEmptyIndexRecovery) return ok(activeRecovery);
      return singleErr('INDEX_EMPTY', `Project "${name}" is undergoing an index recovery and is not yet servable`);
    }

    if (opts.allowEmptyIndexRecovery) {
      if (this.opts.readOnly) {
        return singleErr('READ_ONLY', 'Read-only instance cannot rebuild an empty index');
      }
      const existingRecovery = this.recoveryInitPromises.get(name);
      if (existingRecovery) return existingRecovery;
      const project = getProject(this.instance, name);
      if (!project) {
        return singleErr('PROJECT_UNKNOWN', `Project "${name}" is not declared in instance "${this.instance.name}"`);
      }
      const promise = this.initEngine(project, false);
      this.recoveryInitPromises.set(name, promise);
      try {
        const result = await promise;
        if (result.ok) {
          this.recoveryEngines.add(result.value);
          this.recoveryByName.set(name, result.value);
        }
        return result;
      } finally {
        this.recoveryInitPromises.delete(name);
      }
    }

    const inFlight = this.initPromises.get(name);
    if (inFlight) {
      const r = await inFlight;
      if (r.ok) this.lastTouchedAt.set(name, this.nowFn());
      return r;
    }

    const project = getProject(this.instance, name);
    if (!project) {
      return singleErr('PROJECT_UNKNOWN', `Project "${name}" is not declared in instance "${this.instance.name}"`);
    }

    const initPromise = this.initEngine(project);
    this.initPromises.set(name, initPromise);
    try {
      const result = await initPromise;
      if (result.ok) {
        this.engines.set(name, result.value);
        this.lastTouchedAt.set(name, this.nowFn());
      }
      return result;
    } finally {
      this.initPromises.delete(name);
    }
  }

  /**
   * 0.7.3 — In-flight refcount. Caller increments before invoking the
   * handler, decrements in finally. The idle sweeper refuses to evict any
   * project with refcount > 0.
   */
  acquire(name: string): void {
    this.refcount.set(name, (this.refcount.get(name) ?? 0) + 1);
    this.lastTouchedAt.set(name, this.nowFn());
  }

  release(name: string): void {
    const cur = this.refcount.get(name) ?? 0;
    if (cur <= 1) {
      this.refcount.delete(name);
    } else {
      this.refcount.set(name, cur - 1);
    }
    this.lastTouchedAt.set(name, this.nowFn());
  }

  refcountFor(name: string): number {
    return this.refcount.get(name) ?? 0;
  }

  lastTouchedFor(name: string): number | null {
    return this.lastTouchedAt.get(name) ?? null;
  }

  private async initEngine(project: ProjectConfig, guardEmptyIndex = true): Promise<Result<MaadEngine>> {
    const engine = new MaadEngine();
    const historyResult = projectHistoryConfig(project);
    if (!historyResult.ok) return historyResult;
    const history = historyResult.value;
    // 0.8.4 — serving path: guard against a false-empty index (lost/unbuilt
    // derived index over existing markdown) rather than silently serving [].
    const initOptions: EngineInitOptions = {
      guardEmptyIndex,
      history,
      ...(this.opts.readOnly !== undefined || history.effectiveMode === 'read'
        ? { readOnly: this.opts.readOnly === true || history.effectiveMode === 'read' }
        : {}),
    };
    const initResult = await engine.init(project.path, initOptions);
    if (!initResult.ok) {
      await engine.close();
      return initResult;
    }
    if (this.opts.readOnly !== true && history.effectiveMode !== 'read') {
      ensureProjectSkills(project.path);
    }
    // Advisory only — bind never mutates existing instruction files.
    emitInstructionsAdvisory(project.path);
    return ok(engine);
  }

  isEmptyIndexRecoveryEngine(engine: MaadEngine): boolean {
    return this.recoveryEngines.has(engine);
  }

  async completeEmptyIndexRecovery(name: string, engine: MaadEngine, reindexSucceeded: boolean): Promise<Result<void>> {
    if (!this.recoveryEngines.has(engine)) return ok(undefined);
    this.recoveryEngines.delete(engine);
    this.recoveryByName.delete(name);
    const guard = reindexSucceeded ? await engine.validateServingIndex() : singleErr('INDEX_EMPTY', 'Recovery reindex failed; engine was not cached');
    if (!guard.ok) {
      await engine.close();
      return guard;
    }
    this.engines.set(name, engine);
    this.lastTouchedAt.set(name, this.nowFn());
    return ok(undefined);
  }

  async discardEmptyIndexRecovery(engine: MaadEngine): Promise<void> {
    if (!this.recoveryEngines.has(engine)) return;
    this.recoveryEngines.delete(engine);
    for (const [name, candidate] of this.recoveryByName) {
      if (candidate === engine) this.recoveryByName.delete(name);
    }
    await engine.close();
  }

  // Public eviction seam. 0.7.3 — also called by the idle sweeper. Closes
  // SQLite cleanly before removing. Refcount-protected callers should check
  // refcount before calling; this method is unconditional.
  async evict(name: string): Promise<void> {
    const engine = this.engines.get(name);
    if (!engine) return;
    await engine.close();
    this.engines.delete(name);
    this.lastTouchedAt.delete(name);
    this.refcount.delete(name);
  }

  /**
   * 0.7.3 — Idle eviction sweep. Returns the names of projects evicted in
   * this sweep. Skips projects with refcount > 0 (in-flight ops) and any
   * project whose lastTouchedAt is missing (defensive — would mean it's not
   * actually loaded). idleTimeoutMs=0 is a no-op (eviction disabled).
   */
  async evictIdle(idleTimeoutMs: number): Promise<string[]> {
    this.evictionStats.sweepsRun++;
    this.evictionStats.lastSweepAt = new Date(this.nowFn());
    if (idleTimeoutMs <= 0) return [];

    const now = this.nowFn();
    const candidates: string[] = [];
    for (const name of this.engines.keys()) {
      if ((this.refcount.get(name) ?? 0) > 0) continue;
      const touched = this.lastTouchedAt.get(name);
      if (touched === undefined) continue;
      if (now - touched >= idleTimeoutMs) candidates.push(name);
    }

    for (const name of candidates) await this.evict(name);

    if (candidates.length > 0) {
      this.evictionStats.evictionsTotal += candidates.length;
      this.evictionStats.lastEvictionAt = new Date(now);
      this.evictionStats.lastEvictionProjects = candidates;
    }
    return candidates;
  }

  /**
   * 0.7.3 — Start the background idle sweeper. Idempotent — calling twice
   * replaces the existing schedule. Use stopIdleSweeper() during shutdown.
   * Sweep timer is unref()'d so it never blocks process exit.
   */
  startIdleSweeper(config: IdleSweepConfig): void {
    this.stopIdleSweeper();
    this.sweepConfig = config;
    if (config.idleTimeoutMs <= 0 || config.sweepIntervalMs <= 0) return;
    this.sweepHandle = setInterval(() => {
      void this.evictIdle(config.idleTimeoutMs).catch(() => { /* sweeper is best-effort */ });
    }, config.sweepIntervalMs);
    if (typeof this.sweepHandle.unref === 'function') this.sweepHandle.unref();
  }

  stopIdleSweeper(): void {
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
    this.sweepConfig = null;
  }

  evictionStatsSnapshot(): EvictionStats {
    return { ...this.evictionStats, lastEvictionProjects: [...this.evictionStats.lastEvictionProjects] };
  }

  idleSweepConfig(): IdleSweepConfig | null {
    return this.sweepConfig ? { ...this.sweepConfig } : null;
  }

  static readIdleSweepEnv(env: NodeJS.ProcessEnv = process.env): IdleSweepConfig {
    // Default: 30 min idle timeout, 60s sweep interval. Set
    // MAAD_PROJECT_IDLE_TIMEOUT_MS=0 to disable.
    const idleRaw = env.MAAD_PROJECT_IDLE_TIMEOUT_MS;
    const sweepRaw = env.MAAD_PROJECT_SWEEP_INTERVAL_MS;
    const idle = idleRaw !== undefined ? Number.parseInt(idleRaw, 10) : 30 * 60 * 1000;
    const sweep = sweepRaw !== undefined ? Number.parseInt(sweepRaw, 10) : 60 * 1000;
    return {
      idleTimeoutMs: Number.isFinite(idle) && idle >= 0 ? idle : 30 * 60 * 1000,
      sweepIntervalMs: Number.isFinite(sweep) && sweep > 0 ? sweep : 60 * 1000,
    };
  }

  async closeAll(): Promise<void> {
    this.stopIdleSweeper();
    for (const [name, engine] of this.engines) {
      try {
        await engine.close();
      } catch {
        // swallow — shutdown best-effort
      }
      this.engines.delete(name);
    }
    this.lastTouchedAt.clear();
    this.refcount.clear();
  }

  /**
   * Sum of `writeQueueDepth()` across every initialized engine. Used by the
   * shutdown drain loop to know when it's safe to exit. Uninitialized engines
   * contribute 0 and are not lazy-initialized.
   */
  totalWriteQueueDepth(): number {
    let total = 0;
    for (const engine of this.engines.values()) {
      total += engine.writeQueueDepth();
    }
    return total;
  }

  /**
   * Atomic reload slot — acquired before any I/O (config parse), released
   * after diff + stats are recorded. The orchestrator in
   * `src/mcp/instance-reload.ts` holds this for the lifetime of the reload
   * so concurrent callers fail fast with INSTANCE_RELOAD_IN_PROGRESS instead
   * of racing to swap the instance ref.
   *
   * Returns false if a reload is already in progress or the instance is
   * synthetic (tested separately so the error code can be distinguished).
   */
  tryBeginReload(): { ok: true } | { ok: false; code: 'INSTANCE_RELOAD_SYNTHETIC' | 'INSTANCE_RELOAD_IN_PROGRESS' } {
    if (this.instance.source === 'synthetic') {
      return { ok: false, code: 'INSTANCE_RELOAD_SYNTHETIC' };
    }
    if (this.reloadInFlight) {
      return { ok: false, code: 'INSTANCE_RELOAD_IN_PROGRESS' };
    }
    this.reloadInFlight = true;
    this.stats.reloadsAttempted++;
    return { ok: true };
  }

  /**
   * Release the reload slot. Called by the orchestrator in a `finally` so
   * success + failure paths both land here. Updates the success/failure
   * counters + project-diff stats.
   */
  endReload(outcome: { ok: true; diff: InstanceDiff } | { ok: false }): void {
    if (outcome.ok) {
      this.stats.reloadsSucceeded++;
      this.stats.lastReloadAt = new Date();
      this.stats.projectsAdded += outcome.diff.added.length;
      this.stats.projectsRemoved += outcome.diff.removed.length;
    } else {
      this.stats.reloadsFailed++;
    }
    this.reloadInFlight = false;
  }

  /**
   * Apply a parsed instance config: detect mutations (fail-fast, no partial),
   * evict engines for removed projects, swap the internal instance ref.
   * Must be called between `tryBeginReload` and `endReload` — does not manage
   * the reload slot itself.
   *
   * Mutations (same name, different path, role, effective history mode, or
   * history thresholds) fail the whole reload with
   * INSTANCE_MUTATION_UNSUPPORTED — no partial apply.
   */
  async applyDiff(newInstance: InstanceConfig): Promise<Result<InstanceDiff>> {
    const oldByName = new Map(this.instance.projects.map(p => [p.name, p] as const));
    const newByName = new Map(newInstance.projects.map(p => [p.name, p] as const));

    // Detect mutations first — fail fast before touching state.
    const mutations: string[] = [];
    for (const [name, oldP] of oldByName) {
      const newP = newByName.get(name);
      if (!newP) continue; // removal, handled below
      const oldHistory = projectHistoryConfig(oldP);
      const newHistory = projectHistoryConfig(newP);
      if (!oldHistory.ok) return oldHistory;
      if (!newHistory.ok) return newHistory;
      const historyChanged = oldHistory.value.effectiveMode !== newHistory.value.effectiveMode
        || !historyOptionsEqual(oldHistory.value.options, newHistory.value.options);
      if (oldP.path !== newP.path || oldP.role !== newP.role || historyChanged) {
        mutations.push(`"${name}" (${oldP.path}/${oldP.role} → ${newP.path}/${newP.role})`);
      }
    }
    if (mutations.length > 0) {
      return singleErr('INSTANCE_MUTATION_UNSUPPORTED',
        `Cannot mutate existing projects in place (path, role, or history configuration change). Affected: ${mutations.join(', ')}. Remove and re-add the project to apply the change.`);
    }

    const added: string[] = [];
    const removed: string[] = [];
    for (const name of newByName.keys()) {
      if (!oldByName.has(name)) added.push(name);
    }
    for (const name of oldByName.keys()) {
      if (!newByName.has(name)) removed.push(name);
    }

    // Evict removed engines. Do this BEFORE swapping the instance ref so
    // getProject() during evict still sees the old config (not strictly
    // required — evict only uses `name` — but preserves invariant).
    for (const name of removed) {
      await this.evict(name);
    }

    // Atomic swap: instance ref + downstream refs (caller's responsibility
    // to propagate to SessionRegistry + InstanceCtx).
    this.instance = newInstance;

    return ok({ added, removed });
  }

  /**
   * Swap the instance config without diff/eviction. Used by the reload
   * orchestrator if it needs to keep downstream refs in sync, or by tests.
   */
  setInstance(newInstance: InstanceConfig): void {
    this.instance = newInstance;
  }
}
