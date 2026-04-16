// ============================================================================
// Engine Helpers — file reading, ID generation, utility functions
// ============================================================================

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { glob } from 'node:fs/promises';
import { parseMatter } from '../parser/matter.js';
import type { DocumentRecord } from '../types.js';

export async function readFrontmatter(projectRoot: string, doc: DocumentRecord): Promise<Record<string, unknown>> {
  const absPath = path.join(projectRoot, doc.filePath as string);
  const raw = await readFile(absPath, 'utf-8');
  const parsed = parseMatter(raw);
  return parsed.data as Record<string, unknown>;
}

export function readFrontmatterSync(projectRoot: string, doc: DocumentRecord): Record<string, unknown> | null {
  try {
    const absPath = path.join(projectRoot, doc.filePath as string);
    const raw = readFileSync(absPath, 'utf-8');
    const parsed = parseMatter(raw);
    return parsed.data as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function readBlockContent(projectRoot: string, doc: DocumentRecord, startLine: number, endLine: number, isPreamble: boolean): Promise<string> {
  const absPath = path.join(projectRoot, doc.filePath as string);
  const raw = await readFile(absPath, 'utf-8');
  const lines = raw.split('\n');
  const contentStart = isPreamble ? startLine - 1 : startLine;
  const contentEnd = endLine;
  return lines.slice(contentStart, contentEnd).join('\n').trim();
}

export function generateDocId(prefix: string, fields: Record<string, unknown>, existingIds?: string[]): string {
  const nameOrTitle = fields['name'] ?? fields['title'];

  // Slug strategy: use name/title if available
  if (typeof nameOrTitle === 'string') {
    const slug = nameOrTitle
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    if (slug.length > 0) return `${prefix}-${slug}`;
  }

  // Sequence strategy: prefix-YYYY-NNN
  const year = new Date().getFullYear();
  const seqPrefix = `${prefix}-${year}-`;
  let maxSeq = 0;

  if (existingIds) {
    for (const id of existingIds) {
      if (id.startsWith(seqPrefix)) {
        const seqStr = id.slice(seqPrefix.length);
        const num = parseInt(seqStr, 10);
        if (!isNaN(num) && num > maxSeq) maxSeq = num;
      }
    }
  }

  return `${seqPrefix}${String(maxSeq + 1).padStart(3, '0')}`;
}

export function computeNumericValue(value: unknown, fieldType: string): number | null {
  if (value === null || value === undefined) return null;

  if (fieldType === 'number') {
    const num = typeof value === 'number' ? value : parseFloat(String(value));
    return isFinite(num) ? num : null;
  }

  if (fieldType === 'amount') {
    const match = /^([\d,.]+)/.exec(String(value));
    if (match) {
      const num = parseFloat(match[1]!.replace(/,/g, ''));
      return isFinite(num) ? num : null;
    }
    return null;
  }

  return null;
}

export async function collectMarkdownFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of glob('**/*.md', { cwd: dirPath })) {
      const basename = path.basename(entry as string);
      if (basename.startsWith('_deleted_')) continue;
      files.push(path.join(dirPath, entry as string));
    }
  } catch {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('_deleted_')) {
        files.push(path.join(dirPath, entry.name));
      }
    }
  }
  return files;
}
