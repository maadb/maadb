// ============================================================================
// 0.8.1 — collectMarkdownFiles fallback recursion.
//
// When fs.promises.glob throws (older/limited runtimes), the pre-0.8.1
// fallback read only the TOP directory — every doc in a subdirectory silently
// vanished from the scan, and indexAll's stale-row sweep then pruned their
// index rows. The fallback must walk recursively and report that it fired.
// ============================================================================

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    glob: () => {
      throw new Error('glob unavailable (simulated)');
    },
  };
});

// Import AFTER the mock so the helper binds the mocked glob.
import { collectMarkdownFiles } from '../../src/engine/helpers.js';

const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-collect-fallback');

beforeAll(() => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  mkdirSync(path.join(TEMP_ROOT, 'nested', 'deeper'), { recursive: true });
  writeFileSync(path.join(TEMP_ROOT, 'top.md'), '# top\n', 'utf-8');
  writeFileSync(path.join(TEMP_ROOT, 'nested', 'mid.md'), '# mid\n', 'utf-8');
  writeFileSync(path.join(TEMP_ROOT, 'nested', 'deeper', 'leaf.md'), '# leaf\n', 'utf-8');
  writeFileSync(path.join(TEMP_ROOT, 'nested', '_deleted_gone.md'), '# soft-deleted\n', 'utf-8');
  writeFileSync(path.join(TEMP_ROOT, 'nested', 'not-markdown.txt'), 'nope\n', 'utf-8');
});

afterAll(() => {
  try {
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Windows handle release race — non-fatal
  }
});

describe('collectMarkdownFiles glob fallback', () => {
  it('walks recursively, skips _deleted_ and non-markdown, and reports the fallback', async () => {
    const result = await collectMarkdownFiles(TEMP_ROOT);
    expect(result.usedFallback).toBe(true);

    const names = result.files.map(f => path.basename(f)).sort();
    expect(names).toEqual(['leaf.md', 'mid.md', 'top.md']);
  });
});
