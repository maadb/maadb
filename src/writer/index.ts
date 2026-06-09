// ============================================================================
// Document Writer — Public API
// Generates, updates, and serializes markdown documents deterministically.
// ============================================================================

import type { SchemaDefinition } from '../types.js';
import { serializeFrontmatter } from './serializer.js';
import { generateTemplateBody } from './template.js';

export { serializeFrontmatter, serializeField } from './serializer.js';
export { generateTemplateBody } from './template.js';

export function generateDocument(
  frontmatter: Record<string, unknown>,
  schema: SchemaDefinition,
  body?: string | undefined,
): string {
  const fm = serializeFrontmatter(frontmatter, schema);

  // If no body provided, generate from template (if schema defines one)
  const resolvedBody = body ?? generateTemplateBody(schema, frontmatter);

  const parts = [fm, ''];
  if (resolvedBody.length > 0) {
    parts.push(resolvedBody);
    parts.push('');
  }

  return parts.join('\n');
}

// Delimiter matching must tolerate CRLF line endings and a UTF-8 BOM: markdown is
// the canonical store and stays editable outside the engine, so files arrive with
// whatever line endings the host editor or checkout produced. An LF-only match here
// silently treats the whole file (frontmatter included) as body, and the update
// path then wraps new frontmatter around it — committed corruption.

export function extractBody(rawContent: string): string {
  const content = rawContent.replace(/^\uFEFF/, '');
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  const body = match ? match[1]! : content;
  return body.replace(/\r\n/g, '\n').trim();
}

export function appendToBody(existingContent: string, additional: string): string {
  const content = existingContent.replace(/^\uFEFF/, '');
  const fmMatch = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/.exec(content);
  if (!fmMatch) return content + '\n\n' + additional;

  const fmPart = fmMatch[1]!;
  const bodyPart = fmMatch[2]!.trimEnd();

  return fmPart + bodyPart + '\n\n' + additional + '\n';
}
