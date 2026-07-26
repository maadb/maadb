// ============================================================================
// Writes — createDocument, updateDocument, deleteDocument
// ============================================================================

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

import { ok, err, singleErr, maadError, type Result } from '../errors.js';
import {
  docId as toDocId,
  filePath as toFilePath,
  type DocId,
  type DocType,
  type FilePath,
  type DocumentRecord,
} from '../types.js';
import { parseMatter } from '../parser/matter.js';
import { parseDocumentFromContent } from '../parser/index.js';
import { validateFrontmatter } from '../schema/index.js';
import { generateDocument, extractBody } from '../writer/index.js';
import type { EngineContext } from './context.js';
import { gitCommit } from './context.js';
import type { CreateResult, UpdateResult, DeleteResult, BulkCreateInput, BulkUpdateInput, BulkResult, BulkVerification, BulkDeleteResult, PurgeSoftDeletedResult, CommitFailureDetail } from './types.js';
import type { CommitOutcome } from '../git/index.js';
import type { ValidationWarning } from '../types.js';
import { indexFile } from './indexing.js';
import { generateDocId, readFrontmatter, toCanonicalRelPath } from './helpers.js';
import { atomicCreate, atomicWrite } from './journal.js';
import { checkDocIdSafe } from './docid-safe.js';
import { isWritePathContainedIn } from './pathguard.js';
import { validateCallerFields, validateStoredIdentity } from './write-boundary.js';

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

export async function createDocument(
  ctx: EngineContext,
  dt: DocType,
  fields: Record<string, unknown>,
  body?: string | undefined,
  customDocId?: string | undefined,
): Promise<Result<CreateResult>> {
  const fieldsViolation = validateCallerFields(fields);
  if (fieldsViolation) {
    return singleErr(fieldsViolation.code, fieldsViolation.message);
  }
  const regType = ctx.registry.types.get(dt);
  if (!regType) return singleErr('UNKNOWN_TYPE', `Type "${dt as string}" not in registry`);

  const schema = ctx.schemaStore.getSchemaForType(dt);
  if (!schema) return singleErr('SCHEMA_NOT_FOUND', `No schema for type "${dt as string}"`);

  const existingIds = ctx.backend.getSampleDocIds(dt, 10000).map(id => id as string);
  const id = customDocId ?? generateDocId(regType.idPrefix, fields, existingIds);

  // 0.7.6 — reject hostile docIds at the boundary. Only
  // customDocId can carry attacker-controlled content; auto-generated IDs are
  // path-safe by construction. Defense-in-depth assertContainedIn fires below
  // before the actual write, so a future bug here can't escape the project.
  const idRejection = checkDocIdSafe(id);
  if (idRejection) {
    return singleErr('INVALID_DOC_ID',
      `docId "${id}" rejected: ${idRejection.message}`,
      undefined,
      { reason: idRejection.reason },
    );
  }

  if (ctx.backend.getDocument(toDocId(id))) {
    return singleErr('DUPLICATE_DOC_ID', `Document "${id}" already exists`);
  }

  const frontmatter: Record<string, unknown> = {
    ...fields,
    doc_id: id,
    doc_type: dt as string,
    schema: regType.schemaRef as string,
  };

  const validation = validateFrontmatter(frontmatter, schema, ctx.registry, undefined, { mode: 'write' });
  if (!validation.valid) {
    return err(validation.errors.map(e => maadError('VALIDATION_FAILED', `${e.field}: ${e.message}`)));
  }

  const markdown = generateDocument(frontmatter, schema, body);

  const dirPath = path.join(ctx.projectRoot, regType.path);
  if (!isWritePathContainedIn(dirPath, ctx.projectRoot)) {
    return singleErr('PATH_OUTSIDE_PROJECT', `Write directory "${dirPath}" escapes the project root`);
  }
  try {
    if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    return singleErr('WRITE_ERROR', `Failed to create write directory: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isWritePathContainedIn(dirPath, ctx.projectRoot)) {
    return singleErr('PATH_OUTSIDE_PROJECT',
      `Write directory "${dirPath}" escapes the project root through a symbolic link`);
  }

  const fp = path.join(dirPath, `${id}.md`);

  // 0.7.6 — defense-in-depth: assert the resolved write path
  // is contained within the project root. checkDocIdSafe above should have
  // already rejected any traversal attempt; this catches future regressions
  // (e.g., a new code path that bypasses validation) before disk touches.
  if (!isWritePathContainedIn(fp, ctx.projectRoot)) {
    return singleErr('PATH_OUTSIDE_PROJECT',
      `resolved write path "${fp}" is outside project root "${ctx.projectRoot}"`);
  }

  if (existsSync(fp)) {
    return singleErr('DUPLICATE_DOC_ID', `Document "${id}" already exists on disk`);
  }
  // Pre-flight parse: catches frontmatter / profile errors before any disk write,
  // so invalid writes never leave orphan files on disk.
  const preflight = parseDocumentFromContent(markdown, toFilePath(fp), ctx.registry.subtypeMap);
  if (!preflight.ok) {
    return err(preflight.errors.map(e => ({
      ...e,
      details: { ...e.details, docId: id, filePath: fp, fileWritten: false },
    })));
  }

  // Durable write: journal → atomic write → index → git → complete
  const journalId = ctx.journal.begin('create', id, fp);

  try {
    await atomicCreate(fp, markdown);
  } catch (error) {
    ctx.journal.complete(journalId);
    if (isAlreadyExistsError(error)) {
      return singleErr('DUPLICATE_DOC_ID', `Document "${id}" already exists on disk`);
    }
    return singleErr('WRITE_ERROR',
      `Failed to create document "${id}": ${error instanceof Error ? error.message : String(error)}`);
  }
  ctx.journal.advance(journalId, 'file_written');

  const indexResult = await indexFile(ctx, toFilePath(fp));
  if (!indexResult.ok) {
    ctx.journal.advance(journalId, 'file_written'); // stays at file_written
    return err(indexResult.errors.map(e => ({
      ...e,
      details: { ...e.details, docId: id, filePath: fp, fileWritten: true, indexed: false, recoveryHint: 'Run maad reindex to recover' },
    })));
  }
  ctx.journal.advance(journalId, 'indexed');

  const commitOutcome = await gitCommit(ctx, {
    action: 'create',
    docId: toDocId(id),
    docType: dt,
    detail: '',
    summary: String(fields['name'] ?? fields['title'] ?? id),
    files: [fp],
  });
  ctx.journal.advance(journalId, 'committed');
  ctx.journal.complete(journalId);

  const result: CreateResult = {
    docId: toDocId(id),
    filePath: toFilePath(toCanonicalRelPath(ctx.projectRoot, fp)),
    version: 1,
    validation,
    writeDurable: commitOutcome.status !== 'failed',
  };
  if (commitOutcome.status === 'failed') {
    result.commitFailure = { code: commitOutcome.code, message: commitOutcome.message, action: 'create' };
  }
  return ok(result);
}

export async function updateDocument(
  ctx: EngineContext,
  id: DocId,
  fields?: Record<string, unknown> | undefined,
  body?: string | undefined,
  appendBody?: string | undefined,
  expectedVersion?: number | undefined,
  skipGit?: boolean | undefined,
): Promise<Result<UpdateResult>> {
  const doc = ctx.backend.getDocument(id);
  if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${id as string}" not found`);

  if (expectedVersion !== undefined && doc.version !== expectedVersion) {
    return singleErr('VERSION_CONFLICT',
      `Expected version ${expectedVersion} but document is at version ${doc.version}`,
      undefined,
      { expected: expectedVersion, actual: doc.version },
    );
  }

  const schema = ctx.schemaStore.getSchemaForType(doc.docType);
  if (!schema) return singleErr('SCHEMA_NOT_FOUND', `No schema for type "${doc.docType as string}"`);

  const absPath = path.join(ctx.projectRoot, doc.filePath as string);
  if (!isWritePathContainedIn(absPath, ctx.projectRoot)) {
    return singleErr('PATH_OUTSIDE_PROJECT', `Document path "${absPath}" escapes the project root`);
  }

  let raw: string;
  try {
    raw = await readFile(absPath, 'utf-8');
  } catch {
    return singleErr('FILE_READ_ERROR', `Cannot read file: ${absPath}`);
  }

  let currentFm: Record<string, unknown>;
  try {
    currentFm = parseMatter(raw).data as Record<string, unknown>;
  } catch (error) {
    return singleErr('PARSE_ERROR',
      `Cannot parse frontmatter for "${id as string}": ${error instanceof Error ? error.message : String(error)}`);
  }
  const identityViolation = validateStoredIdentity(currentFm, doc);
  if (identityViolation) {
    return singleErr(identityViolation.code, identityViolation.message);
  }
  const changedFields: string[] = [];
  const updatedFm = { ...currentFm };
  if (fields !== undefined) {
    const fieldsViolation = validateCallerFields(fields);
    if (fieldsViolation) {
      return singleErr(fieldsViolation.code, fieldsViolation.message);
    }
    for (const [key, value] of Object.entries(fields)) {
      if (updatedFm[key] !== value) {
        changedFields.push(key);
        updatedFm[key] = value;
      }
    }
  }

  // Safety: ensure core fields were not stripped or corrupted
  const coreFields = ['doc_id', 'doc_type', 'schema'];
  for (const cf of coreFields) {
    if (currentFm[cf] !== undefined && (updatedFm[cf] === undefined || updatedFm[cf] === '')) {
      return singleErr('FRONTMATTER_GUARD', `Update would remove core field "${cf}" — aborting to prevent data loss`);
    }
  }
  for (const req of schema.required) {
    if (currentFm[req] !== undefined && (updatedFm[req] === undefined || updatedFm[req] === '')) {
      return singleErr('FRONTMATTER_GUARD', `Update would remove required field "${req}" — aborting to prevent data loss`);
    }
  }

  const validation = validateFrontmatter(updatedFm, schema, ctx.registry, undefined, {
    mode: 'write',
    changedFields: new Set(changedFields),
  });
  if (!validation.valid) {
    return err(validation.errors.map(e => maadError('VALIDATION_FAILED', `${e.field}: ${e.message}`)));
  }

  let currentBody = extractBody(raw);

  if (body !== undefined) {
    currentBody = body;
  } else if (appendBody !== undefined) {
    currentBody = currentBody.trimEnd() + '\n\n' + appendBody;
  }

  const markdown = generateDocument(updatedFm, schema, currentBody.trim() || undefined);

  // Pre-flight parse: catches frontmatter / profile errors before any disk write,
  // so invalid updates never clobber the existing file.
  const preflight = parseDocumentFromContent(markdown, toFilePath(absPath), ctx.registry.subtypeMap);
  if (!preflight.ok) {
    return err(preflight.errors.map(e => ({
      ...e,
      details: { ...e.details, docId: id as string, filePath: absPath, fileWritten: false },
    })));
  }

  // Durable write: journal → atomic write → index → git → complete
  const journalId = ctx.journal.begin('update', id as string, absPath);

  await atomicWrite(absPath, markdown);
  ctx.journal.advance(journalId, 'file_written');

  const indexResult = await indexFile(ctx, toFilePath(absPath));
  if (!indexResult.ok) {
    return err(indexResult.errors.map(e => ({
      ...e,
      details: { ...e.details, docId: id as string, filePath: absPath, fileWritten: true, indexed: false, recoveryHint: 'Run maad reindex to recover' },
    })));
  }
  ctx.journal.advance(journalId, 'indexed');

  let commitOutcome: CommitOutcome = { status: 'noop' };
  if (!skipGit) {
    const detail = changedFields.length > 0
      ? `fields:${changedFields.join(',')}`
      : (appendBody ? 'body:append' : 'body:replace');
    const summaryStr = changedFields.length > 0
      ? changedFields.map(f => `${f}: ${String(updatedFm[f] ?? '')}`).join(', ')
      : 'Body updated';
    commitOutcome = await gitCommit(ctx, {
      action: 'update',
      docId: id,
      docType: doc.docType,
      detail,
      summary: summaryStr,
      files: [absPath],
    });
  }
  ctx.journal.advance(journalId, 'committed');
  ctx.journal.complete(journalId);

  const newDoc = ctx.backend.getDocument(id);

  const result: UpdateResult = {
    docId: id,
    docType: doc.docType,
    version: newDoc?.version ?? doc.version + 1,
    changedFields,
    validation,
    // In skipGit mode the bulk wrapper owns the commit; report durable here
    // so the inner result reflects the per-record outcome — the bulk path
    // sets its own writeDurable based on its trailing commit.
    writeDurable: commitOutcome.status !== 'failed',
  };
  if (commitOutcome.status === 'failed') {
    result.commitFailure = { code: commitOutcome.code, message: commitOutcome.message, action: 'update' };
  }
  return ok(result);
}

export async function deleteDocument(
  ctx: EngineContext,
  id: DocId,
  mode: 'soft' | 'hard',
  skipGit?: boolean | undefined,
): Promise<Result<DeleteResult>> {
  const doc = ctx.backend.getDocument(id);
  if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${id as string}" not found`);

  const absPath = path.join(ctx.projectRoot, doc.filePath as string);
  if (!isWritePathContainedIn(absPath, ctx.projectRoot)) {
    return singleErr('PATH_OUTSIDE_PROJECT', `Document path "${absPath}" escapes the project root`);
  }

  let currentFm: Record<string, unknown>;
  try {
    currentFm = await readFrontmatter(ctx.projectRoot, doc);
  } catch (error) {
    return singleErr('FILE_READ_ERROR',
      `Cannot read frontmatter for "${id as string}": ${error instanceof Error ? error.message : String(error)}`);
  }
  const identityViolation = validateStoredIdentity(currentFm, doc);
  if (identityViolation) {
    return singleErr(identityViolation.code, identityViolation.message);
  }

  const journalId = ctx.journal.begin('delete', id as string, absPath);

  if (mode === 'hard') {
    try {
      await unlink(absPath);
    } catch {
      return singleErr('DELETE_ERROR', `Failed to delete file: ${absPath}`);
    }
    ctx.backend.removeDocument(id);
  } else {
    const dir = path.dirname(absPath);
    const base = path.basename(absPath);
    const deletedPath = path.join(dir, `_deleted_${base}`);
    if (!isWritePathContainedIn(deletedPath, ctx.projectRoot)) {
      return singleErr('PATH_OUTSIDE_PROJECT', `Deleted-document path "${deletedPath}" escapes the project root`);
    }

    try {
      await rename(absPath, deletedPath);
    } catch {
      return singleErr('DELETE_ERROR', `Failed to rename file: ${absPath}`);
    }

    const updatedDoc: DocumentRecord = {
      ...doc,
      filePath: toFilePath(toCanonicalRelPath(ctx.projectRoot, deletedPath)),
      deleted: true,
      indexedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    ctx.backend.putDocument(updatedDoc);
    // 0.8.0 — soft delete only flips deleted=1; clear the per-block semantic
    // index too so the doc's blocks stop consuming the search candidate pool and
    // the worker stops embedding dead blocks. A later restore + reindex rebuilds
    // them. (Hard delete handles this via removeDocument.)
    ctx.backend.semantic()?.deleteDoc(id as string);
  }

  let commitOutcome: CommitOutcome = { status: 'noop' };
  if (!skipGit) {
    if (mode === 'hard') {
      commitOutcome = await gitCommit(ctx, {
        action: 'delete',
        docId: id,
        docType: doc.docType,
        detail: 'hard',
        summary: `Hard deleted ${id as string}`,
        files: [absPath],
      });
    } else {
      const deletedPath = path.join(path.dirname(absPath), `_deleted_${path.basename(absPath)}`);
      commitOutcome = await gitCommit(ctx, {
        action: 'delete',
        docId: id,
        docType: doc.docType,
        detail: 'soft',
        summary: `Soft deleted ${id as string}`,
        files: [absPath, deletedPath],
      });
    }
  }

  ctx.journal.advance(journalId, 'committed');
  ctx.journal.complete(journalId);

  const result: DeleteResult = {
    docId: id,
    docType: doc.docType,
    mode,
    filePath: doc.filePath,
    // In skipGit mode the bulk wrapper owns the commit; the per-record file
    // mutation is already durable. Bulk path sets its own writeDurable based
    // on the trailing single commit.
    writeDurable: commitOutcome.status !== 'failed',
  };
  if (commitOutcome.status === 'failed') {
    result.commitFailure = { code: commitOutcome.code, message: commitOutcome.message, action: 'delete' };
  }
  return ok(result);
}

/**
 * 0.7.10 — bulk delete with single-commit atomicity. Mirrors the bulkUpdate
 * pattern: each record runs through deleteDocument with skipGit:true, then
 * one trailing commit stages every affected path (the renamed `_deleted_*`
 * for soft, or the unlinked original for hard). Per-record failures collect
 * and do NOT abort the batch.
 */
export async function bulkDelete(
  ctx: EngineContext,
  docIds: string[],
  mode: 'soft' | 'hard',
): Promise<Result<BulkDeleteResult>> {
  const succeeded: BulkDeleteResult['succeeded'] = [];
  const failed: BulkDeleteResult['failed'] = [];
  const allFiles: string[] = [];

  for (const rawId of docIds) {
    const id = toDocId(rawId);
    // Capture the doc BEFORE the delete so we know the original on-disk
    // path even after a soft-delete rename has moved the row's file_path.
    const docBefore = ctx.backend.getDocument(id);
    const originalAbsPath = docBefore
      ? path.join(ctx.projectRoot, docBefore.filePath as string)
      : null;

    const result = await deleteDocument(ctx, id, mode, true);
    if (!result.ok) {
      failed.push({ docId: rawId, error: result.errors.map(e => e.message).join('; ') });
      continue;
    }

    succeeded.push({
      docId: rawId,
      docType: result.value.docType as string,
      filePath: result.value.filePath as string,
      mode,
    });

    if (originalAbsPath) {
      if (mode === 'hard') {
        allFiles.push(originalAbsPath);
      } else {
        const dir = path.dirname(originalAbsPath);
        const base = path.basename(originalAbsPath);
        allFiles.push(originalAbsPath);
        allFiles.push(path.join(dir, `_deleted_${base}`));
      }
    }
  }

  let commitFailure: CommitFailureDetail | undefined;
  let writeDurable = true;
  const first = succeeded[0];
  if (first) {
    const outcome = await gitCommit(ctx, {
      action: 'delete',
      docId: toDocId(first.docId),
      docType: first.docType as DocType,
      detail: `bulk:${mode}:${succeeded.length}`,
      summary: `Bulk ${mode}-deleted ${succeeded.length} records`,
      files: allFiles,
    });
    if (outcome.status === 'failed') {
      writeDurable = false;
      commitFailure = { code: outcome.code, message: outcome.message, action: 'delete' };
    }
  }

  const out: BulkDeleteResult = {
    succeeded,
    failed,
    totalRequested: docIds.length,
    writeDurable,
  };
  if (commitFailure) out.commitFailure = commitFailure;
  return ok(out);
}

// ---- Bulk operations ------------------------------------------------------

export async function bulkCreate(
  ctx: EngineContext,
  records: BulkCreateInput[],
): Promise<Result<BulkResult>> {
  const succeeded: BulkResult['succeeded'] = [];
  const failed: BulkResult['failed'] = [];
  const allFiles: string[] = [];

  let i = -1;
  for (const rec of records) {
    i++;
    const dt = rec.docType as DocType;
    const regType = ctx.registry.types.get(dt);
    if (!regType) {
      failed.push({ index: i, docId: rec.docId ?? null, error: `Type "${rec.docType}" not in registry` });
      continue;
    }

    const schema = ctx.schemaStore.getSchemaForType(dt);
    if (!schema) {
      failed.push({ index: i, docId: rec.docId ?? null, error: `No schema for type "${rec.docType}"` });
      continue;
    }
    const fieldsViolation = validateCallerFields(rec.fields);
    if (fieldsViolation) {
      failed.push({ index: i, docId: rec.docId ?? null, error: `${fieldsViolation.code}: ${fieldsViolation.message}` });
      continue;
    }

    const existingIds = [
      ...ctx.backend.getSampleDocIds(dt, 10000).map(id => id as string),
      ...succeeded.map(s => s.docId),
    ];
    const id = rec.docId ?? generateDocId(regType.idPrefix, rec.fields, existingIds);

    // 0.7.6 — same boundary check as createDocument.
    const idRejection = checkDocIdSafe(id);
    if (idRejection) {
      failed.push({ index: i, docId: id, error: `INVALID_DOC_ID: ${idRejection.message}` });
      continue;
    }

    if (ctx.backend.getDocument(toDocId(id))) {
      failed.push({ index: i, docId: id, error: `Document "${id}" already exists` });
      continue;
    }

    const frontmatter: Record<string, unknown> = {
      ...rec.fields,
      doc_id: id,
      doc_type: rec.docType,
      schema: regType.schemaRef as string,
    };

    const validation = validateFrontmatter(frontmatter, schema, ctx.registry, undefined, { mode: 'write' });
    if (!validation.valid) {
      const msg = validation.errors.map(e => `${e.field}: ${e.message}`).join('; ');
      failed.push({ index: i, docId: id, error: msg });
      continue;
    }

    const markdown = generateDocument(frontmatter, schema, rec.body);
    const dirPath = path.join(ctx.projectRoot, regType.path);
    if (!isWritePathContainedIn(dirPath, ctx.projectRoot)) {
      failed.push({ index: i, docId: id, error: `PATH_OUTSIDE_PROJECT: write directory "${dirPath}" escapes the project root` });
      continue;
    }
    try {
      if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
    } catch (error) {
      failed.push({ index: i, docId: id, error: `WRITE_ERROR: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (!isWritePathContainedIn(dirPath, ctx.projectRoot)) {
      failed.push({ index: i, docId: id, error: `PATH_OUTSIDE_PROJECT: write directory "${dirPath}" escapes through a symbolic link` });
      continue;
    }
    const fp = path.join(dirPath, `${id}.md`);

    // 0.7.6 — defense-in-depth path containment.
    if (!isWritePathContainedIn(fp, ctx.projectRoot)) {
      failed.push({ index: i, docId: id, error: `PATH_OUTSIDE_PROJECT: resolved write path "${fp}" is outside project root` });
      continue;
    }
    if (existsSync(fp)) {
      failed.push({ index: i, docId: id, error: `DUPLICATE_DOC_ID: Document "${id}" already exists on disk` });
      continue;
    }

    // Pre-flight parse: keep invalid records out of the batch before touching disk.
    const preflight = parseDocumentFromContent(markdown, toFilePath(fp), ctx.registry.subtypeMap);
    if (!preflight.ok) {
      failed.push({ index: i, docId: id, error: preflight.errors.map(e => e.message).join('; ') });
      continue;
    }

    try {
      await atomicCreate(fp, markdown);
    } catch (e) {
      const error = isAlreadyExistsError(e)
        ? `DUPLICATE_DOC_ID: Document "${id}" already exists on disk`
        : `WRITE_ERROR: ${e instanceof Error ? e.message : String(e)}`;
      failed.push({ index: i, docId: id, error });
      continue;
    }

    const indexResult = await indexFile(ctx, toFilePath(fp));
    if (!indexResult.ok) {
      failed.push({ index: i, docId: id, error: `Index failed: ${indexResult.errors.map(e => e.message).join('; ')}` });
      continue;
    }

    allFiles.push(fp);
    const entry: BulkResult['succeeded'][number] = {
      index: i,
      docId: id,
      docType: rec.docType,
      filePath: path.relative(ctx.projectRoot, fp),
      version: 1,
    };
    if (validation.warnings.length > 0) entry.warnings = validation.warnings;
    succeeded.push(entry);
  }

  // Single git commit for all succeeded records
  const first = succeeded[0];
  let commitFailure: CommitFailureDetail | undefined;
  let writeDurable = true;
  if (first) {
    const firstRec = records[first.index];
    const outcome = await gitCommit(ctx, {
      action: 'create',
      docId: toDocId(first.docId),
      docType: (firstRec?.docType ?? 'unknown') as DocType,
      detail: `bulk:${succeeded.length}`,
      summary: `Bulk created ${succeeded.length} records`,
      files: allFiles,
    });
    if (outcome.status === 'failed') {
      writeDurable = false;
      commitFailure = { code: outcome.code, message: outcome.message, action: 'create' };
    }
  }

  const verification = await verifyBulkResults(ctx, succeeded, records.map(r => ({ fields: r.fields, body: r.body })));
  const warnings = aggregateBulkWarnings(succeeded);

  const result: BulkResult = { succeeded, failed, totalRequested: records.length, verification, warnings, writeDurable };
  if (commitFailure) result.commitFailure = commitFailure;
  return ok(result);
}

export async function bulkUpdate(
  ctx: EngineContext,
  updates: BulkUpdateInput[],
): Promise<Result<BulkResult>> {
  const succeeded: BulkResult['succeeded'] = [];
  const failed: BulkResult['failed'] = [];
  const allFiles: string[] = [];

  let j = -1;
  for (const upd of updates) {
    j++;
    const result = await updateDocument(
      ctx,
      upd.docId as DocId,
      upd.fields,
      upd.body,
      upd.appendBody,
      undefined, // no expectedVersion in bulk
      true,      // skipGit — single commit at the end
    );

    if (result.ok) {
      const doc = ctx.backend.getDocument(upd.docId as DocId);
      const fp = doc ? path.join(ctx.projectRoot, doc.filePath as string) : '';
      allFiles.push(fp);
      const entry: BulkResult['succeeded'][number] = {
        index: j,
        docId: upd.docId,
        docType: (doc?.docType ?? 'unknown') as string,
        filePath: doc?.filePath as string ?? '',
        version: result.value.version,
      };
      if (result.value.validation.warnings.length > 0) {
        entry.warnings = result.value.validation.warnings;
      }
      succeeded.push(entry);
    } else {
      failed.push({
        index: j,
        docId: upd.docId,
        error: result.errors.map(e => e.message).join('; '),
      });
    }
  }

  // Single git commit for all succeeded records
  const first = succeeded[0];
  let commitFailure: CommitFailureDetail | undefined;
  let writeDurable = true;
  if (first) {
    const firstDoc = ctx.backend.getDocument(first.docId as DocId);
    const outcome = await gitCommit(ctx, {
      action: 'update',
      docId: toDocId(first.docId),
      docType: firstDoc?.docType ?? ('unknown' as DocType),
      detail: `bulk:${succeeded.length}`,
      summary: `Bulk updated ${succeeded.length} records`,
      files: allFiles,
    });
    if (outcome.status === 'failed') {
      writeDurable = false;
      commitFailure = { code: outcome.code, message: outcome.message, action: 'update' };
    }
  }

  const verification = await verifyBulkResults(ctx, succeeded, updates.map(u => ({ fields: u.fields ?? {}, body: u.body, appendBody: u.appendBody })));
  const warnings = aggregateBulkWarnings(succeeded);

  const result: BulkResult = { succeeded, failed, totalRequested: updates.length, verification, warnings, writeDurable };
  if (commitFailure) result.commitFailure = commitFailure;
  return ok(result);
}

/**
 * Flatten per-record warnings into a single array, prefixing `field` with
 * `{docId}.` so callers reading the top-level `warnings` channel can trace
 * each entry back to its record without cross-referencing.
 */
function aggregateBulkWarnings(succeeded: BulkResult['succeeded']): ValidationWarning[] {
  const out: ValidationWarning[] = [];
  for (const entry of succeeded) {
    if (!entry.warnings) continue;
    for (const w of entry.warnings) {
      out.push({ ...w, field: `${entry.docId}.${w.field}` });
    }
  }
  return out;
}

// ---- Read-back verification ------------------------------------------------

interface VerifyInput {
  fields: Record<string, unknown>;
  body?: string | undefined;
  appendBody?: string | undefined;
}

async function verifyBulkResults(
  ctx: EngineContext,
  succeeded: BulkResult['succeeded'],
  inputs: VerifyInput[],
): Promise<BulkVerification> {
  if (succeeded.length === 0) return { sampledIds: [], sampled: 0, passed: 0, mismatches: [] };

  // Deterministic sampling: all for ≤20, evenly spaced 10 for larger batches
  let sampleIndices: number[];
  if (succeeded.length <= 20) {
    sampleIndices = succeeded.map((_, i) => i);
  } else {
    const step = succeeded.length / 10;
    sampleIndices = [];
    for (let i = 0; i < 10; i++) {
      sampleIndices.push(Math.floor(i * step));
    }
  }

  const mismatches: BulkVerification['mismatches'] = [];
  const sampledIds: string[] = [];
  let passed = 0;

  for (const idx of sampleIndices) {
    const entry = succeeded[idx];
    if (!entry) continue;
    sampledIds.push(entry.docId);
    const input = inputs[entry.index];
    if (!input) { passed++; continue; }

    // 1. Verify document exists in backend index
    const doc = ctx.backend.getDocument(toDocId(entry.docId));
    if (!doc) {
      mismatches.push({ docId: entry.docId, field: '_index', expected: 'indexed', actual: 'not in backend' });
      continue;
    }

    // 2. Read frontmatter from disk and compare fields
    let fm: Record<string, unknown>;
    let rawBody: string | undefined;
    try {
      const absPath = path.join(ctx.projectRoot, doc.filePath as string);
      const raw = await readFile(absPath, 'utf-8');
      fm = parseMatter(raw).data as Record<string, unknown>;
      rawBody = extractBody(raw);
    } catch {
      mismatches.push({ docId: entry.docId, field: '_readable', expected: 'readable', actual: 'file read failed' });
      continue;
    }

    let docClean = true;

    for (const [key, expected] of Object.entries(input.fields)) {
      const actual = fm[key];
      if (!valuesMatch(expected, actual)) {
        mismatches.push({ docId: entry.docId, field: key, expected, actual: actual ?? null });
        docClean = false;
      }
    }

    // 3. Verify body if provided
    if (input.body !== undefined && rawBody !== undefined) {
      if (input.body.trim() !== rawBody.trim()) {
        mismatches.push({ docId: entry.docId, field: '_body', expected: `${input.body.length} chars`, actual: `${rawBody.length} chars` });
        docClean = false;
      }
    }
    if (input.appendBody !== undefined && rawBody !== undefined) {
      if (!rawBody.includes(input.appendBody.trim())) {
        mismatches.push({ docId: entry.docId, field: '_appendBody', expected: 'content present', actual: 'appended content not found' });
        docClean = false;
      }
    }

    // 4. Verify indexed fields match field_index
    const indexedFieldNames = Object.keys(input.fields);
    if (indexedFieldNames.length > 0) {
      const fieldValues = ctx.backend.getFieldValues([toDocId(entry.docId)], indexedFieldNames);
      const stored = fieldValues.get(entry.docId) ?? {};
      for (const [key, expected] of Object.entries(input.fields)) {
        const indexedValue = stored[key];
        if (indexedValue !== undefined && !valuesMatch(expected, indexedValue)) {
          mismatches.push({ docId: entry.docId, field: `_index.${key}`, expected, actual: indexedValue });
          docClean = false;
        }
      }
    }

    if (docClean) passed++;
  }

  return { sampledIds, sampled: sampledIds.length, passed, mismatches };
}

/** Canonical comparison that handles dates, arrays, and type coercion from gray-matter */
function valuesMatch(expected: unknown, actual: unknown): boolean {
  // Both nullish
  if (expected == null && actual == null) return true;
  if (expected == null || actual == null) return false;

  // Date handling: with the string-preserving YAML engine (parser/matter.ts),
  // parsed frontmatter values stay as strings. Dates only appear here if a
  // caller passed `new Date(...)` directly. When they do, accept either the
  // full ISO or the day-form representation on the opposite side — the
  // day-form arm keeps callers that read values before 0.6.7 compatible.
  if (actual instanceof Date) {
    const full = actual.toISOString();
    return String(expected) === full || String(expected) === full.slice(0, 10);
  }
  if (expected instanceof Date) {
    const full = expected.toISOString();
    return String(actual) === full || String(actual) === full.slice(0, 10);
  }

  // Arrays: deep compare via JSON
  if (Array.isArray(expected) && Array.isArray(actual)) {
    return JSON.stringify(expected) === JSON.stringify(actual);
  }

  // Numeric: compare as numbers if both are numeric
  if (typeof expected === 'number' && typeof actual === 'number') {
    return expected === actual;
  }
  if (typeof expected === 'number' && typeof actual === 'string') {
    return String(expected) === actual;
  }
  if (typeof expected === 'string' && typeof actual === 'number') {
    return expected === String(actual);
  }

  // Boolean
  if (typeof expected === 'boolean' || typeof actual === 'boolean') {
    return expected === actual;
  }

  // String fallback
  return String(expected) === String(actual);
}

/**
 * 0.7.10 — Hard-delete soft-deleted records older than the retention
 * threshold. Walks `findSoftDeletedBefore(olderThanIso, maxRecords)`, unlinks
 * each `_deleted_<file>.md` from disk, removes the row via the backend's
 * CASCADE-aware `removeDocument` (clears objects / relationships / blocks /
 * field_index in the same statement), and stages every removed path into a
 * single trailing commit. `scanned` reports the total matched before
 * maxRecords clipping — when scanned > purged.length the operator can see
 * the cemetery is bigger than the cap and chunk subsequent calls.
 */
export async function purgeSoftDeleted(
  ctx: EngineContext,
  olderThanIso: string,
  maxRecords: number,
): Promise<Result<PurgeSoftDeletedResult>> {
  // Probe scanned-count with a wider window so the result surfaces the true
  // cemetery size, not the clipped page. Cheap — same indexed query, larger
  // LIMIT. We materialize the clipped page separately for the purge itself.
  const allMatching = ctx.backend.findSoftDeletedBefore(olderThanIso, Number.MAX_SAFE_INTEGER);
  const scanned = allMatching.length;
  const targets = allMatching.slice(0, maxRecords);

  const purged: PurgeSoftDeletedResult['purged'] = [];
  const failed: PurgeSoftDeletedResult['failed'] = [];
  const allFiles: string[] = [];

  for (const doc of targets) {
    const absPath = path.join(ctx.projectRoot, doc.filePath as string);
    if (!isWritePathContainedIn(absPath, ctx.projectRoot)) {
      failed.push({
        docId: doc.docId as string,
        error: `PATH_OUTSIDE_PROJECT: document path "${absPath}" escapes the project root`,
      });
      continue;
    }
    try {
      await unlink(absPath);
    } catch (e) {
      // File already gone — the row should still be cleared so the index
      // doesn't keep pointing at a missing file. Continue but record the
      // failure so the caller can audit.
      failed.push({
        docId: doc.docId as string,
        error: `Failed to unlink ${absPath}: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    try {
      ctx.backend.removeDocument(doc.docId);
    } catch (e) {
      failed.push({
        docId: doc.docId as string,
        error: `Failed to remove document row: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    purged.push({
      docId: doc.docId as string,
      docType: doc.docType as string,
      filePath: doc.filePath as string,
    });
    allFiles.push(absPath);
  }

  let commitFailure: CommitFailureDetail | undefined;
  let writeDurable = true;
  const first = purged[0];
  if (first) {
    const outcome = await gitCommit(ctx, {
      action: 'delete',
      docId: toDocId(first.docId),
      docType: first.docType as DocType,
      detail: `purge:${purged.length}`,
      summary: `Purged ${purged.length} soft-deleted records older than ${olderThanIso}`,
      files: allFiles,
    });
    if (outcome.status === 'failed') {
      writeDurable = false;
      commitFailure = { code: outcome.code, message: outcome.message, action: 'delete' };
    }
  }

  const result: PurgeSoftDeletedResult = {
    purged,
    failed,
    scanned,
    retentionThresholdIso: olderThanIso,
    writeDurable,
  };
  if (commitFailure) result.commitFailure = commitFailure;
  return ok(result);
}
