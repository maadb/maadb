// ============================================================================
// Field Extractor
// Extracts indexed frontmatter fields as ExtractedObject entries.
// ============================================================================

import type {
  BoundDocument,
  SchemaDefinition,
  ExtractedObject,
  Primitive,
  FieldType,
} from '../types.js';
import { normalize } from './normalizers.js';

const FIELD_TYPE_TO_PRIMITIVE: Partial<Record<FieldType, Primitive>> = {
  date: 'date',
  amount: 'amount',
  number: 'quantity',
};

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const PHONE_REGEX = /^[+]?[\d\s().-]{7,}$/;
const URL_REGEX = /^https?:\/\//;

function detectContactPrimitive(value: string): Primitive | null {
  if (EMAIL_REGEX.test(value)) return 'contact';
  if (PHONE_REGEX.test(value)) return 'contact';
  if (URL_REGEX.test(value)) return 'contact';
  return null;
}

export function extractFields(
  bound: BoundDocument,
  schema: SchemaDefinition,
): ExtractedObject[] {
  const objects: ExtractedObject[] = [];

  for (const [name, field] of Object.entries(bound.validatedFields)) {
    if (!field.indexed) continue;
    if (field.value === undefined || field.value === null) continue;

    let primitive = FIELD_TYPE_TO_PRIMITIVE[field.fieldType] ?? 'entity';
    // Detect contact-like string values (email, phone, URL)
    if (primitive === 'entity' && field.fieldType === 'string') {
      const contactPrimitive = detectContactPrimitive(String(field.value));
      if (contactPrimitive) primitive = contactPrimitive;
    }
    // Defensive: with the string-preserving YAML engine (parser/matter.ts)
    // Dates are rare here, but a caller may still pass `new Date(...)`
    // directly. Preserve full ISO precision — never slice.
    const valueStr = field.value instanceof Date
      ? field.value.toISOString()
      : String(field.value);
    const normalizedValue = normalize(primitive, valueStr);

    objects.push({
      primitive,
      subtype: name,
      value: valueStr,
      normalizedValue,
      label: valueStr,
      role: field.role,
      docId: bound.docId,
      location: { file: bound.parsed.filePath, line: 1, col: 0 },
      blockId: null,
    });
  }

  return objects;
}
