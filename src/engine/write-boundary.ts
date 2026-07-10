import type { DocumentRecord } from '../types.js';

export const CORE_IDENTITY_FIELDS = ['doc_id', 'doc_type', 'schema'] as const;

export interface BoundaryViolation {
  code: 'INVALID_FIELDS' | 'FRONTMATTER_GUARD';
  message: string;
}

export function validateCallerFields(fields: unknown): BoundaryViolation | null {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    return { code: 'INVALID_FIELDS', message: 'fields must be a plain object, not null, a string, or an array' };
  }

  for (const field of CORE_IDENTITY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(fields, field)) {
      return {
        code: 'FRONTMATTER_GUARD',
        message: `Field "${field}" is engine-owned and cannot be supplied by a caller`,
      };
    }
  }
  return null;
}

export function validateStoredIdentity(
  frontmatter: Record<string, unknown>,
  doc: Pick<DocumentRecord, 'docId' | 'docType' | 'schemaRef'>,
  expectedSchema: string = doc.schemaRef as string,
): BoundaryViolation | null {
  const expected: Record<(typeof CORE_IDENTITY_FIELDS)[number], string> = {
    doc_id: doc.docId as string,
    doc_type: doc.docType as string,
    schema: expectedSchema,
  };

  for (const field of CORE_IDENTITY_FIELDS) {
    if (frontmatter[field] !== expected[field]) {
      return {
        code: 'FRONTMATTER_GUARD',
        message: `Stored field "${field}" does not match the addressed record (expected "${expected[field]}")`,
      };
    }
  }
  return null;
}
