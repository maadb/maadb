// ============================================================================
// Maintenance — validate
// ============================================================================

import { ok, singleErr, type Result } from '../errors.js';
import type { DocId } from '../types.js';
import { validateFrontmatter, codePointLength } from '../schema/index.js';
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
  /**
   * 0.12.0 — opt in to scanning every string field with declared structural
   * constraints (max_length / soft_max_length / multiline) and reporting
   * historical records that would fail or warn if written today. The
   * preflight scan for introducing constraints on existing data.
   * Informational; never changes `valid`/`invalid` counts.
   */
  includeConstraints?: boolean;
}

export async function validate(
  ctx: EngineContext,
  docId?: DocId | undefined,
  options?: ValidateOptions,
): Promise<Result<ValidationReport>> {
  const includePrecision = options?.includePrecision ?? false;
  const includeConstraints = options?.includeConstraints ?? false;

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
    if (includeConstraints) {
      report.constraintViolations = collectConstraintViolations(docId, frontmatter, schema);
    }
    return ok(report);
  }

  const report: ValidationReport = { total: 0, valid: 0, invalid: 0, errors: [] };
  const drift: ValidationReport['precisionDrift'] = includePrecision ? [] : undefined;
  const violations: ValidationReport['constraintViolations'] = includeConstraints ? [] : undefined;

  // 0.7.17 — page through every live record instead of a single capped fetch.
  // The prior findDocuments({ limit: 100000 }) silently dropped records past
  // 100k from the audit, undercounting on large projects. PAGE-sized batches
  // keep the audit unbounded while bounding per-iteration memory.
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const page = ctx.backend.findDocuments({ limit: PAGE, offset });
    if (page.length === 0) break;
    for (const match of page) {
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
    if (violations) {
      violations.push(...collectConstraintViolations(doc.docId, frontmatter, schema));
    }
    }
    if (page.length < PAGE) break;
  }

  if (drift) report.precisionDrift = drift;
  if (violations) report.constraintViolations = violations;
  return ok(report);
}

function collectConstraintViolations(
  docId: DocId,
  frontmatter: Record<string, unknown>,
  schema: import('../types.js').SchemaDefinition,
): NonNullable<ValidationReport['constraintViolations']> {
  const out: NonNullable<ValidationReport['constraintViolations']> = [];
  for (const [fieldName, fieldDef] of schema.fields) {
    if (fieldDef.type !== 'string') continue;
    const value = frontmatter[fieldName];
    if (typeof value !== 'string') continue;

    if (fieldDef.multiline === false && /[\r\n]/.test(value)) {
      out.push({ docId, field: fieldName, code: 'FIELD_MULTILINE_NOT_ALLOWED', actual: null, limit: null, severity: 'error' });
    }
    if (fieldDef.maxLength !== null || fieldDef.softMaxLength !== null) {
      const actual = codePointLength(value);
      if (fieldDef.maxLength !== null && actual > fieldDef.maxLength) {
        out.push({ docId, field: fieldName, code: 'FIELD_MAX_LENGTH_EXCEEDED', actual, limit: fieldDef.maxLength, severity: 'error' });
      }
      if (fieldDef.softMaxLength !== null && actual > fieldDef.softMaxLength) {
        out.push({ docId, field: fieldName, code: 'FIELD_SOFT_MAX_LENGTH_EXCEEDED', actual, limit: fieldDef.softMaxLength, severity: 'warning' });
      }
    }
  }
  return out;
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
