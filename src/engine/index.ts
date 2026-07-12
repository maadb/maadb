// ============================================================================
// MAAD Engine — Thin facade over domain modules
// Holds state, delegates to domain functions via EngineContext.
// ============================================================================

import { existsSync, mkdirSync, writeFileSync, statSync, readdirSync, statfsSync } from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

import { ok, singleErr, type Result } from '../errors.js';
import { AsyncFifoMutex } from './mutex.js';

// Reentrancy marker — present in ALS scope when runExclusive is already
// holding the write lock on `this` engine. Engine mutation methods keep
// their internal runExclusive wrappers so direct callers (CLI, tests)
// stay serialized; MCP boundary callers (withEngine's write branch) also
// call runExclusive. The inner acquire sees the outer's ALS marker and
// no-ops to avoid a non-reentrant deadlock.
const writeScope = new AsyncLocalStorage<MaadEngine>();
import { logger } from './logger.js';
import type {
  DocId,
  DocType,
  FilePath,
  Registry,
  SchemaStore,
  SchemaDefinition,
  ExtractionResult,
} from '../types.js';
import { loadRegistry } from '../registry/index.js';
import { loadSchemas } from '../schema/index.js';
import { logSchemaCacheStale } from '../logging.js';
import { collectMarkdownFiles } from './helpers.js';
import { SqliteBackend } from '../backend/index.js';
import type { MaadBackend } from '../backend/index.js';
import { GitLayer } from '../git/index.js';
import type { EngineContext, CommitFailureTracker } from './context.js';
import { newCommitFailureTracker } from './context.js';
import { OperationJournal } from './journal.js';
import { isSemanticEnabled, readSemanticEnv } from './semantic/config.js';
import { resolveEmbeddingProvider } from './semantic/provider.js';
import { SemanticIndexer } from './semantic/indexer.js';
import type { EmbeddingProvider } from './semantic/types.js';

// Domain modules
import * as indexing from './indexing.js';
import * as reads from './reads.js';
import * as composites from './composites.js';
import * as writes from './writes.js';
import * as backup from './backup.js';
import * as maintenance from './maintenance.js';
import * as repairs from './repairs.js';
import * as auditOps from './audit.js';
import * as semanticSearchOps from './semantic/search.js';

// Re-export all result types
export type {
  IndexResult,
  CreateResult,
  GetResult,
  UpdateResult,
  DeleteResult,
  FindResult,
  SearchResult,
  RelatedResult,
  DescribeResult,
  SummaryResult,
  GetFullResult,
  SchemaInfoResult,
  ValidationReport,
  VerifyResult,
} from './types.js';
export type {
  SemanticSearchQuery,
  SemanticSearchResult,
  SemanticHit,
  SearchMode,
} from './semantic/types.js';

export interface HealthReport {
  projectRoot: string;
  initialized: boolean;
  readOnly: boolean;
  gitAvailable: boolean;
  indexExists: boolean;
  lastIndexedAt: string | null;
  totalDocuments: number;
  registeredTypes: number;
  recoveryActions: string[];
  emptyProject: boolean;
  bootstrapHint: string | null;
  writeQueueDepth: number;
  lastWriteOp: {
    op: string;
    startedAt: string;
    elapsedMs: number;
  } | null;
  // 0.4.1 H8 extensions
  lastWriteAt: string | null;      // ISO timestamp of last successful mutating op
  repoSizeBytes: number | null;    // .git directory size on disk; null if git unavailable
  gitClean: boolean | null;        // working-tree clean? null if git unavailable
  diskHeadroomMb: number | null;   // free space on the volume holding projectRoot
  // 0.6.10 — commit durability counters. Bumped in `gitCommit` when a
  // trailing commit after a write fails (staged files left uncommitted).
  // Operators watching for fup-066-style drift filter on
  // `commitFailuresTotal > 0` or grep for `commit_failed` ops events.
  commitFailuresTotal: number;
  lastCommitFailureAt: string | null;
  lastCommitFailureCode: string | null;
  lastCommitFailureAction: 'create' | 'update' | 'delete' | null;
  lastCommitFailureDocId: string | null;
  // 0.7.10 — Integrity & Cleanup observability. Populated from engine_meta
  // by the verifyIntegrity (P2) and backupCreate (P4) write hooks. Null
  // when the corresponding op has never been run against this backend, or
  // when the stored JSON failed to parse (in which case the stale value
  // is dropped rather than surfaced corrupt).
  lastIntegritySweepAt: string | null;
  lastIntegrityFindings: Record<import('./types.js').IntegrityCategory, number> | null;
  lastBackupTag: { tag: string; sha: string; createdAt: string } | null;
}

/**
 * Parse an engine_meta-stored JSON value. Returns null when the value is
 * absent OR malformed — the 0.7.10 maad_health surface stays advisory, so a
 * corrupt stored value drops to null rather than surfacing as a parse error.
 */
function parseStoredJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Recursive dir size in bytes. Best-effort — unreadable entries are skipped. */
function dirSizeBytes(root: string): number {
  if (!existsSync(root)) return 0;
  let total = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      try {
        const s = statSync(full);
        if (s.isDirectory()) stack.push(full);
        else if (s.isFile()) total += s.size;
      } catch {
        /* skip unreadable entries */
      }
    }
  }
  return total;
}

// 0.8.4 — opt-in blocking rebuild of a false-empty index at boot. Off by
// default: the safe floor is to refuse to serve (see the INDEX_EMPTY guard in
// init()), not to silently spend an unbounded reindex on the first request.
// Operators who want the convenience set MAAD_BOOT_REINDEX=1; it is a behavior
// flag, never a path, so it introduces no new write target.
function bootReindexEnabled(): boolean {
  const raw = process.env['MAAD_BOOT_REINDEX'];
  return raw === '1' || raw === 'true';
}

export class MaadEngine {
  private projectRoot: string = '';
  private registry!: Registry;
  private schemaStore!: SchemaStore;
  private backend!: MaadBackend;
  private gitLayer: GitLayer | null = null;
  private journal!: OperationJournal;
  private commitFailures: CommitFailureTracker = newCommitFailureTracker();
  // 0.7.0 — pending commit identity set per-operation by the MCP `withEngine`
  // wrapper inside the write mutex (safe because write mutex serializes all
  // mutations on this engine instance). Cleared after each op. Engine-level
  // direct callers (CLI, tests) don't touch this; commit messages stay bare.
  private pendingCommitIdentity: import('../git/commit.js').CommitIdentity | undefined = undefined;
  private initialized = false;
  private _readOnly = false;
  private startupRecovery: string[] = [];

  // 0.8.0 — semantic retrieval. All null/false unless MAAD_SEMANTIC_ENABLE (or
  // the init `semantic` opt) is on. The indexer (async embed worker) runs
  // outside the write mutex.
  private semanticEnabled = false;
  private embeddingProvider: EmbeddingProvider | null = null;
  private semanticIndexer: SemanticIndexer | null = null;
  private closePromise: Promise<void> | null = null;
  // Boot opts captured so reload() re-applies them (esp. an injected provider,
  // which env can't reconstruct).
  private bootOpts: {
    readOnly?: boolean;
    semantic?: boolean;
    embeddingProvider?: EmbeddingProvider;
  } | undefined;

  // Write mutex — serializes all mutating engine operations per instance.
  // FIFO. Blocks indefinitely in 0.4.1; timeout deferred to 0.8.5.
  private writeLock = new AsyncFifoMutex();
  private lastWriteOp: { op: string; startedAtMs: number } | null = null;
  private lastWriteAt: string | null = null;

  // Cached repo-size probe. Full .git walk is O(size) and can be slow on
  // big histories; cache for 60s so consecutive maad_health calls are cheap.
  private repoSizeCache: { bytes: number; computedAtMs: number } | null = null;
  private static readonly REPO_SIZE_CACHE_MS = 60_000;
  // git-status result cache; refresh() updates it, probeGitClean() reads it.
  private lastGitCleanCache: boolean | null = null;

  /**
   * Acquire the per-engine write mutex, run `fn`, release. Records
   * `lastWriteOp` / `lastWriteAt` for health reporting and logs slow writes.
   *
   * **Reentrant.** When the current async context already holds this
   * engine's write scope (e.g. `withEngine`'s write branch acquired at the
   * MCP boundary, and the handler then calls `engine.createDocument` which
   * itself wraps in `runExclusive`), the inner call skips acquisition and
   * runs `fn` directly. Prevents double-locking deadlocks on a
   * non-reentrant FIFO mutex. Bookkeeping (lastWriteOp/lastWriteAt) fires
   * once per outermost scope.
   *
   * As of 0.5.0 R4 the MCP entry point is the primary caller — every tool
   * classified as `write` in `src/mcp/kinds.ts` wraps here at the request
   * boundary. Direct non-MCP callers (CLI, tests, import scripts) continue
   * to call engine mutation methods normally; those methods self-wrap in
   * runExclusive so direct callers stay serialized.
   */
  async runExclusive<T>(op: string, fn: () => Promise<T>): Promise<T> {
    if (writeScope.getStore() === this) {
      // Reentrant call — outer scope already owns the lock and bookkeeping.
      return fn();
    }
    const depthOnEnter = this.writeLock.depth();
    const release = await this.writeLock.acquire();
    const startedAtMs = Date.now();
    this.lastWriteOp = { op, startedAtMs };
    try {
      // 0.7.7 (fup-2026-202) — every write op enters here. Before running
      // fn() we check whether another process has edited registry/schemas
      // on disk since our last load; if so, reload schemas in-place so the
      // write uses fresh schema (correct field_index entries). Skip for
      // 'reload' itself — it's about to re-init everything regardless.
      if (op !== 'reload' && this.initialized) {
        await this.reloadSchemasIfStale(op);
      }
      const result = await writeScope.run(this, () => fn());
      // Record last-write timestamp for health reporting. Successful and
      // error-result writes both touch this — every mutating attempt counts
      // as activity; a caller can cross-reference the ops log to distinguish.
      this.lastWriteAt = new Date().toISOString();
      return result;
    } finally {
      const elapsedMs = Date.now() - startedAtMs;
      if (elapsedMs > 500) {
        logger.degraded('engine', 'write_slow', `${op} held write lock ${elapsedMs}ms`, {
          op,
          elapsedMs,
          queueDepthOnEnter: depthOnEnter,
        });
      }
      this.lastWriteOp = null;
      release();
    }
  }

  async init(
    projectRoot: string,
    opts?: {
      readOnly?: boolean;
      // 0.8.0 — force semantic on/off regardless of env (host integration / tests).
      semantic?: boolean;
      // 0.8.0 — host-injected embedding provider (engine holds no API keys).
      embeddingProvider?: EmbeddingProvider;
      // 0.8.4 — apply the false-empty index guard (see init() tail). Set by the
      // serving paths (the project pool + single-project startup) so a lost
      // index refuses to serve; left unset by the CLI, whose bootstrap is
      // init() → reindex, and by tests that drive indexAll() themselves.
      guardEmptyIndex?: boolean;
    },
  ): Promise<Result<void>> {
    this.projectRoot = path.resolve(projectRoot);
    this._readOnly = opts?.readOnly ?? false;
    this.bootOpts = opts;

    // Self-heal engine-owned state on empty projects. In read-only mode we
    // refuse to write anything: a missing registry/schema/backend is a hard
    // error. In read-write mode we create the minimum structure so pointing
    // the engine at a fresh empty directory is a valid "architect mode" entry
    // point (empty registry, no schemas, empty index).
    const registryPath = path.join(this.projectRoot, '_registry', 'object_types.yaml');
    if (!existsSync(registryPath)) {
      if (this._readOnly) {
        return singleErr('READ_ONLY', `Registry file does not exist and engine is in read-only mode: ${registryPath}`);
      }
      mkdirSync(path.dirname(registryPath), { recursive: true });
      writeFileSync(registryPath, 'types: {}\n', 'utf-8');
    }

    const schemaDir = path.join(this.projectRoot, '_schema');
    if (!existsSync(schemaDir)) {
      if (this._readOnly) {
        return singleErr('READ_ONLY', `Schema directory does not exist and engine is in read-only mode: ${schemaDir}`);
      }
      mkdirSync(schemaDir, { recursive: true });
    }

    const regResult = await loadRegistry(this.projectRoot);
    if (!regResult.ok) return regResult;
    this.registry = regResult.value;

    const schemaResult = await loadSchemas(this.projectRoot, this.registry);
    if (!schemaResult.ok) return schemaResult;
    this.schemaStore = schemaResult.value;

    const backendDir = path.join(this.projectRoot, '_backend');
    if (!existsSync(backendDir)) {
      if (this._readOnly) {
        // In read-only mode, don't create _backend — just fail gracefully
        return singleErr('READ_ONLY', 'Backend directory does not exist and engine is in read-only mode');
      }
      mkdirSync(backendDir, { recursive: true });
    }

    const dbPath = path.join(backendDir, 'maad.db');
    try {
      this.backend = new SqliteBackend(dbPath, { readOnly: this._readOnly });
      if (this._readOnly) this.backend.initReadOnly();
      else this.backend.init();
    } catch (error) {
      try { this.backend?.close(); } catch { /* partially-open backend */ }
      return singleErr(
        this._readOnly ? 'READ_ONLY' : 'BACKEND_ERROR',
        `Failed to open backend${this._readOnly ? ' in read-only mode' : ''}: ${(error as Error).message}`,
      );
    }

    // 0.8.0 — semantic retrieval bring-up. Off by default ⇒ no extension load,
    // no new tables, no worker (the engine behaves exactly as pre-0.8.0). When
    // on, load the vector/lexical index and, if a provider is available, start
    // the async embed worker (crash-resume drains any leftover queue).
    this.semanticEnabled = !this._readOnly && (opts?.semantic ?? isSemanticEnabled());
    if (this.semanticEnabled) {
      this.embeddingProvider = resolveEmbeddingProvider({ injected: opts?.embeddingProvider });
      this.backend.initSemantic({
        dim: this.embeddingProvider?.dim,
        model: this.embeddingProvider?.model,
      });
      const semIndex = this.backend.semantic();
      // Require a usable vector table: with a provider but no vec index (broken
      // vec0 → lexical-only), the worker would embed forever without draining.
      if (semIndex && semIndex.isVecReady() && this.embeddingProvider) {
        this.semanticIndexer = new SemanticIndexer(
          semIndex, this.embeddingProvider, readSemanticEnv().batchSize);
        this.semanticIndexer.start();
      }
    }

    // Operation journal — tracks pending writes for crash recovery
    this.journal = new OperationJournal(backendDir);
    this.startupRecovery = this._readOnly ? [] : this.journal.reconcile();

    this.gitLayer = new GitLayer(this.projectRoot);
    if (await this.gitLayer.isRepo()) {
      // Git is available — check for stale index.lock from a crashed prior process.
      const lockResult = this._readOnly ? { action: 'none' as const } : this.gitLayer.recoverStaleIndexLock();
      if (lockResult.action === 'conflict') {
        await this.disposeResources();
        return singleErr(
          'GIT_ERROR',
          `Git index.lock exists and is recent (mtime ${lockResult.mtime.toISOString()}); refusing to start. Another engine process may be running on this project.`,
          undefined,
          { reason: 'index-lock-recent', path: path.join(this.projectRoot, '.git', 'index.lock'), mtime: lockResult.mtime.toISOString() },
        );
      }
      if (lockResult.action === 'removed') {
        this.startupRecovery.push('index_lock_stale_removed');
      }
    } else {
      this.gitLayer = null;
    }

    this.initialized = true;

    // Warm the git-clean cache so the first health() call returns real data
    // instead of null. Best-effort — a failure here falls through to null
    // and health() reports it as "unknown" rather than crashing init.
    // Awaited (not fire-and-forget) so a caller who polls health() right
    // after init() sees consistent data, not a null → boolean transition.
    if (this.gitLayer) {
      await this.refreshGitClean();
    }

    // 0.8.4 — false-empty index guard. A persisted index reporting zero
    // documents while registered paths
    // hold markdown on disk is the "derived index was lost" state (fresh clone,
    // volume-restore, wiped _backend) — NOT a genuinely empty architect-mode
    // project, which has registered types but no markdown yet. Left alone, every
    // list/search/query would silently return []. The index rebuilds from the
    // markdown (the source of truth), so:
    //   - read-only mode  → refuse to serve (cannot write the index); the
    //     operator runs `maad reindex`.
    //   - read-write mode → refuse to serve by default; MAAD_BOOT_REINDEX=1
    //     rebuilds here instead. init() runs before the MCP request-timeout
    //     race is armed, so a blocking rebuild here is not bound by the 30s cap.
    if (opts?.guardEmptyIndex && this.registry.types.size > 0 && this.backend.getStats().totalDocuments === 0) {
      const onDiskCount = await this.probeRegisteredMarkdownCount();
      if (onDiskCount > 0) {
        if (this._readOnly) {
          await this.disposeResources();
          return singleErr(
            'INDEX_EMPTY',
            `Index is empty but ${onDiskCount} markdown file(s) exist under registered paths — the derived index was not built (fresh clone, restore, or wiped _backend). The engine is read-only and cannot rebuild it; run 'maad reindex' against this project.`,
            undefined,
            { onDiskMarkdownFiles: onDiskCount, projectRoot: this.projectRoot },
          );
        }
        if (!bootReindexEnabled()) {
          await this.disposeResources();
          return singleErr(
            'INDEX_EMPTY',
            `Index is empty but ${onDiskCount} markdown file(s) exist under registered paths — the derived index was not built (fresh clone, restore, or wiped _backend). Set MAAD_BOOT_REINDEX=1 to rebuild it at boot, or run 'maad reindex'.`,
            undefined,
            { onDiskMarkdownFiles: onDiskCount, projectRoot: this.projectRoot },
          );
        }
        logger.degraded('engine', 'boot_index_rebuild',
          `index empty with ${onDiskCount} markdown file(s) on disk — rebuilding at boot (MAAD_BOOT_REINDEX=1); embeddings, if enabled, drain asynchronously`,
          { onDiskMarkdownFiles: onDiskCount, projectRoot: this.projectRoot });
        const rebuild = this.kickIndexer(
          await this.runExclusive('boot-reindex', () => indexing.indexAll(this.ctx(), { force: false })),
        );
        if (rebuild.errors.length > 0) {
          logger.degraded('engine', 'boot_index_rebuild_errors',
            `boot rebuild indexed ${rebuild.indexed} of ${onDiskCount} file(s) with ${rebuild.errors.length} error(s) — the index is populated for the docs that succeeded`,
            { indexed: rebuild.indexed, errors: rebuild.errors.length, projectRoot: this.projectRoot });
        }
      }
    }

    return ok(undefined);
  }

  isReadOnly(): boolean {
    return this._readOnly;
  }

  async reload(): Promise<Result<void>> {
    return this.runExclusive('reload', async () => {
      const replacement = new MaadEngine();
      const result = await replacement.init(this.projectRoot, this.bootOpts);
      if (!result.ok) {
        await replacement.close();
        return result;
      }

      await this.disposeResources();
      this.registry = replacement.registry;
      this.schemaStore = replacement.schemaStore;
      this.backend = replacement.backend;
      this.gitLayer = replacement.gitLayer;
      this.journal = replacement.journal;
      this.startupRecovery = replacement.startupRecovery;
      this.semanticEnabled = replacement.semanticEnabled;
      this.embeddingProvider = replacement.embeddingProvider;
      this.semanticIndexer = replacement.semanticIndexer;
      this.initialized = true;
      // Ownership moved to this instance; prevent replacement.close() from
      // touching the adopted backend or worker.
      replacement.semanticIndexer = null;
      replacement.initialized = false;
      return ok(undefined);
    });
  }

  /**
   * 0.7.7 (fup-2026-202) — Lightweight in-place reload of registry + schemas.
   * Triggered from `runExclusive` when `schemaStore.isStale()` reports drift
   * (another process edited the schema/registry files since our last load).
   *
   * Does NOT reset the backend or git layer — only the in-memory schema and
   * registry refs are swapped. Cheap enough to run as a defensive check on
   * every write entry; the staleness probe (a handful of fstat calls) takes
   * microseconds and the actual reload only fires when files actually
   * changed. Failure path: log and proceed with the stale schema rather than
   * blocking the write — a rare case (schema deleted mid-flight) where doing
   * nothing is the lesser harm.
   */
  private async reloadSchemasIfStale(triggerOp: string): Promise<void> {
    if (!this.schemaStore.isStale()) return;
    const changedFiles: string[] = [];
    for (const [absPath, cached] of this.schemaStore.cachedFiles) {
      try {
        const st = statSync(absPath);
        if (st.mtimeMs !== cached.mtimeMs || st.size !== cached.size) {
          changedFiles.push(absPath);
        }
      } catch {
        changedFiles.push(absPath);
      }
    }
    logSchemaCacheStale({
      project: null,
      trigger_op: triggerOp,
      changed_files: changedFiles,
    });
    const regResult = await loadRegistry(this.projectRoot);
    if (!regResult.ok) {
      logger.bestEffort('engine', 'reloadSchemasIfStale.registry',
        `registry reload failed; proceeding with stale registry`,
        { errors: regResult.errors.map(e => `${e.code}: ${e.message}`).join('; ') });
      return;
    }
    const schemaResult = await loadSchemas(this.projectRoot, regResult.value);
    if (!schemaResult.ok) {
      logger.bestEffort('engine', 'reloadSchemasIfStale.schemas',
        `schema reload failed; proceeding with stale schemas`,
        { errors: schemaResult.errors.map(e => `${e.code}: ${e.message}`).join('; ') });
      return;
    }
    this.registry = regResult.value;
    this.schemaStore = schemaResult.value;
  }

  health(): HealthReport {
    this.assertInit();
    const stats = this.backend.getStats();
    const emptyProject = this.registry.types.size === 0 && stats.totalDocuments === 0;
    const lastWriteOp = this.lastWriteOp
      ? {
          op: this.lastWriteOp.op,
          startedAt: new Date(this.lastWriteOp.startedAtMs).toISOString(),
          elapsedMs: Date.now() - this.lastWriteOp.startedAtMs,
        }
      : null;
    return {
      projectRoot: this.projectRoot,
      initialized: this.initialized,
      readOnly: this._readOnly,
      gitAvailable: this.gitLayer !== null,
      indexExists: stats.totalDocuments > 0,
      lastIndexedAt: stats.lastIndexedAt,
      totalDocuments: stats.totalDocuments,
      registeredTypes: this.registry.types.size,
      recoveryActions: this.startupRecovery,
      emptyProject,
      bootstrapHint: emptyProject ? '_skills/architect-core.md' : null,
      writeQueueDepth: this.writeLock.depth(),
      lastWriteOp,
      lastWriteAt: this.lastWriteAt,
      repoSizeBytes: this.probeRepoSize(),
      gitClean: this.probeGitClean(),
      diskHeadroomMb: this.probeDiskHeadroom(),
      commitFailuresTotal: this.commitFailures.count,
      lastCommitFailureAt: this.commitFailures.lastAt,
      lastCommitFailureCode: this.commitFailures.lastCode,
      lastCommitFailureAction: this.commitFailures.lastAction,
      lastCommitFailureDocId: this.commitFailures.lastDocId,
      lastIntegritySweepAt: this.backend.getMeta('last_integrity_sweep_at'),
      lastIntegrityFindings: parseStoredJson(
        this.backend.getMeta('last_integrity_findings'),
      ) as HealthReport['lastIntegrityFindings'],
      lastBackupTag: parseStoredJson(
        this.backend.getMeta('last_backup_tag'),
      ) as HealthReport['lastBackupTag'],
    };
  }

  // ---- H8 probes ------------------------------------------------------------

  /**
   * 0.8.4 — count markdown files under every registered type path. Used only by
   * the boot false-empty guard, which runs at init() only when the index reports
   * zero documents, so this is never on a hot path. Uses the same collector as
   * indexAll (glob '**\/*.md', skipping '_deleted_' tombstones).
   */
  private async probeRegisteredMarkdownCount(): Promise<number> {
    let count = 0;
    for (const [, regType] of this.registry.types) {
      const dirPath = path.join(this.projectRoot, regType.path);
      if (!existsSync(dirPath)) continue;
      count += (await collectMarkdownFiles(dirPath)).files.length;
    }
    return count;
  }

  /**
   * Size of the .git directory on disk, in bytes. Cached for 60s since a full
   * recursive walk is O(size) and maad_health may be polled frequently. Returns
   * null if git is unavailable. Best-effort: filesystem errors return null.
   */
  private probeRepoSize(): number | null {
    if (!this.gitLayer) return null;
    const nowMs = Date.now();
    if (this.repoSizeCache && nowMs - this.repoSizeCache.computedAtMs < MaadEngine.REPO_SIZE_CACHE_MS) {
      return this.repoSizeCache.bytes;
    }
    try {
      const bytes = dirSizeBytes(path.join(this.projectRoot, '.git'));
      this.repoSizeCache = { bytes, computedAtMs: nowMs };
      return bytes;
    } catch {
      return null;
    }
  }

  /**
   * Synchronous "is the working tree clean" probe. Uses simple-git's
   * status() — fast enough for health reporting. Returns null if git is
   * unavailable. Best-effort: errors return null.
   *
   * Note: simple-git's status() is async, but we cache the most recent
   * result on a health() call so maad_health stays synchronous.
   */
  private probeGitClean(): boolean | null {
    if (!this.gitLayer) return null;
    return this.lastGitCleanCache;
  }

  /**
   * Refresh the cached git-clean flag. Called on demand (e.g. from an async
   * path that awaits the status) and in the background by probeGitClean
   * fallback.
   */
  async refreshGitClean(): Promise<boolean | null> {
    if (!this.gitLayer) {
      this.lastGitCleanCache = null;
      return null;
    }
    try {
      const status = await this.gitLayer.getSimpleGit().status();
      this.lastGitCleanCache = status.files.length === 0;
      return this.lastGitCleanCache;
    } catch {
      return this.lastGitCleanCache;
    }
  }

  /**
   * Free space on the volume holding projectRoot, in megabytes. Uses
   * fs.statfsSync which is available on Node 18+. Returns null on error
   * (e.g. unsupported filesystem, permissions).
   */
  private probeDiskHeadroom(): number | null {
    try {
      const stats = statfsSync(this.projectRoot);
      const bytes = Number(stats.bavail) * Number(stats.bsize);
      return Math.floor(bytes / (1024 * 1024));
    } catch {
      return null;
    }
  }

  /**
   * Test/drain accessor for the write mutex's current queue depth (held + waiting).
   * Used by the lifecycle drain loop (0.4.1 H7) and the concurrency test suite.
   */
  writeQueueDepth(): number {
    return this.writeLock.depth();
  }

  getStartupRecovery(): string[] {
    return this.startupRecovery;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.disposeResources();
    return this.closePromise;
  }

  private async disposeResources(): Promise<void> {
    this.initialized = false;
    const indexer = this.semanticIndexer;
    this.semanticIndexer = null;
    if (indexer) await indexer.stop();
    if (this.backend) {
      try { this.backend.close(); } catch { /* idempotent/best-effort teardown */ }
    }
  }

  private ctx(): EngineContext {
    this.assertInit();
    return {
      projectRoot: this.projectRoot,
      registry: this.registry,
      schemaStore: this.schemaStore,
      backend: this.backend,
      gitLayer: this.gitLayer,
      journal: this.journal,
      readOnly: this._readOnly,
      commitFailures: this.commitFailures,
      semanticEnabled: this.semanticEnabled,
      ...(this.embeddingProvider !== null ? { embeddingProvider: this.embeddingProvider } : {}),
      ...(this.pendingCommitIdentity !== undefined ? { commitIdentity: this.pendingCommitIdentity } : {}),
    };
  }

  /**
   * 0.8.0 — wake the async embed worker after a write/index op that may have
   * enqueued blocks. Fire-and-forget; the worker drains outside the write mutex.
   * No-op when semantic is off (indexer is null). `result` is passed through so
   * callers stay one-liners.
   */
  private kickIndexer<T>(result: T): T {
    this.semanticIndexer?.kick();
    return result;
  }

  /**
   * 0.7.0 — Set the identity slot used by the next git commit under the
   * write mutex. Caller MUST be inside `runExclusive` so no concurrent
   * writer can stomp the slot. `withEngine` (MCP layer) brackets set/clear
   * around each write handler; clear with setCommitIdentity(undefined).
   */
  setCommitIdentity(identity: import('../git/commit.js').CommitIdentity | undefined): void {
    this.pendingCommitIdentity = identity;
  }

  private assertInit(): void {
    if (!this.initialized) {
      throw new Error('MaadEngine not initialized. Call init() first.');
    }
  }

  // --- Indexing ---
  // Self-wrapping. MCP callers (withEngine write branch) enter runExclusive
  // first; these inner wraps are reentrant no-ops. Direct callers (CLI,
  // tests) get serialized via the first (outer) acquire.
  async indexAll(opts?: { force?: boolean }) {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return this.kickIndexer(await this.runExclusive('indexAll', () => indexing.indexAll(this.ctx(), opts)));
  }
  async indexFile(absolutePath: FilePath) {
    return this.kickIndexer(await this.runExclusive('indexFile', () => indexing.indexFile(this.ctx(), absolutePath)));
  }
  async reindex(opts?: { docId?: DocId; force?: boolean; embeddings?: boolean }) {
    // `embeddings` forces a full reindex (so block_text/FTS are (re)populated for
    // every doc — needed when enabling semantic on an existing project), then
    // re-enqueues all blocks and drains the worker so the rebuild is synchronous.
    const force = (opts?.force ?? false) || ((opts?.embeddings ?? false) && this.semanticEnabled);
    const idxOpts: { docId?: DocId; force?: boolean } = { force };
    if (opts?.docId !== undefined) idxOpts.docId = opts.docId;
    const result = this.kickIndexer(await this.runExclusive('reindex', () => indexing.reindex(this.ctx(), idxOpts)));
    if (opts?.embeddings && this.semanticEnabled) {
      this.backend.semantic()?.enqueueAll();
      await this.flushSemanticIndex();
      // The embed worker is fail-soft (a failed batch stays queued for retry), so
      // flush can return with work outstanding. Surface that on the ops channel —
      // maad_health.embeddings carries the live queueDepth/failures too.
      const s = this.backend.semantic()?.stats();
      if (s && (s.queueDepth > 0 || s.failures > 0)) {
        logger.degraded('engine', 'reindex_embeddings_incomplete',
          `reindex --embeddings left the vector index incomplete (queueDepth ${s.queueDepth}, failures ${s.failures}); ` +
          `the embedding provider likely errored — retry once it recovers`,
          { queueDepth: s.queueDepth, failures: s.failures });
      }
    }
    return result;
  }

  /**
   * 0.8.0 — await the async embed worker draining the queue to completion, so
   * the vector index is caught up with what's been written. No-op when semantic
   * is off or no provider is configured. Used by `reindex --embeddings`, by
   * hosts needing a consistent vector index, and by tests.
   */
  async flushSemanticIndex(): Promise<void> {
    await this.semanticIndexer?.flush();
  }

  /**
   * 0.8.0 — semantic subsystem health for maad_health.embeddings. Always returns
   * a stable shape; `enabled:false` when semantic is off or the index never
   * loaded. Provider id comes from the engine (not stored in the index).
   */
  semanticHealth(): {
    enabled: boolean; provider: string | null; model: string | null; dim: number | null;
    vecReady: boolean; queueDepth: number; embeddedBlocks: number; indexedBlocks: number; failures: number;
  } {
    const sem = this.backend.semantic();
    if (!this.semanticEnabled || !sem || !sem.isReady()) {
      return { enabled: false, provider: null, model: null, dim: null, vecReady: false,
        queueDepth: 0, embeddedBlocks: 0, indexedBlocks: 0, failures: 0 };
    }
    const s = sem.stats();
    return {
      enabled: true,
      provider: this.embeddingProvider?.id ?? null,
      model: s.model, dim: s.dim, vecReady: s.vecReady,
      queueDepth: s.queueDepth, embeddedBlocks: s.embeddedBlocks,
      indexedBlocks: s.indexedBlocks, failures: s.failures,
    };
  }

  // --- Reads ---
  async getDocument(id: DocId, depth: 'hot' | 'warm' | 'cold', blockIdOrHeading?: string) { return reads.getDocument(this.ctx(), id, depth, blockIdOrHeading); }
  findDocuments(query: import('../types.js').DocumentQuery) { return reads.findDocuments(this.ctx(), query); }
  searchObjects(query: import('../types.js').ObjectQuery) { return reads.searchObjects(this.ctx(), query); }
  listRelated(id: DocId, direction: 'outgoing' | 'incoming' | 'both', types?: DocType[]) { return reads.listRelated(this.ctx(), id, direction, types); }
  describe() { return reads.describe(this.ctx()); }
  summary() { return reads.summary(this.ctx()); }
  getSchema(dt: DocType) { return reads.getSchema(this.ctx(), dt); }
  schemaInfo(dt: DocType) { return reads.schemaInfo(this.ctx(), dt); }
  aggregate(query: import('./types.js').AggregateQuery) { return reads.aggregate(this.ctx(), query); }
  join(query: import('./types.js').JoinQuery) { return reads.join(this.ctx(), query); }
  async verifyField(id: DocId, field: string, expected: unknown) { return reads.verifyField(this.ctx(), id, field, expected); }
  verifyCount(dt: DocType, expectedCount: number, filters?: Record<string, import('../types.js').FilterCondition>) { return reads.verifyCount(this.ctx(), dt, expectedCount, filters); }
  async verifyIntegrity(query?: import('./types.js').IntegrityQuery) { return reads.verifyIntegrity(this.ctx(), query); }
  async backupCreate(opts?: import('./types.js').CreateBackupOptions) {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return backup.createBackup(this.ctx(), opts);
  }
  async backupList(opts?: import('./types.js').ListBackupsOptions) { return backup.listBackups(this.ctx(), opts); }
  async backupDelete(tag: string) {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return backup.deleteBackup(this.ctx(), tag);
  }
  changesSince(query: import('./types.js').ChangesSinceQuery) { return reads.changesSince(this.ctx(), query); }
  // 0.8.0 — semantic retrieval (async: embeds the query for semantic/hybrid).
  async semanticSearch(query: import('./semantic/types.js').SemanticSearchQuery) { return semanticSearchOps.semanticSearch(this.ctx(), query); }

  // --- Composites (Tier 2, provisional) ---
  async getDocumentFull(id: DocId) { return composites.getDocumentFull(this.ctx(), id); }

  // --- Writes (read-only guarded, serialized under write mutex) ---
  // Self-wrapping. Reentrant under an outer runExclusive scope.
  async createDocument(dt: DocType, fields: Record<string, unknown>, body?: string, customDocId?: string) {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return this.kickIndexer(await this.runExclusive('createDocument',
      () => writes.createDocument(this.ctx(), dt, fields, body, customDocId),
    ));
  }
  async updateDocument(id: DocId, fields?: Record<string, unknown>, body?: string, appendBody?: string, expectedVersion?: number) {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return this.kickIndexer(await this.runExclusive('updateDocument',
      () => writes.updateDocument(this.ctx(), id, fields, body, appendBody, expectedVersion),
    ));
  }
  async deleteDocument(id: DocId, mode: 'soft' | 'hard') {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return this.runExclusive('deleteDocument',
      () => writes.deleteDocument(this.ctx(), id, mode),
    );
  }
  async bulkCreate(records: import('./types.js').BulkCreateInput[]) {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return this.kickIndexer(await this.runExclusive('bulkCreate',
      () => writes.bulkCreate(this.ctx(), records),
    ));
  }
  async bulkUpdate(updates: import('./types.js').BulkUpdateInput[]) {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return this.kickIndexer(await this.runExclusive('bulkUpdate',
      () => writes.bulkUpdate(this.ctx(), updates),
    ));
  }
  async bulkDelete(docIds: string[], mode: 'soft' | 'hard') {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return this.runExclusive('bulkDelete',
      () => writes.bulkDelete(this.ctx(), docIds, mode),
    );
  }
  async purgeSoftDeleted(olderThanIso: string, maxRecords: number) {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return this.runExclusive('purgeSoftDeleted',
      () => writes.purgeSoftDeleted(this.ctx(), olderThanIso, maxRecords),
    );
  }
  async repairWhere(
    filter: Record<string, import('../types.js').FilterCondition> | undefined,
    docType: DocType | undefined,
    repairTypes: import('./types.js').RepairStrategyName[],
    maxRecords: number,
  ) {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return this.kickIndexer(await this.runExclusive('repairWhere',
      () => repairs.repairWhere(this.ctx(), filter, docType, repairTypes, maxRecords),
    ));
  }

  // --- Maintenance ---
  async validate(docId?: DocId, options?: maintenance.ValidateOptions) { return maintenance.validate(this.ctx(), docId, options); }

  // --- Audit ---
  async history(id: DocId, opts?: { limit?: number; since?: string }) { return auditOps.history(this.ctx(), id, opts); }
  async diff(id: DocId, from: string, to?: string) { return auditOps.diff(this.ctx(), id, from, to); }
  async snapshot(id: DocId, at: string) { return auditOps.snapshot(this.ctx(), id, at); }
  async audit(opts?: { since?: string; until?: string; docType?: DocType }) { return auditOps.audit(this.ctx(), opts); }

  // --- Accessors ---
  getBackend(): MaadBackend { return this.backend; }
  getRegistry(): Registry { return this.registry; }
  getGitLayer(): GitLayer | null { return this.gitLayer; }
  getProjectRoot(): string { return this.projectRoot; }
}
