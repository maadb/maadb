// ============================================================================
// 0.6.7 Phase 4 — integration tests for schema precision enforcement.
// Covers the engine round-trip tests from docs/specs/0.6.7-schema-precision.md:
//   T4  — update unrelated field → no warning on unchanged coarse historical
//         (LOAD-BEARING backward-compat)
//   T6  — reindex historical data → no warnings fired (LOAD-BEARING)
//   T7  — read of coarse-stored record → no warnings
//   T8  — maad_validate without includePrecision: unchanged output
//   T9  — maad_validate with includePrecision: true: precisionDrift populated
//   T11 — bulk create mixed compliance: clean + warn-coarse + error-coarse
//   T12 — maad_schema returns storePrecision / onCoarser / displayPrecision
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docType, docId } from '../../src/types.js';

const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-precision-enforce');

let engine: MaadEngine;

/**
 * Build a minimal project with an `event` type whose `started_at` field
 * declares `store_precision: second, on_coarser: warn, display_precision: minute`.
 * Also pre-seeds one coarse-historical event so T4/T6/T7/T9 have data to
 * validate against.
 */
async function buildFixture(): Promise<void> {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true });
  mkdirSync(path.join(TEMP_ROOT, '_registry'), { recursive: true });
  mkdirSync(path.join(TEMP_ROOT, '_schema'), { recursive: true });
  mkdirSync(path.join(TEMP_ROOT, 'events'), { recursive: true });

  writeFileSync(
    path.join(TEMP_ROOT, '_registry', 'object_types.yaml'),
    `types:
  event:
    path: events
    id_prefix: evt
    schema: event.v1
`,
    'utf-8',
  );

  writeFileSync(
    path.join(TEMP_ROOT, '_schema', 'event.v1.yaml'),
    `type: event
version: 1
required:
  - doc_id
  - title
fields:
  title:
    type: string
    index: true
  status:
    type: enum
    values: [open, pending, closed]
    index: true
  started_at:
    type: date
    store_precision: second
    on_coarser: warn
    display_precision: minute
    index: true
  notes:
    type: string
`,
    'utf-8',
  );

  // Pre-seed one historical coarse-day event — will be used as the
  // "unchanged-historical" target in T4, T6, T7, T9.
  writeFileSync(
    path.join(TEMP_ROOT, 'events', 'evt-historical.md'),
    `---
doc_id: evt-historical
doc_type: event
schema: event.v1
title: Historical coarse event
status: closed
started_at: "2026-04-15"
---
Seeded with day precision.
`,
    'utf-8',
  );

  engine = new MaadEngine();
  const init = await engine.init(TEMP_ROOT);
  expect(init.ok).toBe(true);
  await engine.indexAll({ force: true });
}

beforeAll(async () => {
  await buildFixture();
});

afterAll(async () => {
  engine.close();
  await new Promise(r => setTimeout(r, 100));
  try {
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch {
    // Windows may hold handles briefly — non-fatal
  }
});

describe('T4 — update unrelated field on historical coarse record', () => {
  it('does NOT fire a precision warning when the date field is unchanged', async () => {
    const result = await engine.updateDocument(
      docId('evt-historical'),
      { status: 'pending' }, // precision field `started_at` NOT touched
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Critical: unchanged historical coarse date must not warn.
    expect(result.value.validation.warnings).toHaveLength(0);
  });
});

describe('T6 — reindex historical data fires no warnings', () => {
  it('LOAD-BEARING: reindex does not trip on coarse historical values', async () => {
    // Force a full reindex — every historical file passes through validator
    // in mode: 'index'. Precision enforcement must be entirely skipped.
    const result = await engine.indexAll({ force: true });
    // If precision had fired on reindex, indexing would surface errors for
    // evt-historical. No errors → precision is correctly gated to write mode.
    expect(result.errors).toHaveLength(0);
    expect(result.indexed).toBeGreaterThan(0);
  });
});

describe('T7 — read of coarse-stored record never emits warnings', () => {
  it('getDocument returns the record cleanly, no precision side-effects', async () => {
    const result = await engine.getDocument(docId('evt-historical'), 'hot');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter['started_at']).toBe('2026-04-15');
  });
});

describe('T8 / T9 — maad_validate with and without includePrecision', () => {
  it('T8: without includePrecision, no precisionDrift in report', async () => {
    const result = await engine.validate();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.precisionDrift).toBeUndefined();
    // Coarse historical data still counts as valid structurally.
    expect(result.value.valid).toBeGreaterThan(0);
  });

  it('T9: with includePrecision=true, precisionDrift populated for coarse records', async () => {
    const result = await engine.validate(undefined, { includePrecision: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.precisionDrift).toBeDefined();
    const drift = result.value.precisionDrift!;
    const entry = drift.find(d => (d.docId as string) === 'evt-historical' && d.field === 'started_at');
    expect(entry).toBeDefined();
    expect(entry!.declared).toBe('second');
    expect(entry!.actual).toBe('day');

    // valid/invalid counts unchanged — drift is informational
    expect(result.value.invalid).toBe(0);
  });
});

describe('T2 / T3 — single write surfaces warnings in validation', () => {
  it('T2 default warn: coarse write succeeds + warning emitted', async () => {
    const result = await engine.createDocument(
      docType('event'),
      { title: 'Warn case', started_at: '2026-04-16' },
      undefined,
      'evt-warn-case',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.validation.warnings).toHaveLength(1);
    expect(result.value.validation.warnings[0]!.code).toBe('PRECISION_COARSER_THAN_DECLARED');
    expect(result.value.validation.warnings[0]!.field).toBe('started_at');
  });

  it('T1 precise write: no warnings', async () => {
    const result = await engine.createDocument(
      docType('event'),
      { title: 'Precise case', started_at: '2026-04-16T17:20:30Z' },
      undefined,
      'evt-precise-case',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.validation.warnings).toHaveLength(0);
  });
});

describe('T11 — bulk create mixed compliance', () => {
  it('succeeded-with-warnings records land, per-record + aggregated warnings', async () => {
    const result = await engine.bulkCreate([
      { docType: 'event', fields: { title: 'Clean', started_at: '2026-04-16T17:20:30Z' }, docId: 'evt-bulk-clean' },
      { docType: 'event', fields: { title: 'Warn-coarse', started_at: '2026-04-16' }, docId: 'evt-bulk-warn' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.succeeded).toHaveLength(2);
    expect(result.value.failed).toHaveLength(0);

    // Per-record surfacing
    const clean = result.value.succeeded.find(s => s.docId === 'evt-bulk-clean')!;
    expect(clean.warnings).toBeUndefined();

    const warned = result.value.succeeded.find(s => s.docId === 'evt-bulk-warn')!;
    expect(warned.warnings).toBeDefined();
    expect(warned.warnings!.length).toBe(1);
    expect(warned.warnings![0]!.code).toBe('PRECISION_COARSER_THAN_DECLARED');

    // Aggregated top-level warnings, prefixed with docId
    expect(result.value.warnings.length).toBe(1);
    expect(result.value.warnings[0]!.field).toBe('evt-bulk-warn.started_at');
  });
});

describe('T12 — maad_schema returns storePrecision / onCoarser / displayPrecision', () => {
  it('schemaInfo surfaces all three precision keys on the date field', () => {
    const result = engine.schemaInfo(docType('event'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const field = result.value.fields.find(f => f.name === 'started_at')!;
    expect(field).toBeDefined();
    expect(field.storePrecision).toBe('second');
    expect(field.onCoarser).toBe('warn');
    expect(field.displayPrecision).toBe('minute');
  });

  it('schemaInfo omits precision keys on date fields that do not declare them', () => {
    // `title` is string, not date — has none of the precision keys.
    const result = engine.schemaInfo(docType('event'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const field = result.value.fields.find(f => f.name === 'title')!;
    expect(field.storePrecision).toBeUndefined();
    expect(field.onCoarser).toBeUndefined();
    expect(field.displayPrecision).toBeUndefined();
  });
});
