// ============================================================================
// Document Parser — Public API
// Composes frontmatter, blocks, verbatim zones, value calls, and annotations
// into a single ParsedDocument.
// ============================================================================

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ok, singleErr, type Result } from '../errors.js';
import { filePath as toFilePath, type FilePath, type ParsedDocument, type ParsedBlock, type Primitive } from '../types.js';
import { parseFrontmatter } from './frontmatter.js';
import { parseBlocks } from './blocks.js';
import { findVerbatimZones } from './verbatim.js';
import { extractValueCalls } from './tags.js';
import { extractAnnotations } from './annotations.js';
import { validateYamlProfile } from './yaml-profile.js';

export { parseFrontmatter } from './frontmatter.js';
export { parseBlocks } from './blocks.js';
export { findVerbatimZones, isInVerbatimZone } from './verbatim.js';
export { extractValueCalls } from './tags.js';
export { extractAnnotations } from './annotations.js';
export { validateYamlProfile } from './yaml-profile.js';

// 0.7.13 — parse options. `maxAnnotations` caps body annotation extraction so
// a pathological doc can't build an unbounded object/relationship set; the
// document still parses and indexes (record + frontmatter + capped body).
export interface ParseOptions {
  maxAnnotations?: number;
  /**
   * 0.8.0 — when true, compute per-block text (ParsedDocument.blockTexts) for
   * the semantic index. Off by default so a non-semantic parse pays nothing.
   */
  includeBlockText?: boolean;
}

/**
 * 0.8.0 — slice each block's body text, mirroring readBlockContent's full-file
 * math but against the (already-in-memory) stripped body. Block line numbers are
 * 1-based absolute-to-file and endLine is inclusive; bodyLines[0] is file line
 * `bodyStartLine`, so subtract that offset. Heading blocks drop the heading line
 * (start at startLine); the preamble (level 0) starts one earlier.
 */
export function sliceBlockTexts(body: string, bodyStartLine: number, blocks: ParsedBlock[]): string[] {
  const lines = body.split('\n');
  const off = bodyStartLine - 1;
  return blocks.map(block => {
    const isPreamble = block.level === 0;
    const start = (isPreamble ? block.startLine - 1 : block.startLine) - off;
    const end = block.endLine - off; // exclusive slice bound → inclusive of endLine
    return lines.slice(Math.max(0, start), Math.max(0, end)).join('\n').trim();
  });
}

export async function parseDocument(
  path: FilePath,
  subtypeMap: Record<string, Primitive>,
  opts?: ParseOptions,
): Promise<Result<ParsedDocument>> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown read error';
    return singleErr('FILE_READ_ERROR', `Failed to read file: ${message}`, { file: path, line: 0, col: 0 });
  }

  return parseDocumentFromContent(raw, path, subtypeMap, opts);
}

export function parseDocumentFromContent(
  raw: string,
  path: FilePath,
  subtypeMap: Record<string, Primitive>,
  opts?: ParseOptions,
): Result<ParsedDocument> {
  const hash = createHash('sha256').update(raw).digest('hex');

  const fm = parseFrontmatter(raw, path);
  if (!fm.ok) return fm;

  const profileResult = validateYamlProfile(fm.value.frontmatter, path);
  if (!profileResult.ok) return profileResult as Result<ParsedDocument>;

  const { frontmatter, body, bodyStartLine } = fm.value;

  const cap = opts?.maxAnnotations;
  const verbatimZones = findVerbatimZones(body, bodyStartLine);
  const blocks = parseBlocks(body, bodyStartLine);
  const valueCalls = extractValueCalls(body, bodyStartLine, path, verbatimZones);
  const annotations = extractAnnotations(body, bodyStartLine, path, subtypeMap, verbatimZones, cap);
  // length >= cap means extraction stopped at the limit — body objects are
  // partial. A doc with exactly `cap` legitimate annotations is also flagged;
  // at the cap's scale (tens of thousands) that doc is already pathological.
  const annotationsTruncated = cap !== undefined && cap > 0 && annotations.length >= cap;

  return ok({
    filePath: path,
    fileHash: hash,
    frontmatter,
    blocks,
    valueCalls,
    annotations,
    ...(opts?.includeBlockText ? { blockTexts: sliceBlockTexts(body, bodyStartLine, blocks) } : {}),
    ...(annotationsTruncated ? { annotationsTruncated: true } : {}),
  });
}
