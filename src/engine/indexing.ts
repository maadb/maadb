// ============================================================================
// Indexing — indexAll, indexFile, processDocument, reindex
// ============================================================================

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { ok, err, singleErr, type Result } from '../errors.js';
import { logger } from './logger.js';
import {
  docId as toDocId,
  docType as toDocType,
  filePath as toFilePath,
  type DocId,
  type DocType,
  type FilePath,
  type ParsedDocument,
  type BoundDocument,
  type ValidatedField,
  type ExtractionResult,
  type DocumentRecord,
  type SchemaDefinition,
} from '../types.js';
import { parseDocument, parseDocumentFromContent, type ParseOptions } from '../parser/index.js';
import { validateFrontmatter } from '../schema/index.js';
import { extract } from '../extractor/index.js';
import type { EngineContext } from './context.js';
import type { IndexResult } from './types.js';
import type { BlockTextInput } from './semantic/types.js';
import { collectMarkdownFiles, computeNumericValue, toCanonicalRelPath } from './helpers.js';

// 0.7.4 — Per-type schema fingerprint covering the indexed
// field set. When a schema edit flips a field's `index: false → true` (or
// adds/removes an indexed field), the fingerprint changes; indexAll detects
// that and force-rebuilds docs of the affected type even when their file
// hashes are unchanged. Closes the silent "indexed: 0, skipped: N" footgun.
//
// Fingerprint covers: indexed field names + their types (so a type-change
// on an indexed field also triggers rebuild). Sorted+joined+hashed; first
// 16 hex chars are plenty of collision resistance for this use.
function computeIndexedFieldFingerprint(schema: SchemaDefinition): string {
  const parts: string[] = [];
  for (const [name, def] of schema.fields) {
    if (def.index) parts.push(`${name}:${def.type}`);
  }
  parts.sort();
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

const SCHEMA_FP_KEY_PREFIX = 'schema_index_fp:';

export async function indexAll(ctx: EngineContext, opts?: { force?: boolean }): Promise<IndexResult> {
  const force = opts?.force ?? false;
  const result: IndexResult = { scanned: 0, indexed: 0, skipped: 0, errors: [] };
  const warnings: string[] = [];

  // 0.7.4 — Detect schema-index changes per type. Types whose fingerprint
  // changed (or was never recorded) join `dirtyTypes`, which overrides the
  // file-hash skip path below so docs of those types reindex even if their
  // markdown is byte-for-byte unchanged.
  const dirtyTypes = new Set<string>();
  const currentFingerprints = new Map<DocType, string>();
  for (const [typeName] of ctx.registry.types) {
    const schema = ctx.schemaStore.getSchemaForType(typeName);
    if (!schema) continue;
    const fp = computeIndexedFieldFingerprint(schema);
    currentFingerprints.set(typeName, fp);
    if (force) {
      dirtyTypes.add(typeName as string);
      continue;
    }
    const stored = ctx.backend.getMeta(`${SCHEMA_FP_KEY_PREFIX}${typeName as string}`);
    if (stored !== fp) dirtyTypes.add(typeName as string);
  }

  // 0.8.1 — types with at least one per-doc index error this run. Their
  // schema fingerprints are NOT persisted below, so a dirty type whose forced
  // rebuild partially failed stays dirty and retries on the next pass
  // (previously the fingerprint persisted anyway and the failed docs
  // hash-skipped forever).
  const typesWithErrors = new Set<string>();

  // 0.8.1 — single snapshot serves both the skip-by-hash lookup and the
  // stale-row sweep (previously fetched twice — two full-table scans, and
  // the force path threw the first away).
  const storedHashes = ctx.backend.getAllFileHashes();
  const filesOnDisk = new Set<string>();
  const byteCap = maxDocBytes();
  const docCountByType = ctx.backend.getStats().documentCountByType;

  for (const [typeName, regType] of ctx.registry.types) {
    const isTypeDirty = dirtyTypes.has(typeName as string);
    const dirPath = path.join(ctx.projectRoot, regType.path);
    if (!existsSync(dirPath)) {
      // 0.8.1 — a missing registered path is only noise for a type with no
      // docs yet; with indexed rows it is the exact registry-mismatch shape
      // that made the sweep prune valid docs (kebab vs underscore dir).
      const indexedCount = docCountByType[typeName as string] ?? 0;
      if (indexedCount > 0) {
        warnings.push(
          `registered path "${regType.path}" for type "${typeName as string}" does not exist on disk, ` +
          `but the index holds ${indexedCount} doc(s) of this type — check the path mapping in _registry/object_types.yaml`,
        );
      }
      continue;
    }

    const collected = await collectMarkdownFiles(dirPath);
    if (collected.usedFallback) {
      warnings.push(
        `glob scan failed under "${regType.path}" — recursive readdir fallback used; ` +
        `if this repeats, check the Node runtime's fs.promises.glob support`,
      );
    }
    // 0.8.1 — empty registered dir while the index holds rows of the type:
    // the registry points somewhere the docs aren't (the registry loader
    // creates missing dirs at load, so a path mismatch usually presents as
    // an empty dir here rather than a missing one).
    if (collected.files.length === 0) {
      const indexedCount = docCountByType[typeName as string] ?? 0;
      if (indexedCount > 0) {
        warnings.push(
          `registered path "${regType.path}" for type "${typeName as string}" contains no markdown files, ` +
          `but the index holds ${indexedCount} doc(s) of this type — check the path mapping in _registry/object_types.yaml`,
        );
      }
      continue;
    }

    for (const file of collected.files) {
      result.scanned++;
      // 0.7.12 — canonical (forward-slash) form for both the skip-by-hash
      // lookup against getAllFileHashes (which now stores '/' post-0.7.12)
      // and the filesOnDisk set used by the stale-row sweep.
      const fp = toFilePath(toCanonicalRelPath(ctx.projectRoot, file));
      const absPath = toFilePath(file);
      filesOnDisk.add(fp as string);

      // 0.8.1 — stat before read: an over-cap file must not be read at all
      // (reading it just to hash-skip defeats the byte backstop), and reading
      // once here lets indexFile parse from content instead of re-reading.
      let raw: string | undefined;
      let overCap = false;
      if (byteCap > 0) {
        try {
          overCap = (await stat(file)).size > byteCap;
        } catch {
          // stat failure falls through; indexFile surfaces the real error.
        }
      }
      if (!overCap) {
        try {
          raw = await readFile(file, 'utf-8');
        } catch {
          // read failure falls through; indexFile surfaces FILE_READ_ERROR.
        }
      }

      // Skip-by-hash only applies when neither --force nor a schema-fingerprint
      // change is in play. Otherwise we rebuild even if disk content matches.
      if (raw !== undefined && !force && !isTypeDirty) {
        const currentHash = createHash('sha256').update(raw).digest('hex');
        const storedHash = storedHashes.get(fp);
        if (storedHash === currentHash) {
          result.skipped++;
          continue;
        }
      }

      const indexResult = await indexFile(ctx, absPath, raw !== undefined ? { raw } : undefined);
      if (indexResult.ok) {
        result.indexed++;
        if (indexResult.value.annotationsTruncated) {
          result.partial = (result.partial ?? 0) + 1;
        }
      } else {
        typesWithErrors.add(typeName as string);
        result.errors.push(...indexResult.errors);
      }
    }
  }

  // Remove stale backend records — but never a row whose file still exists on
  // disk. A stale row with a live file means the file sits outside every
  // scanned registered path (registry path mismatch, glob failure, moved
  // directory): pruning it silently orphans valid data, so keep the row and
  // warn instead. Only rows whose files are genuinely gone are removed.
  let pruned = 0;
  const keptByType = new Map<string, number>();
  for (const [storedPath] of storedHashes) {
    if (filesOnDisk.has(storedPath as string)) continue;
    const doc = ctx.backend.getDocumentByPath(storedPath);
    if (!doc) continue;
    // Row already re-pointed at a scanned file this run (separator/case
    // migration of a legacy path) — nothing stale about it.
    if (filesOnDisk.has(doc.filePath as string)) continue;
    if (existsSync(path.join(ctx.projectRoot, storedPath as string))) {
      keptByType.set(doc.docType as string, (keptByType.get(doc.docType as string) ?? 0) + 1);
      continue;
    }
    ctx.backend.removeDocument(doc.docId);
    pruned++;
  }
  for (const [typeName, count] of keptByType) {
    const regPath = ctx.registry.types.get(toDocType(typeName))?.path ?? '(unregistered)';
    warnings.push(
      `kept ${count} index row(s) of type "${typeName}" whose files exist on disk but were not scanned ` +
      `(registered path: "${regPath}") — not pruned; check the path mapping in _registry/object_types.yaml`,
    );
  }

  // 0.7.4 — Persist current fingerprints AFTER successful rebuild so a
  // crash mid-reindex leaves the prior fingerprint in place; next run sees
  // the diff again and retries. 0.8.1 — same retry contract for per-doc
  // failures: types that errored keep their old fingerprint (stay dirty).
  for (const [typeName, fp] of currentFingerprints) {
    if (typesWithErrors.has(typeName as string)) continue;
    ctx.backend.setMeta(`${SCHEMA_FP_KEY_PREFIX}${typeName as string}`, fp);
  }

  if (dirtyTypes.size > 0) {
    result.rebuiltTypes = [...dirtyTypes].sort();
  }
  if (pruned > 0) result.pruned = pruned;
  if (warnings.length > 0) {
    result.warnings = warnings;
    logger.degraded('engine', 'index_scan_warnings',
      `indexAll completed with ${warnings.length} warning(s) — the registry and the on-disk layout disagree`,
      { warnings });
  }

  // 0.7.17 — refresh planner statistics after a rebuild touched rows. Skipped
  // on a no-op pass (everything hash-skipped) so steady-state reindex polling
  // doesn't pay for an ANALYZE that would change nothing.
  if (result.indexed > 0) {
    ctx.backend.analyze();
  }

  return result;
}

// 0.7.13 — per-doc index-time memory guards. A single document can allocate
// far beyond its own byte size in V8 heap while indexing: the dominant driver
// is body annotation count (each [[type:value|label]] becomes a parsed
// annotation, an extracted object, and often a relationship — all live at once
// alongside the SQLite bind params). A doc with hundreds of thousands of
// annotations can exhaust the heap and FATAL the whole engine process, taking
// every project on it down and crash-looping on restart as reindex re-touches
// the same doc.
//
// Two layered guards, both designed to keep the document FINDABLE rather than
// silently dropping it:
//
//  1. Annotation cap (MAAD_MAX_DOC_ANNOTATIONS, default 50k). Body annotation
//     extraction stops at the cap, so objects/relationships stay bounded. The
//     document record + frontmatter index are still written in full — the doc
//     remains queryable by id and by frontmatter field; only its body objects
//     are partial. Surfaced as IndexResult.partial + a degraded ops event.
//
//  2. Byte backstop (MAAD_MAX_DOC_BYTES, default 16 MiB). For a file so large
//     that even reading + line-splitting it is unsafe, skip entirely with
//     DOC_TOO_LARGE rather than risk the read. 16 MiB is ~28 average novels of
//     text in one file — far past any legitimate record. Set 0 to disable.
const DEFAULT_MAX_DOC_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_DOC_ANNOTATIONS = 50_000;

function maxDocBytes(): number {
  const raw = process.env['MAAD_MAX_DOC_BYTES'];
  if (raw === undefined) return DEFAULT_MAX_DOC_BYTES;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_DOC_BYTES;
  return n; // 0 = disabled
}

function maxDocAnnotations(): number {
  const raw = process.env['MAAD_MAX_DOC_ANNOTATIONS'];
  if (raw === undefined) return DEFAULT_MAX_DOC_ANNOTATIONS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MAX_DOC_ANNOTATIONS;
  return n; // 0 = disabled
}

export async function indexFile(
  ctx: EngineContext,
  absolutePath: FilePath,
  opts?: { raw?: string },
): Promise<Result<ExtractionResult>> {
  // Backstop: a stat is cheap, and reading + line-splitting a multi-hundred-MB
  // file is itself a heap risk before any extraction cap can apply. Skip those.
  // 0.8.1 — when the caller already read the file (indexAll's single-read
  // path), size the in-memory content instead of re-statting.
  const byteCap = maxDocBytes();
  if (byteCap > 0) {
    let sizeBytes = 0;
    if (opts?.raw !== undefined) {
      sizeBytes = Buffer.byteLength(opts.raw, 'utf-8');
    } else {
      try {
        sizeBytes = (await stat(absolutePath as string)).size;
      } catch {
        // stat failure falls through to parseDocument, which surfaces the real
        // FILE_READ_ERROR with proper location info.
        sizeBytes = 0;
      }
    }
    if (sizeBytes > byteCap) {
      // 0.8.1 — a previously indexed doc that grew past the cap keeps serving
      // its last indexed content: the row is deliberately retained (the doc
      // stays findable) but flagged partial so the staleness is queryable
      // instead of invisible.
      const rel = toCanonicalRelPath(ctx.projectRoot, absolutePath as string);
      const existingRow = ctx.backend.getDocumentByPath(toFilePath(rel));
      if (existingRow) ctx.backend.markDocumentStale(existingRow.docId);
      logger.degraded('engine', 'doc_too_large',
        `skipped oversized document (${sizeBytes} bytes > cap ${byteCap}); too large to read safely` +
        (existingRow ? '; existing index row retained at its last indexed content and flagged partial' : ''),
        { file: absolutePath as string, sizeBytes, capBytes: byteCap, staleRowRetained: existingRow !== null });
      return singleErr('DOC_TOO_LARGE',
        `Document ${absolutePath as string} is ${sizeBytes} bytes, over the ${byteCap}-byte read cap (MAAD_MAX_DOC_BYTES). Skipped to protect the engine; split the document or raise the cap with matching heap headroom.`,
        { file: absolutePath, line: 0, col: 0 },
        { sizeBytes, capBytes: byteCap });
    }
  }

  // Bound body annotation extraction so a pathological annotation count can't
  // build an unbounded object/relationship set. The doc still indexes (record
  // + frontmatter + capped body) and stays findable.
  const annoCap = maxDocAnnotations();
  // 0.8.0 — request per-block text only when semantic indexing is on, so a
  // non-semantic parse pays nothing for the extra slicing.
  const parseOpts: ParseOptions = { includeBlockText: ctx.semanticEnabled };
  if (annoCap > 0) parseOpts.maxAnnotations = annoCap;
  const parsed = opts?.raw !== undefined
    ? parseDocumentFromContent(opts.raw, absolutePath, ctx.registry.subtypeMap, parseOpts)
    : await parseDocument(absolutePath, ctx.registry.subtypeMap, parseOpts);
  if (!parsed.ok) return parsed;

  if (parsed.value.annotationsTruncated) {
    logger.degraded('engine', 'doc_body_truncated',
      `indexed with body annotations capped at ${annoCap}; document record + frontmatter are complete, body objects are partial`,
      { file: absolutePath as string, capAnnotations: annoCap });
  }

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
        // 0.8.1 — carried through so list-of-number/amount items get real
        // numeric index values (previously hardcoded to string → null).
        itemType: fieldDef.itemType,
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

  // 0.7.12 — canonicalize file_path to forward slashes at the write boundary
  // so the SQLite index is portable across Windows/POSIX. Helper in
  // engine/helpers.ts is the single source of truth for relative-path
  // canonicalization; reuse it across all write-path sites.
  const relativePath = toCanonicalRelPath(ctx.projectRoot, parsed.filePath as string);
  const existing = ctx.backend.getDocument(bound.docId);

  // 0.8.1 — duplicate-docId guard on the index path. Two live files sharing a
  // doc_id previously collapsed silently: the second one scanned REPLACEd the
  // first's row (registry-iteration order decided the winner) and the loser
  // stayed on disk unindexed. The write path has always rejected this
  // (writes.ts DUPLICATE_DOC_ID); the index path now does too. A row whose old
  // file is gone is a legitimate move and falls through to the normal update.
  // Paths compare in canonical forward-slash form (legacy pre-0.7.12 rows
  // store backslash), case-insensitively on Windows/macOS where one on-disk
  // file answers to both casings — either difference alone is the SAME file
  // lazily migrating, not a collision.
  if (existing) {
    const caseFold = process.platform === 'win32' || process.platform === 'darwin';
    const normalize = (p: string) => {
      const canonical = p.replaceAll('\\', '/');
      return caseFold ? canonical.toLowerCase() : canonical;
    };
    if (normalize(existing.filePath as string) !== normalize(relativePath)) {
      const oldAbs = path.join(ctx.projectRoot, existing.filePath as string);
      if (existsSync(oldAbs)) {
        return singleErr('DUPLICATE_DOC_ID',
          `doc_id "${bound.docId as string}" is claimed by two files: "${existing.filePath as string}" (indexed) and "${relativePath}". ` +
          `The indexed row was left unchanged; fix the duplicate doc_id in one of the files and reindex.`,
          { file: parsed.filePath, line: 0, col: 0 },
          { indexedPath: existing.filePath as string, conflictingPath: relativePath });
      }
    }
  }

  // 0.8.1 — doc_id changed in place (same file, new id in frontmatter). The
  // superseded row is removed explicitly and audibly — previously INSERT OR
  // REPLACE resolved the file_path conflict by silently deleting it as a side
  // effect (and could destroy an unrelated doc's row the same way).
  const existingByPath = ctx.backend.getDocumentByPath(toFilePath(relativePath));
  if (existingByPath && (existingByPath.docId as string) !== (bound.docId as string)) {
    logger.info('engine', 'doc_id_changed_in_place',
      `doc_id at "${relativePath}" changed from "${existingByPath.docId as string}" to "${bound.docId as string}"; superseded index row removed`,
      { filePath: relativePath, oldDocId: existingByPath.docId as string, newDocId: bound.docId as string });
    ctx.backend.removeDocument(existingByPath.docId);
  }
  // Only bump version when file content actually changed — reindex of unchanged files preserves version
  const contentChanged = !existing || existing.fileHash !== parsed.fileHash;
  const version = existing
    ? (contentChanged ? existing.version + 1 : existing.version)
    : 1;
  const now = new Date().toISOString();
  // 0.7.12 — engine-stamped createdAt. Preserve on existing docs (immutable
  // once set), backfill from updatedAt for pre-0.7.12 rows that migrated in
  // with an empty createdAt, and stamp `now` for net-new docs.
  const createdAt = existing
    ? (existing.createdAt || existing.updatedAt || now)
    : now;
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
    createdAt,
    // 0.7.17 — persist index-time structural validity so summary() can COUNT
    // invalid records instead of re-reading every file. `validation` was
    // computed above in mode 'index'.
    valid: validation.valid,
    // 0.8.1 — persist the annotation-cap state so "which docs indexed with
    // partial body objects" survives the run (previously only a transient
    // IndexResult counter + a log line). Clean reindex clears it.
    partial: parsed.annotationsTruncated === true,
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
            // 0.8.1 — use the list's item_type (was hardcoded 'string', so
            // list-of-number/amount items always indexed numericValue null
            // and never matched numeric range filters).
            numericValue: computeNumericValue(item, field.itemType ?? 'string'),
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

  // 0.8.0 — per-block text for the semantic index (FTS + embed queue), persisted
  // atomically inside the materialize transaction. Only built when semantic is
  // on and the parser produced block text; empty blocks (heading-only) are
  // skipped. Single-block docs fall back naturally to one whole-doc block.
  let semanticBlocks: BlockTextInput[] | undefined;
  if (ctx.semanticEnabled && parsed.blockTexts) {
    const texts = parsed.blockTexts;
    semanticBlocks = [];
    parsed.blocks.forEach((b, i) => {
      const text = texts[i] ?? '';
      if (text.length === 0) return;
      semanticBlocks!.push({ blockOrd: i, blockId: b.id as string | null, heading: b.heading, text });
    });
  }

  // 0.8.1 — the targeted upsert in putDocument raises SQLITE_CONSTRAINT on a
  // file_path conflict instead of silently deleting the other doc's row. The
  // guards above resolve every legitimate case, so a throw here is a real
  // collision (or backend fault) that must surface as an indexing error, not
  // escape the engine's Result contract.
  try {
    ctx.backend.materializeDocument(
      docRecord,
      extraction.objects,
      extraction.relationships,
      parsed.blocks,
      fieldIndex,
      semanticBlocks,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return singleErr('BACKEND_ERROR',
      `Failed to materialize "${bound.docId as string}" (${relativePath}): ${message}`,
      { file: parsed.filePath, line: 0, col: 0 });
  }

  // Carry the partial-index signal up so indexAll can tally it. The record +
  // frontmatter above are always written in full; only body objects are capped.
  if (parsed.annotationsTruncated) extraction.annotationsTruncated = true;
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
