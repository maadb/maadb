// ============================================================================
// Object Extractor
// Converts inline annotations into ExtractedObject entries.
// Maps each annotation to the block it falls within.
// ============================================================================

import type {
  BoundDocument,
  InlineAnnotation,
  ExtractedObject,
  ParsedBlock,
  BlockId,
} from '../types.js';
import { normalize } from './normalizers.js';

export function extractAnnotationObjects(
  bound: BoundDocument,
  annotations: InlineAnnotation[],
): ExtractedObject[] {
  const blocks = bound.parsed.blocks;

  return annotations.map((ann): ExtractedObject => {
    const blockMatch = findContainingBlock(ann.location.line, blocks);
    const normalizedValue = normalize(ann.primitive, ann.value, ann.rawType);

    return {
      primitive: ann.primitive,
      subtype: ann.rawType,
      value: ann.value,
      normalizedValue,
      label: ann.label,
      role: null,
      docId: bound.docId,
      location: ann.location,
      blockId: blockMatch,
    };
  });
}

export function findContainingBlock(line: number, blocks: ParsedBlock[]): BlockId | null {
  for (const block of blocks) {
    if (line >= block.startLine && line <= block.endLine) {
      return block.id;
    }
  }
  return null;
}
