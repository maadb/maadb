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
import { SqliteBackend } from '../backend/index.js';
import type { MaadBackend } from '../backend/index.js';
import { GitLayer } from '../git/index.js';
import type { EngineContext, CommitFailureTracker } from './context.js';
import { newCommitFailureTracker } from './context.js';
import { OperationJournal } from './journal.js';

// Domain modules
import * as indexing from './indexing.js';
import * as reads from './reads.js';
import * as composites from './composites.js';
import * as writes from './writes.js';
import * as maintenance from './maintenance.js';
import * as auditOps from './audit.js';

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

  async init(projectRoot: string, opts?: { readOnly?: boolean }): Promise<Result<void>> {
    this.projectRoot = path.resolve(projectRoot);
    this._readOnly = opts?.readOnly ?? false;

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
    this.backend = new SqliteBackend(dbPath);
    this.backend.init();

    // Operation journal — tracks pending writes for crash recovery
    this.journal = new OperationJournal(backendDir);
    this.startupRecovery = this.journal.reconcile();

    this.gitLayer = new GitLayer(this.projectRoot);
    if (await this.gitLayer.isRepo()) {
      // Git is available — check for stale index.lock from a crashed prior process.
      const lockResult = this.gitLayer.recoverStaleIndexLock();
      if (lockResult.action === 'conflict') {
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

    return ok(undefined);
  }

  isReadOnly(): boolean {
    return this._readOnly;
  }

  async reload(): Promise<Result<void>> {
    return this.runExclusive('reload', async () => {
      if (this.backend) this.backend.close();
      this.initialized = false;
      return this.init(this.projectRoot, { readOnly: this._readOnly });
    });
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
    };
  }

  // ---- H8 probes ------------------------------------------------------------

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

  close(): void {
    if (this.backend) this.backend.close();
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
      ...(this.pendingCommitIdentity !== undefined ? { commitIdentity: this.pendingCommitIdentity } : {}),
    };
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
    return this.runExclusive('indexAll', () => indexing.indexAll(this.ctx(), opts));
  }
  async indexFile(absolutePath: FilePath) {
    return this.runExclusive('indexFile', () => indexing.indexFile(this.ctx(), absolutePath));
  }
  async reindex(opts?: { docId?: DocId; force?: boolean }) {
    return this.runExclusive('reindex', () => indexing.reindex(this.ctx(), opts));
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
  changesSince(query: import('./types.js').ChangesSinceQuery) { return reads.changesSince(this.ctx(), query); }

  // --- Composites (Tier 2, provisional) ---
  async getDocumentFull(id: DocId) { return composites.getDocumentFull(this.ctx(), id); }

  // --- Writes (read-only guarded, serialized under write mutex) ---
  // Self-wrapping. Reentrant under an outer runExclusive scope.
  async createDocument(dt: DocType, fields: Record<string, unknown>, body?: string, customDocId?: string) {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return this.runExclusive('createDocument',
      () => writes.createDocument(this.ctx(), dt, fields, body, customDocId),
    );
  }
  async updateDocument(id: DocId, fields?: Record<string, unknown>, body?: string, appendBody?: string, expectedVersion?: number) {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return this.runExclusive('updateDocument',
      () => writes.updateDocument(this.ctx(), id, fields, body, appendBody, expectedVersion),
    );
  }
  async deleteDocument(id: DocId, mode: 'soft' | 'hard') {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return this.runExclusive('deleteDocument',
      () => writes.deleteDocument(this.ctx(), id, mode),
    );
  }
  async bulkCreate(records: import('./types.js').BulkCreateInput[]) {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return this.runExclusive('bulkCreate',
      () => writes.bulkCreate(this.ctx(), records),
    );
  }
  async bulkUpdate(updates: import('./types.js').BulkUpdateInput[]) {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return this.runExclusive('bulkUpdate',
      () => writes.bulkUpdate(this.ctx(), updates),
    );
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
