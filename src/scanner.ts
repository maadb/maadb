// ============================================================================
// Scanner
// Structural analysis of raw markdown files — no registry, no schema needed.
// Two modes: single file (detailed) and directory (corpus-level patterns).
// ============================================================================

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseMatter } from './parser/matter.js';
import { parseBlocks } from './parser/blocks.js';
import { extractAnnotations } from './parser/annotations.js';
import { extractValueCalls } from './parser/tags.js';
import { findVerbatimZones } from './parser/verbatim.js';
import { DEFAULT_SUBTYPE_MAP } from './types.js';

// --- File-level scan result --------------------------------------------------

export interface FileScanResult {
  filePath: string;
  sizeBytes: number;
  lineCount: number;
  frontmatter: Record<string, unknown> | null;
  frontmatterFields: string[];
  headings: Array<{ level: number; text: string; line: number }>;
  blockCount: number;
  annotations: Array<{ type: string; value: string; label: string }>;
  valueCalls: string[];
  detectedPatterns: {
    dates: string[];
    emails: string[];
    amounts: string[];
    urls: string[];
  };
}

// --- Corpus-level scan result ------------------------------------------------

export interface CorpusScanResult {
  directory: string;
  totalFiles: number;
  totalLines: number;
  files: Array<{ path: string; lineCount: number; hasFrontmatter: boolean; frontmatterFields: string[] }>;
  frontmatterFieldFrequency: Record<string, number>;
  headingPatterns: Array<{ text: string; level: number; occurrences: number }>;
  likelyDocumentFamilies: Array<{
    name: string;
    fileCount: number;
    sharedFields: string[];
    sharedHeadings: string[];
    sampleFiles: string[];
  }>;
  entitySummary: Array<{ type: string; value: string; occurrences: number }>;
}

// --- File scan ---------------------------------------------------------------

export async function scanFile(filePath: string): Promise<FileScanResult> {
  const raw = await readFile(filePath, 'utf-8');
  const lines = raw.split('\n');
  const stats = await import('node:fs').then(fs => fs.statSync(filePath));

  // Parse frontmatter (tolerant — no validation)
  let frontmatter: Record<string, unknown> | null = null;
  let body = raw;
  let bodyStartLine = 1;

  try {
    const parsed = parseMatter(raw);
    if (parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data)) {
      frontmatter = parsed.data as Record<string, unknown>;
      body = parsed.content;
      if (parsed.matter && parsed.matter.length > 0) {
        bodyStartLine = parsed.matter.split('\n').length + 2;
      }
    }
  } catch {
    // No valid frontmatter — treat entire file as body
  }

  const frontmatterFields = frontmatter ? Object.keys(frontmatter) : [];

  // Parse blocks (headings + structure)
  const blocks = parseBlocks(body, bodyStartLine);
  const headings = blocks
    .filter(b => b.heading !== '')
    .map(b => ({ level: b.level, text: b.heading, line: b.startLine }));

  // Extract annotations using default subtype map
  const verbatimZones = findVerbatimZones(body, bodyStartLine);
  const annotations = extractAnnotations(body, bodyStartLine, filePath as any, DEFAULT_SUBTYPE_MAP, verbatimZones);
  const valueCalls = extractValueCalls(body, bodyStartLine, filePath as any, verbatimZones);

  // Detect common patterns in raw text via regex
  const detectedPatterns = detectPatterns(raw);

  return {
    filePath,
    sizeBytes: stats.size,
    lineCount: lines.length,
    frontmatter,
    frontmatterFields,
    headings,
    blockCount: blocks.length,
    annotations: annotations.map(a => ({ type: a.rawType, value: a.value, label: a.label })),
    valueCalls: valueCalls.map(v => v.field),
    detectedPatterns,
  };
}

// --- Corpus scan -------------------------------------------------------------

export async function scanDirectory(dirPath: string): Promise<CorpusScanResult> {
  const files = await collectAllMarkdown(dirPath);
  const scanResults: FileScanResult[] = [];

  for (const file of files) {
    try {
      scanResults.push(await scanFile(file));
    } catch {
      // Skip unreadable files
    }
  }

  // Aggregate frontmatter field frequency
  const fieldFreq: Record<string, number> = {};
  for (const scan of scanResults) {
    for (const field of scan.frontmatterFields) {
      fieldFreq[field] = (fieldFreq[field] ?? 0) + 1;
    }
  }

  // Aggregate heading patterns
  const headingMap = new Map<string, { level: number; count: number }>();
  for (const scan of scanResults) {
    for (const h of scan.headings) {
      const key = `${h.level}:${h.text}`;
      const existing = headingMap.get(key);
      if (existing) {
        existing.count++;
      } else {
        headingMap.set(key, { level: h.level, count: 1 });
      }
    }
  }
  const headingPatterns = [...headingMap.entries()]
    .map(([key, val]) => ({ text: key.split(':').slice(1).join(':'), level: val.level, occurrences: val.count }))
    .filter(h => h.occurrences > 1)
    .sort((a, b) => b.occurrences - a.occurrences);

  // Aggregate entities
  const entityMap = new Map<string, number>();
  for (const scan of scanResults) {
    for (const ann of scan.annotations) {
      const key = `${ann.type}:${ann.value}`;
      entityMap.set(key, (entityMap.get(key) ?? 0) + 1);
    }
  }
  const entitySummary = [...entityMap.entries()]
    .map(([key, count]) => {
      const [type, ...valueParts] = key.split(':');
      return { type: type!, value: valueParts.join(':'), occurrences: count };
    })
    .sort((a, b) => b.occurrences - a.occurrences)
    .slice(0, 30);

  // Detect document families by clustering on shared frontmatter fields
  const families = detectFamilies(scanResults, dirPath);

  return {
    directory: dirPath,
    totalFiles: scanResults.length,
    totalLines: scanResults.reduce((sum, s) => sum + s.lineCount, 0),
    files: scanResults.map(s => ({
      path: path.relative(dirPath, s.filePath),
      lineCount: s.lineCount,
      hasFrontmatter: s.frontmatter !== null,
      frontmatterFields: s.frontmatterFields,
    })),
    frontmatterFieldFrequency: fieldFreq,
    headingPatterns,
    likelyDocumentFamilies: families,
    entitySummary,
  };
}

// --- Pattern detection -------------------------------------------------------

const DATE_REGEX = /\b\d{4}-\d{2}-\d{2}\b/g;
const EMAIL_REGEX = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
const AMOUNT_REGEX = /\b\d[\d,.]*\s*(?:USD|EUR|GBP|CAD|AUD|\$|dollars?)\b/gi;
const URL_REGEX = /https?:\/\/[^\s)>\]]+/g;

function detectPatterns(raw: string): FileScanResult['detectedPatterns'] {
  const dedupe = (matches: RegExpMatchArray | null) => [...new Set(matches ?? [])];
  return {
    dates: dedupe(raw.match(DATE_REGEX)).slice(0, 10),
    emails: dedupe(raw.match(EMAIL_REGEX)).slice(0, 10),
    amounts: dedupe(raw.match(AMOUNT_REGEX)).slice(0, 10),
    urls: dedupe(raw.match(URL_REGEX)).slice(0, 10),
  };
}

// --- Family detection --------------------------------------------------------

function detectFamilies(
  scans: FileScanResult[],
  rootDir: string,
): CorpusScanResult['likelyDocumentFamilies'] {
  // Strategy: group files by their frontmatter field signature + heading signature
  const groups = new Map<string, FileScanResult[]>();

  for (const scan of scans) {
    // Fingerprint on frontmatter fields only — headings may vary within a family
    const fieldSig = scan.frontmatterFields.filter(f => f !== 'doc_id' && f !== 'doc_type' && f !== 'schema').sort().join(',');
    const fingerprint = fieldSig;

    const group = groups.get(fingerprint);
    if (group) {
      group.push(scan);
    } else {
      groups.set(fingerprint, [scan]);
    }
  }

  // Convert groups to families (only groups with 2+ files)
  const families: CorpusScanResult['likelyDocumentFamilies'] = [];
  let familyIndex = 0;

  for (const [, members] of groups) {
    if (members.length < 2) continue;
    familyIndex++;

    // Determine shared fields and headings
    const sharedFields = members[0]!.frontmatterFields.filter(f =>
      f !== 'doc_id' && f !== 'doc_type' && f !== 'schema' &&
      members.every(m => m.frontmatterFields.includes(f))
    );
    const sharedHeadings = members[0]!.headings
      .filter(h => members.every(m => m.headings.some(mh => mh.text === h.text && mh.level === h.level)))
      .map(h => h.text);

    // Try to name the family from doc_type or directory
    const docTypes = members
      .map(m => m.frontmatter?.['doc_type'])
      .filter((t): t is string => typeof t === 'string');
    const uniqueDocTypes = [...new Set(docTypes)];

    let name: string;
    if (uniqueDocTypes.length === 1) {
      name = uniqueDocTypes[0]!;
    } else {
      // Use the most common parent directory
      const dirs = members.map(m => path.dirname(path.relative(rootDir, m.filePath)));
      const dirCounts = new Map<string, number>();
      for (const d of dirs) dirCounts.set(d, (dirCounts.get(d) ?? 0) + 1);
      const topDir = [...dirCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      name = topDir ? topDir[0] : `family-${familyIndex}`;
    }

    families.push({
      name,
      fileCount: members.length,
      sharedFields,
      sharedHeadings,
      sampleFiles: members.slice(0, 3).map(m => path.relative(rootDir, m.filePath)),
    });
  }

  return families.sort((a, b) => b.fileCount - a.fileCount);
}

// --- File collection ---------------------------------------------------------

async function collectAllMarkdown(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  const { readdir } = await import('node:fs/promises');

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.name.startsWith('_') || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }

  await walk(dirPath);
  return files.sort();
}
