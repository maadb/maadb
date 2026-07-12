// ============================================================================
// YAML Serializer
// Serializes frontmatter to YAML with deterministic field ordering.
// ============================================================================

import yaml from 'js-yaml';
import type { SchemaDefinition } from '../types.js';

// Coercion-roundtrip guard. Any string whose unquoted YAML form would parse
// back as a non-string under our CORE_SCHEMA loader must be quoted, or string
// fields silently corrupt on read. The static keyword/numeric checks below
// catch the common cases; this guard is the catch-all that future-proofs us
// against any implicit-tag scalar we forgot to enumerate.
function wouldCoerceFromString(candidate: string): boolean {
  try {
    const parsed = yaml.load(candidate, { schema: yaml.CORE_SCHEMA });
    return parsed !== candidate;
  } catch {
    return true;
  }
}

// Version-independent numeric-lookalike check: YAML 1.2 core int/float/hex/
// octal/binary forms plus 1.1-style underscore digits. The parse-back guard
// above reflects whatever the *installed* js-yaml resolves — 4.2.0 stopped
// resolving some forms (bare sci-notation like `1e38892`, underscore numbers)
// that other downstream YAML parsers still coerce to numbers. A string field
// must survive as a string under ANY parser, so anything number-shaped is
// quoted statically rather than trusting one resolver's current behavior.
const NUMERIC_LOOKALIKE =
  /^[-+]?(0[box][0-9a-fA-F_]+|(\.[0-9_]+|[0-9][0-9_]*(\.[0-9_]*)?)([eE][-+]?[0-9_]+)?|\.(inf|Inf|INF)|\.?(nan|NaN|NAN))$/;

export function serializeFrontmatter(
  frontmatter: Record<string, unknown>,
  schema: SchemaDefinition,
): string {
  const lines: string[] = ['---'];
  const written = new Set<string>();

  // Core keys first: doc_id, doc_type, schema
  const coreKeys = ['doc_id', 'doc_type', 'schema'];
  for (const key of coreKeys) {
    if (key in frontmatter) {
      lines.push(serializeField(key, frontmatter[key]));
      written.add(key);
    }
  }

  // Required fields next (in schema order)
  for (const key of schema.required) {
    if (!written.has(key) && key in frontmatter) {
      lines.push(serializeField(key, frontmatter[key]));
      written.add(key);
    }
  }

  // Remaining fields (in schema field order, then any extras)
  for (const [key] of schema.fields) {
    if (!written.has(key) && key in frontmatter) {
      lines.push(serializeField(key, frontmatter[key]));
      written.add(key);
    }
  }

  // Any fields not in schema (user extras)
  for (const key of Object.keys(frontmatter)) {
    if (!written.has(key)) {
      lines.push(serializeField(key, frontmatter[key]));
    }
  }

  lines.push('---');
  return lines.join('\n');
}

export function serializeField(key: string, value: unknown): string {
  if (value === null || value === undefined) return `${key}: null`;
  if (typeof value === 'boolean') return `${key}: ${value}`;
  if (typeof value === 'number') return `${key}: ${value}`;

  if (Array.isArray(value)) {
    // Preserve each item's runtime type. Stringifying here is lossy in both
    // directions: string lookalikes such as "true" and "007" are re-read as
    // booleans/numbers, while actual null values become the string "null".
    const items = value.map(serializeArrayItem);
    return `${key}: [${items.join(', ')}]`;
  }

  if (value instanceof Date) {
    // Full ISO millisecond precision. Never slice — precision on round-trip
    // is contract-critical for 0.6.7 schema precision hints. Quoted so the
    // emitted YAML parses as a literal string under any schema (including
    // default js-yaml outside our pipeline), never as a !!timestamp.
    return `${key}: "${value.toISOString()}"`;
  }

  const str = String(value);

  // Quote strings that contain YAML-special characters
  if (
    str.includes(':') ||
    str.includes('#') ||
    str.includes('"') ||
    str.includes("'") ||
    str.startsWith('{') ||
    str.startsWith('[') ||
    str.startsWith('*') ||
    str.startsWith('&') ||
    str.startsWith('!') ||
    str.startsWith('%') ||
    str.startsWith('@') ||
    str.startsWith('`') ||
    str === '' ||
    str === 'true' || str === 'false' ||
    str === 'null' || str === 'yes' || str === 'no' ||
    /^\d/.test(str) && /[^\d.eE+-]/.test(str) || // looks numeric but isn't
    NUMERIC_LOOKALIKE.test(str) || // number-shaped under any YAML parser
    wouldCoerceFromString(str) // catch-all: any implicit-tag coercion forces quotes
  ) {
    return `${key}: "${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  return `${key}: ${str}`;
}

function serializeArrayItem(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (value instanceof Date) return `"${value.toISOString()}"`;
  if (Array.isArray(value)) return `[${value.map(serializeArrayItem).join(', ')}]`;

  if (typeof value === 'string') {
    return serializeField('_', value).slice(3);
  }

  // Schema-governed lists reject object items, but extras still need valid
  // YAML rather than the old lossy "[object Object]" representation.
  return yaml.dump(value, {
    schema: yaml.CORE_SCHEMA,
    flowLevel: 0,
    lineWidth: -1,
    noRefs: true,
  }).trim();
}
