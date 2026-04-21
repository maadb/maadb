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
// projects' path/role fail the whole reload with INSTANCE_MUTATION_UNSUPPORTED;
// that seam opens when the 0.9.0 eviction policy lands.
// ============================================================================

import { MaadEngine } from '../engine/index.js';
import { ensureProjectSkills } from '../skills-scaffold.js';
import { ok, singleErr, type Result } from '../errors.js';
import type { InstanceConfig, ProjectConfig } from './config.js';
import { getProject } from './config.js';

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

export class EnginePool {
  private engines = new Map<string, MaadEngine>();
  private initPromises = new Map<string, Promise<Result<MaadEngine>>>();
  private reloadInFlight = false;
  private stats: InstanceReloadStats = {
    lastReloadAt: null,
    reloadsAttempted: 0,
    reloadsSucceeded: 0,
    reloadsFailed: 0,
    projectsAdded: 0,
    projectsRemoved: 0,
  };

  constructor(private instance: InstanceConfig) {}

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
  async get(name: string): Promise<Result<MaadEngine>> {
    const cached = this.engines.get(name);
    if (cached) return ok(cached);

    const inFlight = this.initPromises.get(name);
    if (inFlight) return inFlight;

    const project = getProject(this.instance, name);
    if (!project) {
      return singleErr('PROJECT_UNKNOWN', `Project "${name}" is not declared in instance "${this.instance.name}"`);
    }

    const initPromise = this.initEngine(project);
    this.initPromises.set(name, initPromise);
    try {
      const result = await initPromise;
      if (result.ok) this.engines.set(name, result.value);
      return result;
    } finally {
      this.initPromises.delete(name);
    }
  }

  private async initEngine(project: ProjectConfig): Promise<Result<MaadEngine>> {
    const engine = new MaadEngine();
    const initResult = await engine.init(project.path);
    if (!initResult.ok) return initResult;
    ensureProjectSkills(project.path);
    return ok(engine);
  }

  // Public eviction seam. v1 never calls this internally — 0.9.0 can layer
  // LRU/TTL policy on top. Closes SQLite cleanly before removing.
  async evict(name: string): Promise<void> {
    const engine = this.engines.get(name);
    if (!engine) return;
    engine.close();
    this.engines.delete(name);
  }

  async closeAll(): Promise<void> {
    for (const [name, engine] of this.engines) {
      try {
        engine.close();
      } catch {
        // swallow — shutdown best-effort
      }
      this.engines.delete(name);
    }
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
   * Mutations (same name, different path or role) fail the whole reload with
   * INSTANCE_MUTATION_UNSUPPORTED — no partial apply. The 0.9.0 eviction
   * policy unlocks safe in-place project mutations.
   */
  async applyDiff(newInstance: InstanceConfig): Promise<Result<InstanceDiff>> {
    const oldByName = new Map(this.instance.projects.map(p => [p.name, p] as const));
    const newByName = new Map(newInstance.projects.map(p => [p.name, p] as const));

    // Detect mutations first — fail fast before touching state.
    const mutations: string[] = [];
    for (const [name, oldP] of oldByName) {
      const newP = newByName.get(name);
      if (!newP) continue; // removal, handled below
      if (oldP.path !== newP.path || oldP.role !== newP.role) {
        mutations.push(`"${name}" (${oldP.path}/${oldP.role} → ${newP.path}/${newP.role})`);
      }
    }
    if (mutations.length > 0) {
      return singleErr('INSTANCE_MUTATION_UNSUPPORTED',
        `Cannot mutate existing projects in place (path/role change). Affected: ${mutations.join(', ')}. Remove and re-add, or wait for 0.9.0 eviction policy.`);
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
