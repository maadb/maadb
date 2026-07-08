// ============================================================================
// 0.8.3 — CLI exit codes for `maad validate` and `maad reindex`.
//
// Both commands report findings inside a SUCCESSFUL engine result: validate
// returns ok(report) with report.invalid counting structurally invalid docs,
// and full reindex returns ok(IndexResult) with per-file failures in
// errors[]. The commands previously exited 0 in both cases — printing the
// problem and greenlighting CI over it. They now fail closed: nonzero exit
// when validation finds invalid docs or reindex hit per-file errors, while
// still printing the full report. Warnings (reindex) stay advisory.
//
// Tests run the real command functions in-process with process.exit mocked to
// throw a sentinel, so the exit path itself is exercised without spawning the
// built CLI.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { cmdValidate, cmdReindex } from '../../src/cli/commands/maintain.js';
import type { CliContext } from '../../src/cli/helpers.js';

const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-cli-exit-codes');

class ExitSentinel extends Error {
  constructor(public readonly code: number) {
    super(`process.exit(${code})`);
  }
}

let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSentinel(code ?? 0);
  }) as never);
  // Keep test output readable; the commands print full reports.
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  logSpy.mockRestore();
  try {
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Windows handle release race — non-fatal
  }
});

function writeProject(opts?: { invalidDoc?: boolean; unparseableDoc?: boolean }): CliContext {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  mkdirSync(path.join(TEMP_ROOT, '_registry'), { recursive: true });
  mkdirSync(path.join(TEMP_ROOT, '_schema'), { recursive: true });
  mkdirSync(path.join(TEMP_ROOT, 'notes'), { recursive: true });

  writeFileSync(
    path.join(TEMP_ROOT, '_registry', 'object_types.yaml'),
    'types:\n  note:\n    path: notes/\n    id_prefix: note\n    schema: note.v1\n',
    'utf-8',
  );
  writeFileSync(
    path.join(TEMP_ROOT, '_schema', 'note.v1.yaml'),
    'type: note\nversion: 1\nrequired:\n  - doc_id\n  - title\nfields:\n  title:\n    type: string\n    index: true\n',
    'utf-8',
  );
  writeFileSync(
    path.join(TEMP_ROOT, 'notes', 'note-good.md'),
    '---\ndoc_id: note-good\ndoc_type: note\nschema: note.v1\ntitle: fine\n---\n\nbody\n',
    'utf-8',
  );
  if (opts?.invalidDoc) {
    // Structurally invalid (missing required `title`) but indexable — lands in
    // report.invalid, NOT in an engine error result.
    writeFileSync(
      path.join(TEMP_ROOT, 'notes', 'note-bad.md'),
      '---\ndoc_id: note-bad\ndoc_type: note\nschema: note.v1\n---\n\nbody\n',
      'utf-8',
    );
  }
  if (opts?.unparseableDoc) {
    // Broken frontmatter YAML — a per-file reindex error inside ok(IndexResult).
    writeFileSync(
      path.join(TEMP_ROOT, 'notes', 'note-broken.md'),
      '---\nbroken: [yaml\n---\n\nbody\n',
      'utf-8',
    );
  }
  return { args: [], projectRoot: TEMP_ROOT, __dirname };
}

describe('maad validate exit code', () => {
  it('exits 0 (no exit call) when every document is valid', async () => {
    const ctx = writeProject();
    ctx.args = ['validate'];
    await cmdValidate(ctx);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 when any document is structurally invalid, report still printed', async () => {
    const ctx = writeProject({ invalidDoc: true });
    ctx.args = ['validate'];
    await expect(cmdValidate(ctx)).rejects.toThrow(ExitSentinel);
    expect(exitSpy).toHaveBeenCalledWith(1);
    // The report printed before the exit.
    const printed = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(printed).toContain('Invalid: 1');
  });

  it('exits 1 for a single-doc validate of an invalid document', async () => {
    const ctx = writeProject({ invalidDoc: true });
    ctx.args = ['validate', 'note-bad'];
    await expect(cmdValidate(ctx)).rejects.toThrow(ExitSentinel);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('maad reindex exit code', () => {
  it('exits 0 (no exit call) on a clean reindex', async () => {
    const ctx = writeProject();
    ctx.args = ['reindex', '--force'];
    await cmdReindex(ctx);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 when per-file errors occurred, report still printed', async () => {
    const ctx = writeProject({ unparseableDoc: true });
    ctx.args = ['reindex', '--force'];
    await expect(cmdReindex(ctx)).rejects.toThrow(ExitSentinel);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = logSpy.mock.calls.map(c => String(c[0])).join('\n');
    expect(printed).toContain('Errors: 1');
  });
});
