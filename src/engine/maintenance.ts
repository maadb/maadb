// ============================================================================
// Maintenance — validate
// ============================================================================

import { ok, singleErr, type Result } from '../errors.js';
import type { DocId } from '../types.js';
import { validateFrontmatter } from '../schema/index.js';
import { detectPrecision, isCoarserThan } from '../schema/precision.js';
import type { EngineContext } from './context.js';
import type { ValidationReport } from './types.js';
import { readFrontmatter } from './helpers.js';

export interface ValidateOptions {
  /**
   * 0.6.7 — opt in to scanning every date field with a declared
   * store_precision and reporting any historical records whose stored value
   * is coarser than the contract. Informational; never changes
   * `valid`/`invalid` counts.
   */
  includePrecision?: boolean;
}

export async function validate(
  ctx: EngineContext,
  docId?: DocId | undefined,
  options?: ValidateOptions,
): Promise<Result<ValidationReport>> {
  const includePrecision = options?.includePrecision ?? false;

  if (docId) {
    const doc = ctx.backend.getDocument(docId);
    if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${docId as string}" not found`);

    const schema = ctx.schemaStore.getSchemaForType(doc.docType);
    if (!schema) return singleErr('SCHEMA_NOT_FOUND', `No schema for type "${doc.docType as string}"`);

    const frontmatter = await readFrontmatter(ctx.projectRoot, doc);
    const result = validateFrontmatter(frontmatter, schema, ctx.registry, undefined, { mode: 'audit' });
    const report: ValidationReport = {
      total: 1,
      valid: result.valid ? 1 : 0,
      invalid: result.valid ? 0 : 1,
      errors: result.valid ? [] : [{ docId, errors: result.errors.map(e => ({ field: e.field, message: e.message })) }],
    };
    if (includePrecision) {
      report.precisionDrift = collectPrecisionDrift(docId, frontmatter, schema);
    }
    return ok(report);
  }

  const allDocs = ctx.backend.findDocuments({ limit: 100000 });
  const report: ValidationReport = { total: 0, valid: 0, invalid: 0, errors: [] };
  const drift: ValidationReport['precisionDrift'] = includePrecision ? [] : undefined;

  for (const match of allDocs) {
    report.total++;
    const doc = ctx.backend.getDocument(match.docId);
    if (!doc) continue;

    const schema = ctx.schemaStore.getSchemaForType(doc.docType);
    if (!schema) {
      report.invalid++;
      report.errors.push({ docId: doc.docId, errors: [{ field: 'doc_type', message: 'No schema found' }] });
      continue;
    }

    const frontmatter = await readFrontmatter(ctx.projectRoot, doc);
    const result = validateFrontmatter(frontmatter, schema, ctx.registry, undefined, { mode: 'audit' });
    if (result.valid) {
      report.valid++;
    } else {
      report.invalid++;
      report.errors.push({ docId: doc.docId, errors: result.errors.map(e => ({ field: e.field, message: e.message })) });
    }

    if (drift) {
      drift.push(...collectPrecisionDrift(doc.docId, frontmatter, schema));
    }
  }

  if (drift) report.precisionDrift = drift;
  return ok(report);
}

function collectPrecisionDrift(
  docId: DocId,
  frontmatter: Record<string, unknown>,
  schema: import('../types.js').SchemaDefinition,
): NonNullable<ValidationReport['precisionDrift']> {
  const out: NonNullable<ValidationReport['precisionDrift']> = [];
  for (const [fieldName, fieldDef] of schema.fields) {
    if (fieldDef.type !== 'date' || fieldDef.storePrecision === null) continue;
    const value = frontmatter[fieldName];
    if (value === undefined || value === null) continue;

    const actual = value instanceof Date
      ? 'millisecond'
      : typeof value === 'string'
        ? detectPrecision(value)
        : null;
    if (actual === null) continue; // malformed — structural handler's concern
    if (!isCoarserThan(actual, fieldDef.storePrecision)) continue;

    out.push({
      docId,
      field: fieldName,
      declared: fieldDef.storePrecision,
      actual,
    });
  }
  return out;
}
