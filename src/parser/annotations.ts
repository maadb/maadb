// ============================================================================
// Inline Annotation Extractor
// Extracts [[type:value|label]] annotations from markdown body.
// Resolves subtype -> primitive via the subtype map.
// Skips matches inside verbatim zones.
// ============================================================================

import type { FilePath, InlineAnnotation, Primitive, VerbatimZone } from '../types.js';
import { resolvePrimitive } from '../types.js';
import { isInVerbatimZone } from './verbatim.js';

const ANNOTATION_REGEX = /\[\[([a-zA-Z_][a-zA-Z0-9_]*):([^|]+)\|([^\]]+)\]\]/g;

export function extractAnnotations(
  body: string,
  bodyStartLine: number,
  filePath: FilePath,
  subtypeMap: Record<string, Primitive>,
  verbatimZones: VerbatimZone[],
  // 0.7.13 — optional early-stop cap. When set (> 0), extraction stops once
  // this many annotations have been collected, so a pathological doc with
  // hundreds of thousands of [[...]] can't build an unbounded array (the
  // demonstrated index-time OOM driver). Callers detect truncation by
  // comparing the returned length against the cap. Undefined / 0 = no cap.
  maxAnnotations?: number,
): InlineAnnotation[] {
  const annotations: InlineAnnotation[] = [];
  const cap = maxAnnotations !== undefined && maxAnnotations > 0 ? maxAnnotations : Infinity;
  if (cap === 0) return annotations;
  const lines = body.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const absoluteLine = bodyStartLine + i;

    let match: RegExpExecArray | null;
    ANNOTATION_REGEX.lastIndex = 0;

    while ((match = ANNOTATION_REGEX.exec(line)) !== null) {
      const col = match.index;

      if (isInVerbatimZone(absoluteLine, col, verbatimZones)) continue;

      const rawType = match[1]!;
      const value = match[2]!.trim();
      const label = match[3]!.trim();
      const primitive = resolvePrimitive(rawType, subtypeMap);

      annotations.push({
        rawType,
        primitive,
        value,
        label,
        location: {
          file: filePath,
          line: absoluteLine,
          col,
        },
      });

      if (annotations.length >= cap) return annotations;
    }
  }

  return annotations;
}
