// ============================================================================
// Document Parser — Public API
// Composes frontmatter, blocks, verbatim zones, value calls, and annotations
// into a single ParsedDocument.
// ============================================================================

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ok, singleErr, type Result } from '../errors.js';
import { filePath as toFilePath, type FilePath, type ParsedDocument, type Primitive } from '../types.js';
import { parseFrontmatter } from './frontmatter.js';
import { parseBlocks } from './blocks.js';
import { findVerbatimZones } from './verbatim.js';
import { extractValueCalls } from './tags.js';
import { extractAnnotations } from './annotations.js';
import { validateYamlProfile, checkMultiDocument } from './yaml-profile.js';

export { parseFrontmatter } from './frontmatter.js';
export { parseBlocks } from './blocks.js';
export { findVerbatimZones, isInVerbatimZone } from './verbatim.js';
export { extractValueCalls } from './tags.js';
export { extractAnnotations } from './annotations.js';
export { validateYamlProfile, checkMultiDocument } from './yaml-profile.js';

export async function parseDocument(
  path: FilePath,
  subtypeMap: Record<string, Primitive>,
): Promise<Result<ParsedDocument>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown read error';
    return singleErr('FILE_READ_ERROR', `Failed to read file: ${message}`, { file: path, line: 0, col: 0 });
  }

  const hash = createHash('sha256').update(raw).digest('hex');

  // Check for multi-document YAML
  const multiDocErr = checkMultiDocument(raw, path);
  if (multiDocErr) return { ok: false, errors: [multiDocErr] };

  const fm = parseFrontmatter(raw, path);
  if (!fm.ok) return fm;

  // Validate YAML profile (constrained subset)
  const profileResult = validateYamlProfile(fm.value.frontmatter, path);
  if (!profileResult.ok) return profileResult as Result<ParsedDocument>;

  const { frontmatter, body, bodyStartLine } = fm.value;

  const verbatimZones = findVerbatimZones(body, bodyStartLine);
  const blocks = parseBlocks(body, bodyStartLine);
  const valueCalls = extractValueCalls(body, bodyStartLine, path, verbatimZones);
  const annotations = extractAnnotations(body, bodyStartLine, path, subtypeMap, verbatimZones);

  return ok({
    filePath: path,
    fileHash: hash,
    frontmatter,
    blocks,
    valueCalls,
    annotations,
  });
}
