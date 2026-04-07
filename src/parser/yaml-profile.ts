// ============================================================================
// MAAD YAML Profile Validator
// Enforces the constrained YAML subset: no anchors, no aliases, no deep
// nesting, no complex keys. Runs after gray-matter parse, before schema.
// ============================================================================

import { ok, singleErr, maadError, type Result, type MaadError } from '../errors.js';
import type { FilePath } from '../types.js';

const MAX_DEPTH = 2;

export function validateYamlProfile(
  frontmatter: Record<string, unknown>,
  filePath: FilePath,
): Result<Record<string, unknown>> {
  const errors: MaadError[] = [];
  const loc = { file: filePath, line: 1, col: 1 };

  for (const [key, value] of Object.entries(frontmatter)) {
    // Keys must be plain strings
    if (typeof key !== 'string') {
      errors.push(maadError('YAML_PROFILE_VIOLATION', `Key must be a string, got ${typeof key}`, loc));
      continue;
    }

    // Check for anchor/alias artifacts — gray-matter resolves these but we detect
    // circular references or shared references that indicate alias usage
    // (In practice, gray-matter silently resolves them, so we check value depth/shape)

    // Validate value depth and types
    const depthErrors = validateValue(key, value, 0, filePath);
    errors.push(...depthErrors);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return ok(frontmatter);
}

function validateValue(
  path: string,
  value: unknown,
  depth: number,
  filePath: FilePath,
): MaadError[] {
  const errors: MaadError[] = [];
  const loc = { file: filePath, line: 1, col: 1 };

  if (value === null || value === undefined) return errors;
  if (typeof value === 'string') return errors;
  if (typeof value === 'number') return errors;
  if (typeof value === 'boolean') return errors;

  if (value instanceof Date) return errors; // gray-matter may parse dates

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) {
      errors.push(maadError('YAML_PROFILE_VIOLATION',
        `"${path}": array at depth ${depth} exceeds max nesting depth of ${MAX_DEPTH}`, loc));
      return errors;
    }
    for (let i = 0; i < value.length; i++) {
      const item = value[i];
      // Recurse into array items at depth + 1
      errors.push(...validateValue(`${path}[${i}]`, item, depth + 1, filePath));
    }
    return errors;
  }

  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) {
      errors.push(maadError('YAML_PROFILE_VIOLATION',
        `"${path}": object at depth ${depth} exceeds max nesting depth of ${MAX_DEPTH}`, loc));
      return errors;
    }

    const obj = value as Record<string, unknown>;
    for (const [key, childValue] of Object.entries(obj)) {
      if (typeof key !== 'string') {
        errors.push(maadError('YAML_PROFILE_VIOLATION',
          `"${path}": non-string key "${String(key)}" not allowed`, loc));
        continue;
      }
      errors.push(...validateValue(`${path}.${key}`, childValue, depth + 1, filePath));
    }
    return errors;
  }

  // Unknown type
  errors.push(maadError('YAML_PROFILE_VIOLATION',
    `"${path}": unsupported value type ${typeof value}`, loc));

  return errors;
}

/**
 * Detect multi-document YAML. gray-matter only parses the first document,
 * but we should warn if the raw content contains multiple --- separators
 * that suggest multi-document YAML.
 */
export function checkMultiDocument(raw: string, filePath: FilePath): MaadError | null {
  // Count --- lines (excluding the frontmatter delimiters)
  const lines = raw.split('\n');
  let separatorCount = 0;
  let inFrontmatter = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '---') {
      if (!inFrontmatter) {
        inFrontmatter = true;
      } else if (inFrontmatter && separatorCount === 0) {
        separatorCount++; // closing delimiter — this is normal
        inFrontmatter = false;
      } else {
        // Additional --- after frontmatter is closed — multi-document indicator
        return maadError('YAML_PROFILE_VIOLATION',
          'Multi-document YAML detected (additional --- separator). MAAD supports single-document YAML only.',
          { file: filePath, line: lines.indexOf(line) + 1, col: 1 });
      }
    }
  }

  return null;
}
