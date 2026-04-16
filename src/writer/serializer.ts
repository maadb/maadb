// ============================================================================
// YAML Serializer
// Serializes frontmatter to YAML with deterministic field ordering.
// ============================================================================

import type { SchemaDefinition } from '../types.js';

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
    const items = value.map(v => {
      const s = String(v);
      // Quote items that contain commas or brackets
      if (s.includes(',') || s.includes('[') || s.includes(']')) return `"${s.replace(/"/g, '\\"')}"`;
      return s;
    });
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
    /^\d/.test(str) && /[^\d.eE+-]/.test(str) // looks numeric but isn't
  ) {
    return `${key}: "${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  return `${key}: ${str}`;
}
