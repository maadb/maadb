// ============================================================================
// Engine Helpers — file reading, ID generation, utility functions
// ============================================================================

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { glob } from 'node:fs/promises';
import { parseMatter } from '../parser/matter.js';
import type { DocumentRecord } from '../types.js';
import { isContainedIn, isReallyContainedIn } from './pathguard.js';
import { singleErr, type Result } from '../errors.js';

export class DocumentReadPathError extends Error {
  readonly code = 'PATH_OUTSIDE_PROJECT';
}

function checkedDocumentPath(projectRoot: string, doc: Pick<DocumentRecord, 'filePath'>): string {
  const absPath = path.resolve(projectRoot, doc.filePath as string);
  if (!isContainedIn(absPath, projectRoot) || !isReallyContainedIn(absPath, projectRoot)) {
    throw new DocumentReadPathError('Document path cannot be verified inside the project root');
  }
  return absPath;
}

/** Recheck each disk read; indexed paths may have been replaced since indexing. */
export async function readDocumentContent(projectRoot: string, doc: Pick<DocumentRecord, 'filePath'>): Promise<string> {
  return readFile(checkedDocumentPath(projectRoot, doc), 'utf-8');
}

export async function withDocumentReadBoundary<T>(read: () => Promise<Result<T>>): Promise<Result<T>> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof DocumentReadPathError) return singleErr(error.code, error.message);
    throw error;
  }
}

/**
 * 0.7.12 — canonical relative-path helper. path.relative emits native
 * separators (backslash on Windows); we store and look up file_path in
 * forward-slash form so the SQLite index stays portable across platforms.
 * Every write-path site that builds a documents.file_path value should
 * route through this helper.
 */
export function toCanonicalRelPath(projectRoot: string, absPath: string): string {
  return path.relative(projectRoot, absPath).split(path.sep).join('/');
}

export async function readFrontmatter(projectRoot: string, doc: DocumentRecord): Promise<Record<string, unknown>> {
  const raw = await readDocumentContent(projectRoot, doc);
  const parsed = parseMatter(raw);
  return parsed.data as Record<string, unknown>;
}

export function readFrontmatterSync(projectRoot: string, doc: DocumentRecord): Record<string, unknown> | null {
  try {
    const absPath = checkedDocumentPath(projectRoot, doc);
    const raw = readFileSync(absPath, 'utf-8');
    const parsed = parseMatter(raw);
    return parsed.data as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function readBlockContent(projectRoot: string, doc: DocumentRecord, startLine: number, endLine: number, isPreamble: boolean): Promise<string> {
  const raw = await readDocumentContent(projectRoot, doc);
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
    // 0.8.1 — tolerate a leading currency marker ("$100", "€ 1,500", "USD 25").
    // Amounts written with a symbol previously extracted null and silently
    // dropped out of numeric filters/sorts.
    const match = /^\s*(?:[^\d\s]{1,3}|[A-Za-z]{3})?\s*([\d,.]+)/.exec(String(value));
    if (match) {
      const num = parseFloat(match[1]!.replace(/,/g, ''));
      return isFinite(num) ? num : null;
    }
    return null;
  }

  return null;
}

export interface CollectedMarkdownFiles {
  files: string[];
  /**
   * 0.8.1 — true when fs.promises.glob threw and the manual walk ran instead.
   * Surfaced so indexAll can warn: before 0.8.1 the fallback was silently
   * NON-recursive, so on any runtime where glob failed, every nested doc
   * vanished from the scan and the stale-row sweep pruned its index row.
   */
  usedFallback: boolean;
}

export async function collectMarkdownFiles(dirPath: string): Promise<CollectedMarkdownFiles> {
  const files: string[] = [];
  try {
    for await (const entry of glob('**/*.md', { cwd: dirPath })) {
      const basename = path.basename(entry as string);
      if (basename.startsWith('_deleted_')) continue;
      files.push(path.join(dirPath, entry as string));
    }
    return { files, usedFallback: false };
  } catch {
    // Recursive manual walk — must match glob('**/*.md') coverage. The
    // pre-0.8.1 fallback read only the top directory, which silently dropped
    // every nested doc from the scan.
    const { readdir } = await import('node:fs/promises');
    const walk = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name));
        } else if (entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('_deleted_')) {
          files.push(path.join(dir, entry.name));
        }
      }
    };
    await walk(dirPath);
    return { files, usedFallback: true };
  }
}
