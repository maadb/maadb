// ============================================================================
// 0.6.7 Phase 4 — validator-level precision enforcement tests.
// T1, T2, T3, T5 from docs/specs/0.6.7-schema-precision.md.
//
// These tests go directly against validateFrontmatter with synthesized
// schemas, so they don't require any fixture or engine init. Integration
// tests (T4, T6, T7, T8, T9, T11, T12) live in
// tests/engine/precision-enforcement.test.ts.
// ============================================================================

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { validateFrontmatter } from '../../src/schema/validator.js';
import { loadRegistry } from '../../src/registry/loader.js';
import { docType, type Registry, type SchemaDefinition, type FieldDefinition } from '../../src/types.js';
import type { Precision } from '../../src/schema/precision.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/simple-crm');
let registry: Registry;

beforeAll(async () => {
  const regResult = await loadRegistry(FIXTURE_ROOT);
  if (!regResult.ok) throw new Error('Failed to load registry');
  registry = regResult.value;
});

// Helper: build a minimal schema with a single precision-declaring date field.
function schemaWithDateField(opts: {
  fieldName?: string;
  storePrecision: Precision | null;
  onCoarser?: 'warn' | 'error' | null;
  displayPrecision?: Precision | null;
}): SchemaDefinition {
  const name = opts.fieldName ?? 'ts';
  const field: FieldDefinition = {
    name,
    type: 'date',
    index: false,
    role: null,
    // Leave format null so the structural YYYY-MM-DD regex doesn't fire.
    // Precision DSL is orthogonal to legacy `format` — a real schema that
    // declares store_precision: year would not also pin format: YYYY-MM-DD.
    format: null,
    target: null,
    values: null,
    defaultValue: null,
    itemType: null,
    storePrecision: opts.storePrecision,
    onCoarser: opts.onCoarser ?? (opts.storePrecision !== null ? 'warn' : null),
    displayPrecision: opts.displayPrecision ?? null,
  };
  return {
    type: docType('test'),
    version: 1,
    required: [],
    fields: new Map([[name, field]]),
    template: null,
  };
}

describe('T1 — write value matches store_precision → ok, no warnings', () => {
  it('second-precision value satisfies store_precision=second', () => {
    const schema = schemaWithDateField({ storePrecision: 'second' });
    const result = validateFrontmatter(
      { doc_id: 'x-1', doc_type: 'test', schema: 'test.v1', ts: '2026-04-16T17:20:00Z' },
      schema,
      registry,
      undefined,
      { mode: 'write' },
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('finer-than-declared value passes (storage-wins rule)', () => {
    const schema = schemaWithDateField({ storePrecision: 'day' });
    const result = validateFrontmatter(
      { doc_id: 'x-1', doc_type: 'test', schema: 'test.v1', ts: '2026-04-16T17:20:30.500Z' },
      schema,
      registry,
      undefined,
      { mode: 'write' },
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('exact-match day precision when declared day', () => {
    const schema = schemaWithDateField({ storePrecision: 'day' });
    const result = validateFrontmatter(
      { doc_id: 'x-1', doc_type: 'test', schema: 'test.v1', ts: '2026-04-16' },
      schema,
      registry,
      undefined,
      { mode: 'write' },
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('T2 — coarser value with on_coarser=warn (default) → ok, _meta.warnings[]', () => {
  it('day-precision value vs store_precision=second warns, write succeeds', () => {
    const schema = schemaWithDateField({ storePrecision: 'second', onCoarser: 'warn' });
    const result = validateFrontmatter(
      { doc_id: 'x-1', doc_type: 'test', schema: 'test.v1', ts: '2026-04-16' },
      schema,
      registry,
      undefined,
      { mode: 'write' },
    );
    expect(result.valid).toBe(true); // write NOT blocked
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.code).toBe('PRECISION_COARSER_THAN_DECLARED');
    expect(result.warnings[0]!.field).toBe('ts');
    expect(result.warnings[0]!.message).toContain('day-precision');
    expect(result.warnings[0]!.message).toContain('store_precision=second');
  });

  it('year-only value vs store_precision=minute warns', () => {
    const schema = schemaWithDateField({ storePrecision: 'minute' });
    const result = validateFrontmatter(
      { doc_id: 'x-1', doc_type: 'test', schema: 'test.v1', ts: '2026' },
      schema,
      registry,
      undefined,
      { mode: 'write' },
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.message).toContain('year-precision');
  });

  it('defaults on_coarser to warn when store_precision declared without on_coarser', () => {
    const schema = schemaWithDateField({ storePrecision: 'hour', onCoarser: null });
    const result = validateFrontmatter(
      { doc_id: 'x-1', doc_type: 'test', schema: 'test.v1', ts: '2026-04-16' },
      schema,
      registry,
      undefined,
      { mode: 'write' },
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });
});

describe('T3 — coarser value with on_coarser=error → VALIDATION_FAILED, write blocked', () => {
  it('rejects the write and emits no warning (structural error instead)', () => {
    const schema = schemaWithDateField({ storePrecision: 'second', onCoarser: 'error' });
    const result = validateFrontmatter(
      { doc_id: 'x-1', doc_type: 'test', schema: 'test.v1', ts: '2026-04-16' },
      schema,
      registry,
      undefined,
      { mode: 'write' },
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.field).toBe('ts');
    expect(result.errors[0]!.message).toContain('day-precision');
    expect(result.errors[0]!.message).toContain('store_precision=second');
    expect(result.warnings).toHaveLength(0); // errors-only path
  });
});

describe('T5 — update touches the date field with a coarser value', () => {
  it('warns when the date is in changedFields and value is coarser', () => {
    const schema = schemaWithDateField({ storePrecision: 'second', onCoarser: 'warn' });
    const result = validateFrontmatter(
      { doc_id: 'x-1', doc_type: 'test', schema: 'test.v1', ts: '2026-04-16' },
      schema,
      registry,
      undefined,
      { mode: 'write', changedFields: new Set(['ts']) },
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });

  it('errors when on_coarser=error and date is in changedFields', () => {
    const schema = schemaWithDateField({ storePrecision: 'second', onCoarser: 'error' });
    const result = validateFrontmatter(
      { doc_id: 'x-1', doc_type: 'test', schema: 'test.v1', ts: '2026-04-16' },
      schema,
      registry,
      undefined,
      { mode: 'write', changedFields: new Set(['ts']) },
    );
    expect(result.valid).toBe(false);
  });
});

describe('T4 (validator slice) — update with changedFields excluding the date field', () => {
  it('skips precision check on unchanged coarse date, no warning', () => {
    const schema = schemaWithDateField({ storePrecision: 'second', onCoarser: 'warn' });
    const result = validateFrontmatter(
      { doc_id: 'x-1', doc_type: 'test', schema: 'test.v1', ts: '2026-04-16' /* historical coarse */ },
      schema,
      registry,
      undefined,
      // ts is NOT in changedFields — update touched a neighbor.
      { mode: 'write', changedFields: new Set(['some_other_field']) },
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('STILL skips precision check when on_coarser=error and field unchanged', () => {
    const schema = schemaWithDateField({ storePrecision: 'second', onCoarser: 'error' });
    const result = validateFrontmatter(
      { doc_id: 'x-1', doc_type: 'test', schema: 'test.v1', ts: '2026-04-16' },
      schema,
      registry,
      undefined,
      { mode: 'write', changedFields: new Set(['other']) },
    );
    // Load-bearing: update of neighbor must not fail on historical coarse data.
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});

describe('T6 (validator slice) — mode !== write skips precision enforcement entirely', () => {
  const schema = schemaWithDateField({ storePrecision: 'second', onCoarser: 'error' });
  const fm = { doc_id: 'x-1', doc_type: 'test', schema: 'test.v1', ts: '2026-04-15' };

  it('mode: read skips enforcement', () => {
    const result = validateFrontmatter(fm, schema, registry, undefined, { mode: 'read' });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('mode: index skips enforcement', () => {
    const result = validateFrontmatter(fm, schema, registry, undefined, { mode: 'index' });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('mode: audit skips enforcement', () => {
    const result = validateFrontmatter(fm, schema, registry, undefined, { mode: 'audit' });
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('default mode (no options) = read — safe', () => {
    const result = validateFrontmatter(fm, schema, registry);
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

describe('precision enforcement edge cases', () => {
  it('Date objects classified as millisecond precision', () => {
    const schema = schemaWithDateField({ storePrecision: 'minute' });
    // Date is finer than minute, so passes.
    const result = validateFrontmatter(
      { doc_id: 'x-1', doc_type: 'test', schema: 'test.v1', ts: new Date('2026-04-16T17:20:30Z') },
      schema,
      registry,
      undefined,
      { mode: 'write' },
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it('malformed date string skips precision check (structural validator handles)', () => {
    const schema = schemaWithDateField({ storePrecision: 'second' });
    const result = validateFrontmatter(
      { doc_id: 'x-1', doc_type: 'test', schema: 'test.v1', ts: 'not-a-date' },
      schema,
      registry,
      undefined,
      { mode: 'write' },
    );
    // Structural validation passes because the date regex is unanchored and
    // "not-a-date" doesn't match (so it's still flagged at structural level).
    // Either way, precision check is skipped for malformed input — we only
    // assert the warning channel stays clean from precision code.
    expect(result.warnings.filter(w => w.code === 'PRECISION_COARSER_THAN_DECLARED')).toHaveLength(0);
  });

  it('field without storePrecision is never checked', () => {
    const schema = schemaWithDateField({ storePrecision: null });
    const result = validateFrontmatter(
      { doc_id: 'x-1', doc_type: 'test', schema: 'test.v1', ts: '2026' }, // year-only
      schema,
      registry,
      undefined,
      { mode: 'write' },
    );
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });
});
