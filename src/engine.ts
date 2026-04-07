// ============================================================================
// MAAD Engine
// Orchestrates the 6-stage pipeline and provides the full API surface
// that MCP tools and CLI commands call into.
// ============================================================================

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { glob } from 'node:fs/promises';

import { ok, err, singleErr, maadError, type Result, type MaadError } from './errors.js';
import {
  docId as toDocId,
  docType as toDocType,
  schemaRef as toSchemaRef,
  filePath as toFilePath,
  type DocId,
  type DocType,
  type FilePath,
  type SchemaRef,
  type Registry,
  type SchemaStore,
  type SchemaDefinition,
  type ParsedDocument,
  type BoundDocument,
  type ValidatedField,
  type ExtractionResult,
  type DocumentRecord,
  type DocumentQuery,
  type ObjectQuery,
  type DocumentMatch,
  type ObjectMatch,
  type Relationship,
  type ParsedBlock,
  type BackendStats,
  type ValidationResult,
  type ParsedCommit,
  type AuditEntry,
  type DiffResult,
  type SnapshotResult,
} from './types.js';
import { loadRegistry } from './registry/index.js';
import { loadSchemas, validateFrontmatter } from './schema/index.js';
import { parseDocument } from './parser/index.js';
import { extract } from './extractor/index.js';
import { SqliteBackend } from './backend/index.js';
import type { MaadBackend } from './backend/index.js';
import { generateDocument, extractBody } from './writer/index.js';
import { GitLayer, type CommitOptions } from './git/index.js';

// --- Result types for engine operations ------------------------------------

export interface IndexResult {
  scanned: number;
  indexed: number;
  skipped: number;
  errors: MaadError[];
}

export interface CreateResult {
  docId: DocId;
  filePath: FilePath;
  version: number;
  validation: ValidationResult;
}

export interface GetResult {
  docId: DocId;
  docType: DocType;
  depth: 'hot' | 'warm' | 'cold';
  frontmatter: Record<string, unknown>;
  block?: { id: string | null; heading: string; content: string } | undefined;
  body?: string | undefined;
}

export interface UpdateResult {
  docId: DocId;
  version: number;
  changedFields: string[];
  validation: ValidationResult;
}

export interface DeleteResult {
  docId: DocId;
  mode: 'soft' | 'hard';
  filePath: FilePath;
}

export interface FindResult {
  total: number;
  results: DocumentMatch[];
}

export interface SearchResult {
  total: number;
  results: ObjectMatch[];
}

export interface RelatedResult {
  docId: DocId;
  outgoing: Array<{ docId: DocId; docType: DocType; field: string }>;
  incoming: Array<{ docId: DocId; docType: DocType; field: string }>;
}

export interface DescribeResult {
  registryTypes: Array<{
    type: string;
    path: string;
    idPrefix: string;
    schema: string;
    docCount: number;
  }>;
  extractionPrimitives: string[];
  totalDocuments: number;
  lastIndexedAt: string | null;
}

export interface InspectResult {
  docId: DocId;
  filePath: FilePath;
  fileHash: string;
  docType: DocType;
  schemaRef: SchemaRef;
  version: number;
  validation: ValidationResult;
  blocks: ParsedBlock[];
  objects: ObjectMatch[];
  relationships: Relationship[];
}

export interface ValidationReport {
  total: number;
  valid: number;
  invalid: number;
  errors: Array<{ docId: DocId; errors: Array<{ field: string; message: string }> }>;
}

// --- Engine ----------------------------------------------------------------

export class MaadEngine {
  private projectRoot: string = '';
  private registry!: Registry;
  private schemaStore!: SchemaStore;
  private backend!: MaadBackend;
  private gitLayer: GitLayer | null = null;
  private initialized = false;

  async init(projectRoot: string): Promise<Result<void>> {
    this.projectRoot = path.resolve(projectRoot);

    // Stage 1: Load registry
    const regResult = await loadRegistry(this.projectRoot);
    if (!regResult.ok) return regResult;
    this.registry = regResult.value;

    // Load schemas
    const schemaResult = await loadSchemas(this.projectRoot, this.registry);
    if (!schemaResult.ok) return schemaResult;
    this.schemaStore = schemaResult.value;

    // Init backend
    const backendDir = path.join(this.projectRoot, '_backend');
    if (!existsSync(backendDir)) mkdirSync(backendDir, { recursive: true });

    const dbPath = path.join(backendDir, 'maad.db');
    this.backend = new SqliteBackend(dbPath);
    this.backend.init();

    // Init git layer (non-fatal if not a repo)
    this.gitLayer = new GitLayer(this.projectRoot);
    if (await this.gitLayer.isRepo()) {
      // Git is available
    } else {
      this.gitLayer = null; // No git — audit tools will be unavailable
    }

    this.initialized = true;
    return ok(undefined);
  }

  close(): void {
    if (this.backend) this.backend.close();
  }

  // --- Indexing -------------------------------------------------------------

  async indexAll(opts?: { force?: boolean }): Promise<IndexResult> {
    this.assertInit();
    const force = opts?.force ?? false;
    const result: IndexResult = { scanned: 0, indexed: 0, skipped: 0, errors: [] };

    const storedHashes = force ? new Map() : this.backend.getAllFileHashes();

    // Track all files found on disk to detect stale backend records
    const filesOnDisk = new Set<string>();

    for (const [, regType] of this.registry.types) {
      const dirPath = path.join(this.projectRoot, regType.path);
      if (!existsSync(dirPath)) continue;

      const files = await collectMarkdownFiles(dirPath);

      for (const file of files) {
        result.scanned++;
        const fp = toFilePath(path.relative(this.projectRoot, file));
        const absPath = toFilePath(file);
        filesOnDisk.add(fp as string);

        // Change detection
        if (!force) {
          const raw = await readFile(file, 'utf-8');
          const currentHash = createHash('sha256').update(raw).digest('hex');
          const storedHash = storedHashes.get(fp);
          if (storedHash === currentHash) {
            result.skipped++;
            continue;
          }
        }

        const indexResult = await this.indexFile(absPath);
        if (indexResult.ok) {
          result.indexed++;
        } else {
          result.errors.push(...indexResult.errors);
        }
      }
    }

    // Remove stale backend records for files that no longer exist on disk
    const allStoredPaths = this.backend.getAllFileHashes();
    for (const [storedPath] of allStoredPaths) {
      if (!filesOnDisk.has(storedPath as string)) {
        const doc = this.backend.getDocumentByPath(storedPath);
        if (doc) {
          this.backend.removeDocument(doc.docId);
        }
      }
    }

    return result;
  }

  async indexFile(absolutePath: FilePath): Promise<Result<ExtractionResult>> {
    this.assertInit();

    // Stage 3: Parse
    const parsed = await parseDocument(absolutePath, this.registry.subtypeMap);
    if (!parsed.ok) return parsed;

    return this.processDocument(parsed.value);
  }

  private processDocument(parsed: ParsedDocument): Result<ExtractionResult> {
    // Stage 4: Bind schema
    const fmDocType = parsed.frontmatter['doc_type'];
    if (typeof fmDocType !== 'string') {
      return singleErr('UNKNOWN_TYPE', `Document has no doc_type in frontmatter: ${parsed.filePath}`);
    }

    const dt = toDocType(fmDocType);
    const schema = this.schemaStore.getSchemaForType(dt);
    if (!schema) {
      return singleErr('UNKNOWN_TYPE', `No schema found for doc_type "${fmDocType}"`);
    }

    const fmDocId = parsed.frontmatter['doc_id'];
    if (typeof fmDocId !== 'string') {
      return singleErr('INVALID_DOC_ID', `Document has no doc_id in frontmatter: ${parsed.filePath}`);
    }

    const regType = this.registry.types.get(dt);
    if (!regType) {
      return singleErr('UNKNOWN_TYPE', `Type "${fmDocType}" not in registry`);
    }

    const validation = validateFrontmatter(parsed.frontmatter, schema, this.registry, parsed.filePath);

    // Build validated fields
    const validatedFields: Record<string, ValidatedField> = {};
    for (const [fieldName, fieldDef] of schema.fields) {
      const value = parsed.frontmatter[fieldName];
      if (value !== undefined && value !== null) {
        validatedFields[fieldName] = {
          name: fieldName,
          value,
          fieldType: fieldDef.type,
          role: fieldDef.role,
          indexed: fieldDef.index,
        };
      }
    }

    const bound: BoundDocument = {
      parsed,
      docId: toDocId(fmDocId),
      docType: dt,
      schemaRef: regType.schemaRef,
      validatedFields,
      validationResult: validation,
    };

    // Stage 5: Extract
    const extraction = extract(bound, schema, this.registry);

    // Stage 6: Materialize
    const relativePath = path.relative(this.projectRoot, parsed.filePath as string);
    const docRecord: DocumentRecord = {
      docId: bound.docId,
      docType: bound.docType,
      schemaRef: bound.schemaRef,
      filePath: toFilePath(relativePath),
      fileHash: parsed.fileHash,
      version: this.getNextVersion(bound.docId),
      frontmatter: parsed.frontmatter,
      deleted: false,
      indexedAt: new Date().toISOString(),
    };

    const fieldIndex: Array<{ name: string; value: string; numericValue: number | null; type: string }> = [];
    for (const [name, field] of Object.entries(validatedFields)) {
      if (field.indexed) {
        fieldIndex.push({
          name,
          value: String(field.value),
          numericValue: computeNumericValue(field.value, field.fieldType),
          type: field.fieldType,
        });
      }
    }

    this.backend.materializeDocument(
      docRecord,
      extraction.objects,
      extraction.relationships,
      parsed.blocks,
      fieldIndex,
    );

    return ok(extraction);
  }

  private getNextVersion(docId: DocId): number {
    const existing = this.backend.getDocument(docId);
    return existing ? existing.version + 1 : 1;
  }

  // --- CRUD ----------------------------------------------------------------

  async createDocument(
    dt: DocType,
    fields: Record<string, unknown>,
    body?: string | undefined,
    customDocId?: string | undefined,
  ): Promise<Result<CreateResult>> {
    this.assertInit();

    const regType = this.registry.types.get(dt);
    if (!regType) return singleErr('UNKNOWN_TYPE', `Type "${dt as string}" not in registry`);

    const schema = this.schemaStore.getSchemaForType(dt);
    if (!schema) return singleErr('SCHEMA_NOT_FOUND', `No schema for type "${dt as string}"`);

    // Generate doc_id
    const id = customDocId ?? generateDocId(regType.idPrefix, fields);

    // Check for duplicates
    if (this.backend.getDocument(toDocId(id))) {
      return singleErr('DUPLICATE_DOC_ID', `Document "${id}" already exists`);
    }

    // Build frontmatter
    const frontmatter: Record<string, unknown> = {
      doc_id: id,
      doc_type: dt as string,
      schema: regType.schemaRef as string,
      ...fields,
    };

    // Validate
    const validation = validateFrontmatter(frontmatter, schema, this.registry);
    if (!validation.valid) {
      return err(validation.errors.map(e => maadError('VALIDATION_FAILED', `${e.field}: ${e.message}`)));
    }

    // Generate markdown
    const markdown = generateDocument(frontmatter, schema, body);

    // Write file
    const dirPath = path.join(this.projectRoot, regType.path);
    if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });

    const fp = path.join(dirPath, `${id}.md`);
    await writeFile(fp, markdown, 'utf-8');

    // Index — file is already on disk; if indexing fails, next reindex recovers
    const indexResult = await this.indexFile(toFilePath(fp));
    if (!indexResult.ok) {
      console.warn(`MAAD: File written to ${fp} but indexing failed. Run 'maad reindex' to recover.`);
      return err(indexResult.errors.map(e => ({
        ...e,
        details: { ...e.details, fileWritten: true, recoveryHint: 'Run maad reindex to recover' },
      })));
    }

    // Git auto-commit
    await this.gitCommit({
      action: 'create',
      docId: toDocId(id),
      docType: dt,
      detail: '',
      summary: String(fields['name'] ?? fields['title'] ?? id),
      files: [fp],
    });

    return ok({
      docId: toDocId(id),
      filePath: toFilePath(path.relative(this.projectRoot, fp)),
      version: 1,
      validation,
    });
  }

  async getDocument(
    id: DocId,
    depth: 'hot' | 'warm' | 'cold',
    blockIdOrHeading?: string | undefined,
  ): Promise<Result<GetResult>> {
    this.assertInit();

    const doc = this.backend.getDocument(id);
    if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${id as string}" not found`);

    const result: GetResult = {
      docId: doc.docId,
      docType: doc.docType,
      depth,
      frontmatter: doc.frontmatter,
    };

    if (depth === 'warm' && blockIdOrHeading) {
      const blocks = this.backend.getBlocks(id);
      const match = blocks.find(b =>
        (b.id as string) === blockIdOrHeading ||
        b.heading.toLowerCase() === blockIdOrHeading.toLowerCase()
      );
      if (match) {
        result.block = {
          id: match.id as string | null,
          heading: match.heading,
          content: match.content,
        };
      }
    }

    if (depth === 'cold') {
      const absPath = path.join(this.projectRoot, doc.filePath as string);
      try {
        const raw = await readFile(absPath, 'utf-8');
        // Strip frontmatter, return body only
        result.body = extractBody(raw);
      } catch {
        result.body = '';
      }
    }

    return ok(result);
  }

  findDocuments(query: DocumentQuery): Result<FindResult> {
    this.assertInit();
    const results = this.backend.findDocuments(query);
    return ok({ total: results.length, results });
  }

  async updateDocument(
    id: DocId,
    fields?: Record<string, unknown> | undefined,
    body?: string | undefined,
    appendBody?: string | undefined,
    expectedVersion?: number | undefined,
  ): Promise<Result<UpdateResult>> {
    this.assertInit();

    const doc = this.backend.getDocument(id);
    if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${id as string}" not found`);

    // Version conflict check
    if (expectedVersion !== undefined && doc.version !== expectedVersion) {
      return singleErr('VERSION_CONFLICT',
        `Expected version ${expectedVersion} but document is at version ${doc.version}`,
        undefined,
        { expected: expectedVersion, actual: doc.version },
      );
    }

    const schema = this.schemaStore.getSchemaForType(doc.docType);
    if (!schema) return singleErr('SCHEMA_NOT_FOUND', `No schema for type "${doc.docType as string}"`);

    // Read current file
    const absPath = path.join(this.projectRoot, doc.filePath as string);
    let raw: string;
    try {
      raw = await readFile(absPath, 'utf-8');
    } catch {
      return singleErr('FILE_READ_ERROR', `Cannot read file: ${absPath}`);
    }

    // Update frontmatter
    const changedFields: string[] = [];
    const updatedFm = { ...doc.frontmatter };
    if (fields) {
      for (const [key, value] of Object.entries(fields)) {
        if (updatedFm[key] !== value) {
          changedFields.push(key);
          updatedFm[key] = value;
        }
      }
    }

    // Validate
    const validation = validateFrontmatter(updatedFm, schema, this.registry);
    if (!validation.valid) {
      return err(validation.errors.map(e => maadError('VALIDATION_FAILED', `${e.field}: ${e.message}`)));
    }

    // Rebuild file content
    let currentBody = '';
    currentBody = extractBody(raw);

    if (body !== undefined) {
      currentBody = body;
    } else if (appendBody !== undefined) {
      currentBody = currentBody.trimEnd() + '\n\n' + appendBody;
    }

    const markdown = generateDocument(updatedFm, schema, currentBody.trim() || undefined);
    await writeFile(absPath, markdown, 'utf-8');

    // Reindex — file is already on disk; if indexing fails, next reindex recovers
    const indexResult = await this.indexFile(toFilePath(absPath));
    if (!indexResult.ok) {
      console.warn(`MAAD: File updated at ${absPath} but reindexing failed. Run 'maad reindex' to recover.`);
      return err(indexResult.errors.map(e => ({
        ...e,
        details: { ...e.details, fileWritten: true, recoveryHint: 'Run maad reindex to recover' },
      })));
    }

    // Git auto-commit
    const detail = changedFields.length > 0
      ? `fields:${changedFields.join(',')}`
      : (appendBody ? 'body:append' : 'body:replace');
    const summary = changedFields.length > 0
      ? changedFields.map(f => `${f}: ${String(updatedFm[f] ?? '')}`).join(', ')
      : 'Body updated';
    await this.gitCommit({
      action: 'update',
      docId: id,
      docType: doc.docType,
      detail,
      summary,
      files: [absPath],
    });

    const newDoc = this.backend.getDocument(id);

    return ok({
      docId: id,
      version: newDoc?.version ?? doc.version + 1,
      changedFields,
      validation,
    });
  }

  async deleteDocument(id: DocId, mode: 'soft' | 'hard'): Promise<Result<DeleteResult>> {
    this.assertInit();

    const doc = this.backend.getDocument(id);
    if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${id as string}" not found`);

    const absPath = path.join(this.projectRoot, doc.filePath as string);

    if (mode === 'hard') {
      try {
        await unlink(absPath);
      } catch {
        return singleErr('DELETE_ERROR', `Failed to delete file: ${absPath}`);
      }
      this.backend.removeDocument(id);
    } else {
      // Soft delete: rename file with _deleted prefix
      const dir = path.dirname(absPath);
      const base = path.basename(absPath);
      const deletedPath = path.join(dir, `_deleted_${base}`);
      try {
        await rename(absPath, deletedPath);
      } catch {
        return singleErr('DELETE_ERROR', `Failed to rename file: ${absPath}`);
      }

      // Update backend: mark as deleted
      const updatedDoc: DocumentRecord = {
        ...doc,
        filePath: toFilePath(path.relative(this.projectRoot, deletedPath)),
        deleted: true,
        indexedAt: new Date().toISOString(),
      };
      this.backend.putDocument(updatedDoc);
    }

    // Git auto-commit
    if (mode === 'hard') {
      await this.gitCommit({
        action: 'delete',
        docId: id,
        docType: doc.docType,
        detail: 'hard',
        summary: `Hard deleted ${id as string}`,
        files: [absPath],
      });
    } else {
      const deletedPath = path.join(path.dirname(absPath), `_deleted_${path.basename(absPath)}`);
      await this.gitCommit({
        action: 'delete',
        docId: id,
        docType: doc.docType,
        detail: 'soft',
        summary: `Soft deleted ${id as string}`,
        files: [absPath, deletedPath],
      });
    }

    return ok({
      docId: id,
      mode,
      filePath: doc.filePath,
    });
  }

  // --- Navigation ----------------------------------------------------------

  listRelated(
    id: DocId,
    direction: 'outgoing' | 'incoming' | 'both',
    types?: DocType[] | undefined,
  ): Result<RelatedResult> {
    this.assertInit();

    const rels = this.backend.getRelationships(id, direction);

    const outgoing: RelatedResult['outgoing'] = [];
    const incoming: RelatedResult['incoming'] = [];

    for (const rel of rels) {
      if (rel.sourceDocId === id) {
        const targetDoc = this.backend.getDocument(rel.targetDocId);
        const targetType = targetDoc?.docType ?? toDocType('unknown');
        if (!types || types.includes(targetType)) {
          outgoing.push({ docId: rel.targetDocId, docType: targetType, field: rel.field });
        }
      } else {
        const sourceDoc = this.backend.getDocument(rel.sourceDocId);
        const sourceType = sourceDoc?.docType ?? toDocType('unknown');
        if (!types || types.includes(sourceType)) {
          incoming.push({ docId: rel.sourceDocId, docType: sourceType, field: rel.field });
        }
      }
    }

    return ok({ docId: id, outgoing, incoming });
  }

  searchObjects(query: ObjectQuery): Result<SearchResult> {
    this.assertInit();
    const results = this.backend.findObjects(query);
    return ok({ total: results.length, results });
  }

  // --- Discovery -----------------------------------------------------------

  describe(): DescribeResult {
    this.assertInit();
    const stats = this.backend.getStats();

    const registryTypes = [...this.registry.types.values()].map(rt => ({
      type: rt.name as string,
      path: rt.path,
      idPrefix: rt.idPrefix,
      schema: rt.schemaRef as string,
      docCount: stats.documentCountByType[rt.name as string] ?? 0,
    }));

    return {
      registryTypes,
      extractionPrimitives: [
        'entity', 'date', 'duration', 'amount', 'measure',
        'quantity', 'percentage', 'location', 'identifier', 'contact', 'media',
      ],
      totalDocuments: stats.totalDocuments,
      lastIndexedAt: stats.lastIndexedAt,
    };
  }

  getSchema(dt: DocType): SchemaDefinition | undefined {
    this.assertInit();
    return this.schemaStore.getSchemaForType(dt);
  }

  async inspect(id: DocId): Promise<Result<InspectResult>> {
    this.assertInit();

    const doc = this.backend.getDocument(id);
    if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${id as string}" not found`);

    const schema = this.schemaStore.getSchemaForType(doc.docType);
    const validation = schema
      ? validateFrontmatter(doc.frontmatter, schema, this.registry)
      : { valid: false, errors: [{ field: 'doc_type', message: 'No schema found', location: null }] };

    const blocks = this.backend.getBlocks(id);
    const objects = this.backend.findObjects({ docId: id, limit: 1000 });
    const relationships = this.backend.getRelationships(id, 'both');

    return ok({
      docId: doc.docId,
      filePath: doc.filePath,
      fileHash: doc.fileHash,
      docType: doc.docType,
      schemaRef: doc.schemaRef,
      version: doc.version,
      validation,
      blocks,
      objects,
      relationships,
    });
  }

  // --- Maintenance ---------------------------------------------------------

  async validate(docId?: DocId | undefined): Promise<Result<ValidationReport>> {
    this.assertInit();

    if (docId) {
      const doc = this.backend.getDocument(docId);
      if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${docId as string}" not found`);

      const schema = this.schemaStore.getSchemaForType(doc.docType);
      if (!schema) return singleErr('SCHEMA_NOT_FOUND', `No schema for type "${doc.docType as string}"`);

      const result = validateFrontmatter(doc.frontmatter, schema, this.registry);
      return ok({
        total: 1,
        valid: result.valid ? 1 : 0,
        invalid: result.valid ? 0 : 1,
        errors: result.valid ? [] : [{ docId, errors: result.errors.map(e => ({ field: e.field, message: e.message })) }],
      });
    }

    // Validate all
    const allDocs = this.backend.findDocuments({ limit: 100000 });
    const report: ValidationReport = { total: 0, valid: 0, invalid: 0, errors: [] };

    for (const match of allDocs) {
      report.total++;
      const doc = this.backend.getDocument(match.docId);
      if (!doc) continue;

      const schema = this.schemaStore.getSchemaForType(doc.docType);
      if (!schema) {
        report.invalid++;
        report.errors.push({ docId: doc.docId, errors: [{ field: 'doc_type', message: 'No schema found' }] });
        continue;
      }

      const result = validateFrontmatter(doc.frontmatter, schema, this.registry);
      if (result.valid) {
        report.valid++;
      } else {
        report.invalid++;
        report.errors.push({ docId: doc.docId, errors: result.errors.map(e => ({ field: e.field, message: e.message })) });
      }
    }

    return ok(report);
  }

  async reindex(opts?: { docId?: DocId; force?: boolean }): Promise<Result<IndexResult>> {
    this.assertInit();

    if (opts?.docId) {
      const doc = this.backend.getDocument(opts.docId);
      if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${opts.docId as string}" not found`);

      const absPath = path.join(this.projectRoot, doc.filePath as string);
      const result = await this.indexFile(toFilePath(absPath));
      if (!result.ok) return err(result.errors);
      return ok({ scanned: 1, indexed: 1, skipped: 0, errors: [] });
    }

    return ok(await this.indexAll({ force: opts?.force ?? false }));
  }

  // --- Audit (git-backed) --------------------------------------------------

  async history(
    id: DocId,
    opts?: { limit?: number; since?: string },
  ): Promise<Result<ParsedCommit[]>> {
    this.assertInit();
    if (!this.gitLayer) return singleErr('GIT_NOT_INITIALIZED', 'Git is not available in this project');

    const doc = this.backend.getDocument(id);
    if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${id as string}" not found`);

    const commits = await this.gitLayer.history(doc.filePath as string, opts);
    return ok(commits);
  }

  async diff(
    id: DocId,
    from: string,
    to?: string,
  ): Promise<Result<DiffResult>> {
    this.assertInit();
    if (!this.gitLayer) return singleErr('GIT_NOT_INITIALIZED', 'Git is not available in this project');

    const doc = this.backend.getDocument(id);
    if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${id as string}" not found`);

    const result = await this.gitLayer.diff(doc.filePath as string, id, from, to);
    if (!result) return singleErr('GIT_ERROR', 'Failed to compute diff');
    return ok(result);
  }

  async snapshot(
    id: DocId,
    at: string,
  ): Promise<Result<SnapshotResult>> {
    this.assertInit();
    if (!this.gitLayer) return singleErr('GIT_NOT_INITIALIZED', 'Git is not available in this project');

    const doc = this.backend.getDocument(id);
    if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${id as string}" not found`);

    const result = await this.gitLayer.snapshot(doc.filePath as string, id, at);
    if (!result) return singleErr('GIT_ERROR', 'Failed to retrieve snapshot');
    return ok(result);
  }

  async audit(opts?: {
    since?: string;
    until?: string;
    docType?: DocType;
  }): Promise<Result<AuditEntry[]>> {
    this.assertInit();
    if (!this.gitLayer) return singleErr('GIT_NOT_INITIALIZED', 'Git is not available in this project');

    const entries = await this.gitLayer.audit(opts);
    return ok(entries);
  }

  // --- Internal ------------------------------------------------------------

  private assertInit(): void {
    if (!this.initialized) {
      throw new Error('MaadEngine not initialized. Call init() first.');
    }
  }

  private async gitCommit(opts: CommitOptions): Promise<void> {
    if (!this.gitLayer) return;
    try {
      await this.gitLayer.commit(opts);
    } catch {
      // Git commit failure is non-fatal — the file write already succeeded
    }
  }

  getBackend(): MaadBackend {
    return this.backend;
  }

  getRegistry(): Registry {
    return this.registry;
  }

  getGitLayer(): GitLayer | null {
    return this.gitLayer;
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }
}

// --- Helpers ---------------------------------------------------------------

function generateDocId(prefix: string, fields: Record<string, unknown>): string {
  const nameOrTitle = fields['name'] ?? fields['title'];
  if (typeof nameOrTitle === 'string') {
    const slug = nameOrTitle
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    if (slug.length > 0) return `${prefix}-${slug}`;
  }
  // Fallback: prefix + timestamp fragment
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10);
  const rand = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
  return `${prefix}-${stamp}-${rand}`;
}

function computeNumericValue(value: unknown, fieldType: string): number | null {
  if (value === null || value === undefined) return null;

  if (fieldType === 'number') {
    const num = typeof value === 'number' ? value : parseFloat(String(value));
    return isFinite(num) ? num : null;
  }

  if (fieldType === 'amount') {
    // "100.00 USD" -> 100.00
    const match = /^([\d,.]+)/.exec(String(value));
    if (match) {
      const num = parseFloat(match[1]!.replace(/,/g, ''));
      return isFinite(num) ? num : null;
    }
    return null;
  }

  // Dates stay as TEXT — ISO format sorts lexicographically correctly
  // Enums and strings don't need numeric values
  return null;
}

async function collectMarkdownFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of glob('**/*.md', { cwd: dirPath })) {
      // Skip _deleted files
      const basename = path.basename(entry as string);
      if (basename.startsWith('_deleted_')) continue;
      files.push(path.join(dirPath, entry as string));
    }
  } catch {
    // glob not available, fallback to readdir
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('_deleted_')) {
        files.push(path.join(dirPath, entry.name));
      }
    }
  }
  return files;
}
