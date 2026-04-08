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
import { validateFrontmatter } from '../schema/index.js';
import { generateDocument, extractBody } from '../writer/index.js';
import type { EngineContext } from './context.js';
import { gitCommit } from './context.js';
import type { CreateResult, UpdateResult, DeleteResult, BulkCreateInput, BulkUpdateInput, BulkResult } from './types.js';
import { indexFile } from './indexing.js';
import { generateDocId, readFrontmatter } from './helpers.js';
import { atomicWrite } from './journal.js';

export async function createDocument(
  ctx: EngineContext,
  dt: DocType,
  fields: Record<string, unknown>,
  body?: string | undefined,
  customDocId?: string | undefined,
): Promise<Result<CreateResult>> {
  const regType = ctx.registry.types.get(dt);
  if (!regType) return singleErr('UNKNOWN_TYPE', `Type "${dt as string}" not in registry`);

  const schema = ctx.schemaStore.getSchemaForType(dt);
  if (!schema) return singleErr('SCHEMA_NOT_FOUND', `No schema for type "${dt as string}"`);

  const existingIds = ctx.backend.getSampleDocIds(dt, 10000).map(id => id as string);
  const id = customDocId ?? generateDocId(regType.idPrefix, fields, existingIds);

  if (ctx.backend.getDocument(toDocId(id))) {
    return singleErr('DUPLICATE_DOC_ID', `Document "${id}" already exists`);
  }

  const frontmatter: Record<string, unknown> = {
    doc_id: id,
    doc_type: dt as string,
    schema: regType.schemaRef as string,
    ...fields,
  };

  const validation = validateFrontmatter(frontmatter, schema, ctx.registry);
  if (!validation.valid) {
    return err(validation.errors.map(e => maadError('VALIDATION_FAILED', `${e.field}: ${e.message}`)));
  }

  const markdown = generateDocument(frontmatter, schema, body);

  const dirPath = path.join(ctx.projectRoot, regType.path);
  if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });

  const fp = path.join(dirPath, `${id}.md`);

  // Durable write: journal → atomic write → index → git → complete
  const journalId = ctx.journal.begin('create', id, fp);

  await atomicWrite(fp, markdown);
  ctx.journal.advance(journalId, 'file_written');

  const indexResult = await indexFile(ctx, toFilePath(fp));
  if (!indexResult.ok) {
    ctx.journal.advance(journalId, 'file_written'); // stays at file_written
    return err(indexResult.errors.map(e => ({
      ...e,
      details: { ...e.details, fileWritten: true, indexed: false, recoveryHint: 'Run maad reindex to recover' },
    })));
  }
  ctx.journal.advance(journalId, 'indexed');

  await gitCommit(ctx, {
    action: 'create',
    docId: toDocId(id),
    docType: dt,
    detail: '',
    summary: String(fields['name'] ?? fields['title'] ?? id),
    files: [fp],
  });
  ctx.journal.advance(journalId, 'committed');
  ctx.journal.complete(journalId);

  return ok({
    docId: toDocId(id),
    filePath: toFilePath(path.relative(ctx.projectRoot, fp)),
    version: 1,
    validation,
  });
}

export async function updateDocument(
  ctx: EngineContext,
  id: DocId,
  fields?: Record<string, unknown> | undefined,
  body?: string | undefined,
  appendBody?: string | undefined,
  expectedVersion?: number | undefined,
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
  let raw: string;
  try {
    raw = await readFile(absPath, 'utf-8');
  } catch {
    return singleErr('FILE_READ_ERROR', `Cannot read file: ${absPath}`);
  }

  const currentFm = await readFrontmatter(ctx.projectRoot, doc);
  const changedFields: string[] = [];
  const updatedFm = { ...currentFm };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (updatedFm[key] !== value) {
        changedFields.push(key);
        updatedFm[key] = value;
      }
    }
  }

  const validation = validateFrontmatter(updatedFm, schema, ctx.registry);
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

  // Durable write: journal → atomic write → index → git → complete
  const journalId = ctx.journal.begin('update', id as string, absPath);

  await atomicWrite(absPath, markdown);
  ctx.journal.advance(journalId, 'file_written');

  const indexResult = await indexFile(ctx, toFilePath(absPath));
  if (!indexResult.ok) {
    return err(indexResult.errors.map(e => ({
      ...e,
      details: { ...e.details, fileWritten: true, indexed: false, recoveryHint: 'Run maad reindex to recover' },
    })));
  }
  ctx.journal.advance(journalId, 'indexed');

  const detail = changedFields.length > 0
    ? `fields:${changedFields.join(',')}`
    : (appendBody ? 'body:append' : 'body:replace');
  const summaryStr = changedFields.length > 0
    ? changedFields.map(f => `${f}: ${String(updatedFm[f] ?? '')}`).join(', ')
    : 'Body updated';
  await gitCommit(ctx, {
    action: 'update',
    docId: id,
    docType: doc.docType,
    detail,
    summary: summaryStr,
    files: [absPath],
  });
  ctx.journal.advance(journalId, 'committed');
  ctx.journal.complete(journalId);

  const newDoc = ctx.backend.getDocument(id);

  return ok({
    docId: id,
    version: newDoc?.version ?? doc.version + 1,
    changedFields,
    validation,
  });
}

export async function deleteDocument(ctx: EngineContext, id: DocId, mode: 'soft' | 'hard'): Promise<Result<DeleteResult>> {
  const doc = ctx.backend.getDocument(id);
  if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${id as string}" not found`);

  const absPath = path.join(ctx.projectRoot, doc.filePath as string);
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
    try {
      await rename(absPath, deletedPath);
    } catch {
      return singleErr('DELETE_ERROR', `Failed to rename file: ${absPath}`);
    }

    const updatedDoc: DocumentRecord = {
      ...doc,
      filePath: toFilePath(path.relative(ctx.projectRoot, deletedPath)),
      deleted: true,
      indexedAt: new Date().toISOString(),
    };
    ctx.backend.putDocument(updatedDoc);
  }

  if (mode === 'hard') {
    await gitCommit(ctx, {
      action: 'delete',
      docId: id,
      docType: doc.docType,
      detail: 'hard',
      summary: `Hard deleted ${id as string}`,
      files: [absPath],
    });
  } else {
    const deletedPath = path.join(path.dirname(absPath), `_deleted_${path.basename(absPath)}`);
    await gitCommit(ctx, {
      action: 'delete',
      docId: id,
      docType: doc.docType,
      detail: 'soft',
      summary: `Soft deleted ${id as string}`,
      files: [absPath, deletedPath],
    });
  }

  ctx.journal.advance(journalId, 'committed');
  ctx.journal.complete(journalId);

  return ok({
    docId: id,
    mode,
    filePath: doc.filePath,
  });
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

    const existingIds = [
      ...ctx.backend.getSampleDocIds(dt, 10000).map(id => id as string),
      ...succeeded.map(s => s.docId),
    ];
    const id = rec.docId ?? generateDocId(regType.idPrefix, rec.fields, existingIds);

    if (ctx.backend.getDocument(toDocId(id))) {
      failed.push({ index: i, docId: id, error: `Document "${id}" already exists` });
      continue;
    }

    const frontmatter: Record<string, unknown> = {
      doc_id: id,
      doc_type: rec.docType,
      schema: regType.schemaRef as string,
      ...rec.fields,
    };

    const validation = validateFrontmatter(frontmatter, schema, ctx.registry);
    if (!validation.valid) {
      const msg = validation.errors.map(e => `${e.field}: ${e.message}`).join('; ');
      failed.push({ index: i, docId: id, error: msg });
      continue;
    }

    const markdown = generateDocument(frontmatter, schema, rec.body);
    const dirPath = path.join(ctx.projectRoot, regType.path);
    if (!existsSync(dirPath)) mkdirSync(dirPath, { recursive: true });
    const fp = path.join(dirPath, `${id}.md`);

    try {
      await atomicWrite(fp, markdown);
    } catch (e) {
      failed.push({ index: i, docId: id, error: `File write failed: ${e instanceof Error ? e.message : String(e)}` });
      continue;
    }

    const indexResult = await indexFile(ctx, toFilePath(fp));
    if (!indexResult.ok) {
      failed.push({ index: i, docId: id, error: `Index failed: ${indexResult.errors.map(e => e.message).join('; ')}` });
      continue;
    }

    allFiles.push(fp);
    succeeded.push({
      index: i,
      docId: id,
      filePath: path.relative(ctx.projectRoot, fp),
      version: 1,
    });
  }

  // Single git commit for all succeeded records
  const first = succeeded[0];
  if (first) {
    const firstRec = records[first.index];
    await gitCommit(ctx, {
      action: 'create',
      docId: toDocId(first.docId),
      docType: (firstRec?.docType ?? 'unknown') as DocType,
      detail: `bulk:${succeeded.length}`,
      summary: `Bulk created ${succeeded.length} records`,
      files: allFiles,
    });
  }

  return ok({ succeeded, failed, totalRequested: records.length });
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
    );

    if (result.ok) {
      const doc = ctx.backend.getDocument(upd.docId as DocId);
      const fp = doc ? path.join(ctx.projectRoot, doc.filePath as string) : '';
      allFiles.push(fp);
      succeeded.push({
        index: j,
        docId: upd.docId,
        filePath: doc?.filePath as string ?? '',
        version: result.value.version,
      });
    } else {
      failed.push({
        index: j,
        docId: upd.docId,
        error: result.errors.map(e => e.message).join('; '),
      });
    }
  }

  // Note: individual updates already git-commit. For bulk, this is a known limitation —
  // each update goes through the full pipeline including git. A future optimization
  // could batch git commits, but it requires refactoring updateDocument to accept a skipGit flag.

  return ok({ succeeded, failed, totalRequested: updates.length });
}
