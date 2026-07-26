// ============================================================================
// 0.7.7 — Multi-process schema-cache coherence.
//
// Reproduces the live bug observed 2026-05-01 in the brain:
//   1. Process A loads schemas, runs maad_reindex --force, populates
//      field_index for all docs (including tags rows for list fields).
//   2. Schema is edited on disk between A's load and B's next write.
//   3. Process B (separate engine instance, separate in-memory schema cache)
//      runs maad_update on a doc. Pre-fix, processDocument used B's stale
//      schema, rewrote field_index without the indexed tag entries — silent
//      corruption of the search/filter index.
//
// Fix: every write entry through runExclusive checks
// schemaStore.isStale() (cheap fstat per cached file). On drift, registry +
// schemas are reloaded in-place before processDocument runs, and a
// schema_cache_stale ops event is emitted.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docId, docType } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-schema-coherence');
const CASE_SCHEMA_PATH = path.join(TEMP_ROOT, '_schema', 'case.v1.yaml');

let engine: MaadEngine;

beforeAll(async () => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, maxRetries: 10, retryDelay: 200 });
  cpSync(FIXTURE_SRC, TEMP_ROOT, { recursive: true });
  const backendDir = path.join(TEMP_ROOT, '_backend');
  if (existsSync(backendDir)) rmSync(backendDir, { recursive: true, maxRetries: 10, retryDelay: 200 });

  engine = new MaadEngine();
  const result = await engine.init(TEMP_ROOT);
  expect(result.ok).toBe(true);
  await engine.indexAll({ force: true });
});

afterAll(async () => {
  engine.close();
  await new Promise(r => setTimeout(r, 100));
  try {
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Windows handle release race — non-fatal
  }
});

describe('schemaStore.isStale — detects on-disk schema drift', () => {
  it('returns false immediately after init (no drift)', () => {
    // Note: typed access — `isStale` is part of SchemaStore now.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ss = (engine as any).schemaStore;
    expect(ss.isStale()).toBe(false);
  });

  it('returns true after a schema file is edited on disk (without reload)', () => {
    const original = readFileSync(CASE_SCHEMA_PATH, 'utf-8');
    // Bump the file with the simplest possible change that mutates content+size
    writeFileSync(CASE_SCHEMA_PATH, original + '\n# touch\n', 'utf-8');
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ss = (engine as any).schemaStore;
      expect(ss.isStale()).toBe(true);
    } finally {
      writeFileSync(CASE_SCHEMA_PATH, original, 'utf-8');
    }
  });

  it('returns true when only mtime changes (utimes), even if size is stable', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ss = (engine as any).schemaStore;
    const cached = ss.cachedFiles.get(CASE_SCHEMA_PATH);
    expect(cached).toBeDefined();
    const newAtime = new Date();
    const newMtime = new Date(cached.mtimeMs + 5000);
    utimesSync(CASE_SCHEMA_PATH, newAtime, newMtime);
    try {
      expect(ss.isStale()).toBe(true);
    } finally {
      // Restore mtime so other tests don't trip over staleness
      utimesSync(CASE_SCHEMA_PATH, newAtime, new Date(cached.mtimeMs));
    }
  });
});

describe('runExclusive — reloads schemas before write when stale', () => {
  it('write entry detects on-disk schema edit and reloads before processing', async () => {
    // Baseline: capture the current case schema content and run a write that
    // fixes the in-mem schema as the loaded one.
    const original = readFileSync(CASE_SCHEMA_PATH, 'utf-8');

    // First write — schemas in sync, no reload should fire.
    const baseline = await engine.createDocument(
      docType('case'),
      { title: 'baseline', client: 'cli-acme', status: 'open' },
      'b',
      'cas-coherence-baseline',
    );
    expect(baseline.ok).toBe(true);

    // Mutate the schema on disk: add an indexed `audit_tag` field. Different
    // process (simulated) edited the schema between writes; engine's in-mem
    // cache doesn't know yet.
    const edited = original.replace(
      '  priority:',
      '  audit_tag:\n    type: string\n    index: true\n  priority:',
    );
    expect(edited).not.toBe(original);
    writeFileSync(CASE_SCHEMA_PATH, edited, 'utf-8');

    try {
      // Now write a doc that sets audit_tag. Pre-fix this would silently
      // drop audit_tag because in-mem schema doesn't know about it. With
      // the fix, runExclusive notices isStale, reloads, and the write
      // includes audit_tag in the field_index.
      const created = await engine.createDocument(
        docType('case'),
        { title: 'audit', client: 'cli-acme', status: 'open', audit_tag: 'pre-launch' },
        'a',
        'cas-coherence-audit',
      );
      expect(created.ok).toBe(true);

      // Filter by the newly-indexed field. If the reload fired, the field
      // appears in the field_index and this query returns the doc; if not,
      // the query returns 0 (the silent-corruption signature).
      const q = engine.findDocuments({
        docType: docType('case'),
        filters: { audit_tag: 'pre-launch' } as never,
      });
      expect(q.ok).toBe(true);
      if (!q.ok) return;
      expect(q.value.results.find(r => (r.docId as string) === 'cas-coherence-audit')).toBeDefined();
    } finally {
      // Restore the schema for downstream tests
      writeFileSync(CASE_SCHEMA_PATH, original, 'utf-8');
      await engine.reload();
      await engine.indexAll({ force: true });
    }
  });

  it('update path also triggers reload-on-stale (the actual repro)', async () => {
    const original = readFileSync(CASE_SCHEMA_PATH, 'utf-8');

    // Seed a doc with audit_tag using the original schema (so the field
    // is just an unindexed extra field for now).
    const seed = await engine.createDocument(
      docType('case'),
      { title: 'update-target', client: 'cli-acme', status: 'open' },
      'seed body',
      'cas-coherence-update',
    );
    expect(seed.ok).toBe(true);

    // Confirm pre-edit query for audit_tag returns nothing (field not in
    // schema, not indexed).
    const before = engine.findDocuments({
      docType: docType('case'),
      filters: { audit_tag: 'flagged' } as never,
    });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    expect(before.value.results.length).toBe(0);

    // Edit the schema on disk to make audit_tag an indexed field.
    const edited = original.replace(
      '  priority:',
      '  audit_tag:\n    type: string\n    index: true\n  priority:',
    );
    writeFileSync(CASE_SCHEMA_PATH, edited, 'utf-8');

    try {
      // Update the seed doc, setting audit_tag. Pre-fix this update would use
      // the stale schema and not index audit_tag.
      const updated = await engine.updateDocument(
        docId('cas-coherence-update'),
        { audit_tag: 'flagged' },
      );
      expect(updated.ok).toBe(true);

      const after = engine.findDocuments({
        docType: docType('case'),
        filters: { audit_tag: 'flagged' } as never,
      });
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      expect(after.value.results.find(r => (r.docId as string) === 'cas-coherence-update')).toBeDefined();
    } finally {
      writeFileSync(CASE_SCHEMA_PATH, original, 'utf-8');
      await engine.reload();
      await engine.indexAll({ force: true });
    }
  });
});

describe('runExclusive — fast path when schemas are fresh', () => {
  it('write entry skips reload when isStale returns false', async () => {
    // After the previous test, schemas should be stable. Run a normal write;
    // the staleness check should return false without triggering reload.
    // (We can't directly observe the absence of a reload from the public
    // API, but we can confirm the engine still works — and the cost is one
    // fstat per cached file, which is fine.)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ss = (engine as any).schemaStore;
    expect(ss.isStale()).toBe(false);

    const r = await engine.createDocument(
      docType('case'),
      { title: 'fast-path', client: 'cli-acme', status: 'open' },
      'fp',
      'cas-coherence-fastpath',
    );
    expect(r.ok).toBe(true);
  });
});
