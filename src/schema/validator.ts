// ============================================================================
// Schema Validator
// Validates a document's frontmatter against its bound schema.
// ============================================================================

import type {
  SchemaDefinition,
  Registry,
  ValidationResult,
  ValidationError,
  ValidationWarning,
  FieldDefinition,
  FilePath,
} from '../types.js';
import { detectPrecision, isCoarserThan } from './precision.js';

/**
 * Validator call mode. Determines whether precision enforcement fires.
 *
 * - `write`: create / update / bulk — precision enforced per schema contract.
 * - `read`: read path validation — precision NEVER enforced. Historical
 *   records stay valid regardless of current schema declarations.
 * - `index`: reindex / index-on-load — precision NEVER enforced. Same rule.
 * - `audit`: explicit audit via `maad_validate` — precision drift can be
 *   reported as informational by passing through via
 *   `validateFrontmatter`'s structural errors path, but never counted as
 *   invalid. Kept here as a distinct mode so callers signal intent.
 */
export type ValidationMode = 'write' | 'read' | 'index' | 'audit';

export interface ValidationOptions {
  mode: ValidationMode;
  /** Update-path hint: precision enforcement skips fields NOT in this set. */
  changedFields?: Set<string>;
}

export function validateFrontmatter(
  frontmatter: Record<string, unknown>,
  schema: SchemaDefinition,
  registry: Registry,
  filePath?: FilePath | undefined,
  options?: ValidationOptions,
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const loc = filePath ? { file: filePath, line: 1, col: 1 } : null;
  // Safe default: callers that haven't been updated to the 0.6.7 mode
  // parameter land in 'read' mode, which never fires precision enforcement.
  // Every write-path caller must explicitly opt in to mode: 'write'.
  const mode: ValidationMode = options?.mode ?? 'read';
  const changedFields = options?.changedFields;

  // Check required fields
  for (const req of schema.required) {
    if (req === 'doc_id') {
      if (frontmatter['doc_id'] === undefined || frontmatter['doc_id'] === null) {
        errors.push({ field: 'doc_id', message: 'Required field missing', location: loc });
      }
      continue;
    }
    if (req === 'doc_type' || req === 'schema') continue; // validated elsewhere

    const value = frontmatter[req];
    if (value === undefined || value === null) {
      const fieldDef = schema.fields.get(req);
      if (fieldDef?.defaultValue !== undefined && fieldDef.defaultValue !== null) {
        continue; // has default, skip
      }
      const hint = fieldDef ? describeFieldExpectation(fieldDef, registry) : '';
      errors.push({ field: req, message: `Required field missing${hint}`, location: loc });
    }
  }

  // Validate each field that has a definition
  for (const [fieldName, fieldDef] of schema.fields) {
    const value = frontmatter[fieldName];
    if (value === undefined || value === null) continue; // missing handled by required check

    const fieldErrors = validateField(fieldName, value, fieldDef, registry);
    errors.push(...fieldErrors);

    // Precision enforcement — write-mode only. Never on read / index / audit.
    // Skip unchanged fields on update path (changedFields filter). Skip when
    // structural validation already failed — no point reporting precision on
    // a value the validator will reject anyway.
    if (
      mode === 'write' &&
      fieldErrors.length === 0 &&
      fieldDef.type === 'date' &&
      fieldDef.storePrecision !== null &&
      (changedFields === undefined || changedFields.has(fieldName))
    ) {
      const precEntry = checkPrecision(fieldName, value, fieldDef, loc);
      if (precEntry?.kind === 'error') errors.push(precEntry.entry);
      else if (precEntry?.kind === 'warn') warnings.push(precEntry.entry);
    }

    // 0.12.0 structural constraints — write-mode only, same contract as
    // precision: never on read / index / audit, update-neighbor safe via
    // changedFields, skipped when structural validation already failed.
    // Hard and advisory limits are evaluated independently.
    if (
      mode === 'write' &&
      fieldErrors.length === 0 &&
      fieldDef.type === 'string' &&
      typeof value === 'string' &&
      (changedFields === undefined || changedFields.has(fieldName))
    ) {
      const found = checkConstraints(fieldName, value, fieldDef, loc);
      errors.push(...found.errors);
      warnings.push(...found.warnings);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Precision enforcement for a single date field with a declared
 * `storePrecision`. Returns a validator entry (error or warning) when the
 * actual value is coarser than declared; null otherwise.
 *
 * - Caller is responsible for the write-mode gate.
 * - Date-object values (rare post-Phase-2 string-preserving parser) are
 *   classified as `millisecond` precision.
 * - Strings that fail detection (malformed) are passed through — the
 *   structural validator catches format errors separately.
 */
type PrecisionCheckResult =
  | { kind: 'error'; entry: ValidationError }
  | { kind: 'warn'; entry: ValidationWarning };

function checkPrecision(
  fieldName: string,
  value: unknown,
  fieldDef: FieldDefinition,
  loc: { file: FilePath; line: number; col: number } | null,
): PrecisionCheckResult | null {
  const declared = fieldDef.storePrecision;
  if (declared === null) return null;

  const actual = value instanceof Date
    ? 'millisecond'
    : typeof value === 'string'
      ? detectPrecision(value)
      : null;

  if (actual === null) return null; // malformed — structural validator handles
  if (!isCoarserThan(actual, declared)) return null; // at or finer than declared

  const message =
    `Value "${value instanceof Date ? value.toISOString() : String(value)}" ` +
    `is ${actual}-precision but schema declares store_precision=${declared}`;

  if (fieldDef.onCoarser === 'error') {
    return {
      kind: 'error',
      entry: { field: fieldName, message, location: loc },
    };
  }

  // Default to warn (also covers explicit warn + the case where onCoarser is
  // null while storePrecision is set, which the loader normalizes to 'warn').
  return {
    kind: 'warn',
    entry: {
      field: fieldName,
      message,
      code: 'PRECISION_COARSER_THAN_DECLARED',
      location: loc,
    },
  };
}

/**
 * Length in Unicode code points — the constraint contract's measurement unit
 * (language-neutral; what Python len() sees). NOT UTF-16 units, NOT grapheme
 * clusters. Values are measured as stored; no normalization.
 */
export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

/**
 * 0.12.0 structural constraints for a string field. Caller is responsible
 * for the write-mode / changedFields / structurally-valid gates.
 */
function checkConstraints(
  fieldName: string,
  value: string,
  fieldDef: FieldDefinition,
  loc: { file: FilePath; line: number; col: number } | null,
): { errors: ValidationError[]; warnings: ValidationWarning[] } {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  if (fieldDef.multiline === false && /[\r\n]/.test(value)) {
    errors.push({
      field: fieldName,
      message: `Value contains line breaks but schema declares multiline: false`,
      code: 'FIELD_MULTILINE_NOT_ALLOWED',
      location: loc,
    });
  }

  if (fieldDef.maxLength !== null || fieldDef.softMaxLength !== null) {
    const actual = codePointLength(value);
    if (fieldDef.maxLength !== null && actual > fieldDef.maxLength) {
      errors.push({
        field: fieldName,
        message: `Value is ${actual} code points but schema declares max_length ${fieldDef.maxLength}`,
        code: 'FIELD_MAX_LENGTH_EXCEEDED',
        location: loc,
      });
    }
    if (fieldDef.softMaxLength !== null && actual > fieldDef.softMaxLength) {
      warnings.push({
        field: fieldName,
        message: `Value is ${actual} code points, over the advisory soft_max_length ${fieldDef.softMaxLength}`,
        code: 'FIELD_SOFT_MAX_LENGTH_EXCEEDED',
        location: loc,
      });
    }
  }

  return { errors, warnings };
}

function validateField(
  name: string,
  value: unknown,
  def: FieldDefinition,
  registry: Registry,
): ValidationError[] {
  const errors: ValidationError[] = [];

  switch (def.type) {
    case 'string':
      if (typeof value !== 'string') {
        errors.push({ field: name, message: `Expected string, got ${typeof value}`, location: null });
      }
      break;

    case 'number':
      if (typeof value !== 'number' || !isFinite(value)) {
        errors.push({ field: name, message: `Expected finite number, got ${String(value)}`, location: null });
      }
      break;

    case 'boolean':
      if (typeof value !== 'boolean') {
        errors.push({ field: name, message: `Expected boolean, got ${typeof value}`, location: null });
      }
      break;

    case 'date':
      if (typeof value !== 'string') {
        // gray-matter may parse dates as Date objects
        if (value instanceof Date) break; // allow Date objects
        errors.push({ field: name, message: `Expected date string, got ${typeof value}`, location: null });
      } else if (def.format === 'YYYY-MM-DD') {
        if (!/^\d{4}-\d{2}-\d{2}/.test(value)) {
          errors.push({ field: name, message: `Date "${value}" does not match format ${def.format}`, location: null });
        }
      }
      break;

    case 'enum':
      if (typeof value !== 'string') {
        errors.push({ field: name, message: `Expected string for enum, got ${typeof value}`, location: null });
      } else if (def.values !== null && !def.values.includes(value)) {
        errors.push({ field: name, message: `Value "${value}" not in enum [${def.values.join(', ')}]`, location: null });
      }
      break;

    case 'ref':
      if (typeof value !== 'string') {
        errors.push({ field: name, message: `Expected ref to ${def.target ? (def.target as string) : 'any type'}, got ${typeof value}`, location: null });
      } else if (def.target !== null) {
        const targetType = registry.types.get(def.target);
        if (targetType && !value.startsWith(targetType.idPrefix + '-')) {
          errors.push({ field: name, message: `Ref "${value}" must start with "${targetType.idPrefix}-" (references ${def.target as string})`, location: null });
        }
      }
      break;

    case 'list':
      if (!Array.isArray(value)) {
        errors.push({ field: name, message: `Expected array of ${def.itemType ?? 'values'}, got ${typeof value}`, location: null });
      } else {
        const itemType = def.itemType ?? 'string';
        for (let i = 0; i < value.length; i++) {
          errors.push(...validateListItem(`${name}[${i}]`, value[i], itemType, def, registry));
        }
      }
      break;

    case 'amount':
      if (typeof value !== 'string') {
        errors.push({ field: name, message: `Expected amount string (e.g. "100.00 USD"), got ${typeof value}`, location: null });
      } else if (!/^\d+(\.\d+)?\s+[A-Z]{3}$/.test(value)) {
        errors.push({ field: name, message: `Amount "${value}" does not match format "<number> <CURRENCY>"`, location: null });
      }
      break;
  }

  return errors;
}

function validateListItem(
  name: string,
  value: unknown,
  itemType: FieldDefinition['type'],
  listDef: FieldDefinition,
  registry: Registry,
): ValidationError[] {
  const itemDef: FieldDefinition = {
    ...listDef,
    name,
    type: itemType,
    itemType: null,
  };
  return validateField(name, value, itemDef, registry);
}

function describeFieldExpectation(def: FieldDefinition, registry: Registry): string {
  switch (def.type) {
    case 'ref': {
      if (!def.target) return ' — expected a ref';
      const targetType = registry.types.get(def.target);
      return targetType
        ? ` — expected ref to ${def.target as string} (prefix "${targetType.idPrefix}-")`
        : ` — expected ref to ${def.target as string}`;
    }
    case 'enum':
      return def.values ? ` — must be one of: ${def.values.join(', ')}` : ' — expected enum value';
    case 'date':
      return def.format ? ` — expected date (${def.format})` : ' — expected date string';
    case 'amount':
      return ' — expected amount (e.g. "100.00 USD")';
    case 'list':
      return ` — expected array of ${def.itemType ?? 'values'}`;
    default:
      return ` — expected ${def.type}`;
  }
}
