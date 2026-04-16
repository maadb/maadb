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

export function validateFrontmatter(
  frontmatter: Record<string, unknown>,
  schema: SchemaDefinition,
  registry: Registry,
  filePath?: FilePath | undefined,
): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const loc = filePath ? { file: filePath, line: 1, col: 1 } : null;

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
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
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
      } else if (def.itemType === 'ref' && def.target !== null) {
        // Validate each item in a list-of-refs
        const targetType = registry.types.get(def.target);
        if (targetType) {
          for (let i = 0; i < value.length; i++) {
            const item = value[i];
            if (typeof item !== 'string') {
              errors.push({ field: `${name}[${i}]`, message: `Expected ref to ${def.target as string}, got ${typeof item}`, location: null });
            } else if (!item.startsWith(targetType.idPrefix + '-')) {
              errors.push({ field: `${name}[${i}]`, message: `Ref "${item}" must start with "${targetType.idPrefix}-" (references ${def.target as string})`, location: null });
            }
          }
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
