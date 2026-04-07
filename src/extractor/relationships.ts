// ============================================================================
// Relationship Builder
// Creates edges between documents from ref fields and inline mentions.
// ============================================================================

import {
  docId as toDocId,
  type BoundDocument,
  type SchemaDefinition,
  type InlineAnnotation,
  type Relationship,
  type Registry,
} from '../types.js';

export function extractRelationships(
  bound: BoundDocument,
  schema: SchemaDefinition,
  annotations: InlineAnnotation[],
  registry: Registry,
): Relationship[] {
  const relationships: Relationship[] = [];

  // 1. Scalar ref fields in frontmatter
  for (const [fieldName, fieldDef] of schema.fields) {
    if (fieldDef.type === 'ref') {
      const value = bound.parsed.frontmatter[fieldName];
      if (typeof value === 'string') {
        relationships.push({
          sourceDocId: bound.docId,
          targetDocId: toDocId(value),
          field: fieldName,
          relationType: 'ref',
        });
      }
    }

    // 1b. List-of-ref fields
    if (fieldDef.type === 'list' && fieldDef.itemType === 'ref') {
      const value = bound.parsed.frontmatter[fieldName];
      if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === 'string') {
            relationships.push({
              sourceDocId: bound.docId,
              targetDocId: toDocId(item),
              field: fieldName,
              relationType: 'ref',
            });
          }
        }
      }
    }
  }

  // 2. Inline mentions that look like doc_ids
  // Collect all known prefixes from registry
  const prefixes = new Set<string>();
  for (const [, regType] of registry.types) {
    prefixes.add(regType.idPrefix + '-');
  }

  for (const ann of annotations) {
    // Check if the annotation value starts with any known doc_id prefix
    const matchesPrefix = [...prefixes].some(p => ann.value.startsWith(p));
    if (matchesPrefix) {
      relationships.push({
        sourceDocId: bound.docId,
        targetDocId: toDocId(ann.value),
        field: ann.rawType,
        relationType: 'mention',
      });
    }
  }

  return relationships;
}
