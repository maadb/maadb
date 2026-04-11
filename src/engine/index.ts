// ============================================================================
// MAAD Engine — Thin facade over domain modules
// Holds state, delegates to domain functions via EngineContext.
// ============================================================================

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { ok, singleErr, type Result } from '../errors.js';
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
import type { EngineContext } from './context.js';
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
}

export class MaadEngine {
  private projectRoot: string = '';
  private registry!: Registry;
  private schemaStore!: SchemaStore;
  private backend!: MaadBackend;
  private gitLayer: GitLayer | null = null;
  private journal!: OperationJournal;
  private initialized = false;
  private _readOnly = false;
  private startupRecovery: string[] = [];

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
      // Git is available
    } else {
      this.gitLayer = null;
    }

    this.initialized = true;
    return ok(undefined);
  }

  isReadOnly(): boolean {
    return this._readOnly;
  }

  async reload(): Promise<Result<void>> {
    if (this.backend) this.backend.close();
    this.initialized = false;
    return this.init(this.projectRoot, { readOnly: this._readOnly });
  }

  health(): HealthReport {
    this.assertInit();
    const stats = this.backend.getStats();
    const emptyProject = this.registry.types.size === 0 && stats.totalDocuments === 0;
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
    };
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
    };
  }

  private assertInit(): void {
    if (!this.initialized) {
      throw new Error('MaadEngine not initialized. Call init() first.');
    }
  }

  // --- Indexing ---
  async indexAll(opts?: { force?: boolean }) { return indexing.indexAll(this.ctx(), opts); }
  async indexFile(absolutePath: FilePath) { return indexing.indexFile(this.ctx(), absolutePath); }
  async reindex(opts?: { docId?: DocId; force?: boolean }) { return indexing.reindex(this.ctx(), opts); }

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

  // --- Composites (Tier 2, provisional) ---
  async getDocumentFull(id: DocId) { return composites.getDocumentFull(this.ctx(), id); }

  // --- Writes (read-only guarded) ---
  async createDocument(dt: DocType, fields: Record<string, unknown>, body?: string, customDocId?: string) {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return writes.createDocument(this.ctx(), dt, fields, body, customDocId);
  }
  async updateDocument(id: DocId, fields?: Record<string, unknown>, body?: string, appendBody?: string, expectedVersion?: number) {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return writes.updateDocument(this.ctx(), id, fields, body, appendBody, expectedVersion);
  }
  async deleteDocument(id: DocId, mode: 'soft' | 'hard') {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return writes.deleteDocument(this.ctx(), id, mode);
  }
  async bulkCreate(records: import('./types.js').BulkCreateInput[]) {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return writes.bulkCreate(this.ctx(), records);
  }
  async bulkUpdate(updates: import('./types.js').BulkUpdateInput[]) {
    if (this._readOnly) return singleErr('READ_ONLY', 'Engine is in read-only mode');
    return writes.bulkUpdate(this.ctx(), updates);
  }

  // --- Maintenance ---
  async validate(docId?: DocId) { return maintenance.validate(this.ctx(), docId); }

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
