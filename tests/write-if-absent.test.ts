import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileIfAbsent } from '../src/write-if-absent.js';

describe('writeFileIfAbsent', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('creates a missing file', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'maad-write-if-absent-'));
    const file = path.join(dir, 'a.txt');
    expect(writeFileIfAbsent(file, 'new\n')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('new\n');
  });

  it('leaves an existing file untouched', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'maad-write-if-absent-'));
    const file = path.join(dir, 'a.txt');
    writeFileSync(file, 'user content\n', 'utf8');
    expect(writeFileIfAbsent(file, 'generated\n')).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('user content\n');
  });

  it('throws other errors', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'maad-write-if-absent-'));
    expect(() => writeFileIfAbsent(path.join(dir!, 'missing-dir', 'a.txt'), 'x')).toThrow(/ENOENT/);
  });
});
