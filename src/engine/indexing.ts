// ============================================================================
// Indexing — indexAll, indexFile, processDocument, reindex
// ============================================================================

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { ok, err, singleErr, type Result } from '../errors.js';
import {
  docId as toDocId,
  docType as toDocType,
  filePath as toFilePath,
  type DocId,
  type FilePath,
  type ParsedDocument,
  type BoundDocument,
  type ValidatedField,
  type ExtractionResult,
  type DocumentRecord,
} from '../types.js';
import { parseDocument } from '../parser/index.js';
import { validateFrontmatter } from '../schema/index.js';
import { extract } from '../extractor/index.js';
import type { EngineContext } from './context.js';
import type { IndexResult } from './types.js';
import { collectMarkdownFiles, computeNumericValue } from './helpers.js';

export async function indexAll(ctx: EngineContext, opts?: { force?: boolean }): Promise<IndexResult> {
  const force = opts?.force ?? false;
  const result: IndexResult = { scanned: 0, indexed: 0, skipped: 0, errors: [] };

  const storedHashes = force ? new Map() : ctx.backend.getAllFileHashes();
  const filesOnDisk = new Set<string>();

  for (const [, regType] of ctx.registry.types) {
    const dirPath = path.join(ctx.projectRoot, regType.path);
    if (!existsSync(dirPath)) continue;

    const files = await collectMarkdownFiles(dirPath);

    for (const file of files) {
      result.scanned++;
      const fp = toFilePath(path.relative(ctx.projectRoot, file));
      const absPath = toFilePath(file);
      filesOnDisk.add(fp as string);

      if (!force) {
        const raw = await readFile(file, 'utf-8');
        const currentHash = createHash('sha256').update(raw).digest('hex');
        const storedHash = storedHashes.get(fp);
        if (storedHash === currentHash) {
          result.skipped++;
          continue;
        }
      }

      const indexResult = await indexFile(ctx, absPath);
      if (indexResult.ok) {
        result.indexed++;
      } else {
        result.errors.push(...indexResult.errors);
      }
    }
  }

  // Remove stale backend records
  const allStoredPaths = ctx.backend.getAllFileHashes();
  for (const [storedPath] of allStoredPaths) {
    if (!filesOnDisk.has(storedPath as string)) {
      const doc = ctx.backend.getDocumentByPath(storedPath);
      if (doc) {
        ctx.backend.removeDocument(doc.docId);
      }
    }
  }

  return result;
}

export async function indexFile(ctx: EngineContext, absolutePath: FilePath): Promise<Result<ExtractionResult>> {
  const parsed = await parseDocument(absolutePath, ctx.registry.subtypeMap);
  if (!parsed.ok) return parsed;

  return processDocument(ctx, parsed.value);
}

export function processDocument(ctx: EngineContext, parsed: ParsedDocument): Result<ExtractionResult> {
  const fmDocType = parsed.frontmatter['doc_type'];
  if (typeof fmDocType !== 'string') {
    return singleErr('UNKNOWN_TYPE', `Document has no doc_type in frontmatter: ${parsed.filePath}`);
  }

  const dt = toDocType(fmDocType);
  const schema = ctx.schemaStore.getSchemaForType(dt);
  if (!schema) {
    return singleErr('UNKNOWN_TYPE', `No schema found for doc_type "${fmDocType}"`);
  }

  const fmDocId = parsed.frontmatter['doc_id'];
  if (typeof fmDocId !== 'string') {
    return singleErr('INVALID_DOC_ID', `Document has no doc_id in frontmatter: ${parsed.filePath}`);
  }

  const regType = ctx.registry.types.get(dt);
  if (!regType) {
    return singleErr('UNKNOWN_TYPE', `Type "${fmDocType}" not in registry`);
  }

  // Index mode: structural validation only. Precision enforcement is write-
  // time only — historical records on disk must stay indexable regardless
  // of current schema precision declarations.
  const validation = validateFrontmatter(parsed.frontmatter, schema, ctx.registry, parsed.filePath, { mode: 'index' });

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

  const extraction = extract(bound, schema, ctx.registry);

  const relativePath = path.relative(ctx.projectRoot, parsed.filePath as string);
  const existing = ctx.backend.getDocument(bound.docId);
  // Only bump version when file content actually changed — reindex of unchanged files preserves version
  const contentChanged = !existing || existing.fileHash !== parsed.fileHash;
  const version = existing
    ? (contentChanged ? existing.version + 1 : existing.version)
    : 1;
  const now = new Date().toISOString();
  const docRecord: DocumentRecord = {
    docId: bound.docId,
    docType: bound.docType,
    schemaRef: bound.schemaRef,
    filePath: toFilePath(relativePath),
    fileHash: parsed.fileHash,
    version,
    deleted: false,
    indexedAt: now,
    updatedAt: contentChanged ? now : (existing?.updatedAt ?? now),
  };

  const fieldIndex: Array<{ name: string; value: string; numericValue: number | null; type: string }> = [];
  for (const [name, field] of Object.entries(validatedFields)) {
    if (field.indexed) {
      // List fields: one row per item so filters match individual values
      if (field.fieldType === 'list' && Array.isArray(field.value)) {
        for (const item of field.value) {
          const itemValue = item instanceof Date
            ? item.toISOString()
            : String(item);
          fieldIndex.push({
            name,
            value: itemValue,
            numericValue: computeNumericValue(item, 'string'),
            type: field.fieldType,
          });
        }
      } else {
        const fieldValue = field.value instanceof Date
          ? field.value.toISOString()
          : String(field.value);
        fieldIndex.push({
          name,
          value: fieldValue,
          numericValue: computeNumericValue(field.value, field.fieldType),
          type: field.fieldType,
        });
      }
    }
  }

  ctx.backend.materializeDocument(
    docRecord,
    extraction.objects,
    extraction.relationships,
    parsed.blocks,
    fieldIndex,
  );

  return ok(extraction);
}

export async function reindex(ctx: EngineContext, opts?: { docId?: DocId; force?: boolean }): Promise<Result<IndexResult>> {
  if (opts?.docId) {
    const doc = ctx.backend.getDocument(opts.docId);
    if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${opts.docId as string}" not found`);

    const absPath = path.join(ctx.projectRoot, doc.filePath as string);
    const result = await indexFile(ctx, toFilePath(absPath));
    if (!result.ok) return err(result.errors);
    return ok({ scanned: 1, indexed: 1, skipped: 0, errors: [] });
  }

  return ok(await indexAll(ctx, { force: opts?.force ?? false }));
}
