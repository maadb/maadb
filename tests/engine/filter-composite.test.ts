// 0.7.1 R2 — range / composite filters
//
// Filter input accepts:
//   - scalar shorthand (implicit eq)
//   - single FilterCondition object
//   - { op: "between", value: [lo, hi] } shortcut (inclusive, desugars to [gte, lte])
//   - array of FilterConditions (AND semantics, between desugared inside)
//
// Validation happens at the engine layer (`expandFilters` in src/engine/reads.ts)
// before reaching the backend. Error codes: FILTER_BETWEEN_INVALID,
// FILTER_EMPTY_ARRAY, FILTER_OP_INVALID. Applies identically to findDocuments
// and aggregate.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docType } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-filter-composite');

let engine: MaadEngine;

beforeAll(async () => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true });
  cpSync(FIXTURE_SRC, TEMP_ROOT, { recursive: true });
  const backendDir = path.join(TEMP_ROOT, '_backend');
  if (existsSync(backendDir)) rmSync(backendDir, { recursive: true });

  engine = new MaadEngine();
  const init = await engine.init(TEMP_ROOT);
  expect(init.ok).toBe(true);
  await engine.indexAll({ force: true });

  // Seed cases across a date range so between / array-of-ops have something to hit.
  const cli = await engine.createDocument(docType('client'), { name: 'Filter Client', status: 'active' }, 'c');
  expect(cli.ok).toBe(true);
  if (!cli.ok) return;

  const dates = ['2026-02-15', '2026-03-01', '2026-03-15', '2026-03-31', '2026-04-01', '2026-04-15'];
  for (const d of dates) {
    await engine.createDocument(docType('case'), {
      title: `case-${d}`, client: cli.value.docId, status: 'open', opened_at: d,
    }, `case ${d}`);
  }
  await engine.indexAll({ force: true });
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

describe('between shortcut — inclusive bounds', () => {
  it('includes both endpoints (March 1-31 hits 3 dates: 03-01, 03-15, 03-31)', () => {
    const result = engine.findDocuments({
      docType: docType('case'),
      filters: { opened_at: { op: 'between', value: ['2026-03-01', '2026-03-31'] } } as any,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(3);
  });

  it('rejects non-2-tuple value with FILTER_BETWEEN_INVALID', () => {
    const result = engine.findDocuments({
      docType: docType('case'),
      filters: { opened_at: { op: 'between', value: ['2026-03-01'] } } as any,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('FILTER_BETWEEN_INVALID');
  });

  it('rejects when lo > hi (numeric)', () => {
    const result = engine.findDocuments({
      docType: docType('case'),
      filters: { opened_at: { op: 'between', value: [100, 50] } } as any,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('FILTER_BETWEEN_INVALID');
  });

  it('rejects when lo > hi (string, lexical)', () => {
    const result = engine.findDocuments({
      docType: docType('case'),
      filters: { opened_at: { op: 'between', value: ['2026-03-31', '2026-03-01'] } } as any,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('FILTER_BETWEEN_INVALID');
  });

  it('rejects when a bound is null/undefined', () => {
    const result = engine.findDocuments({
      docType: docType('case'),
      filters: { opened_at: { op: 'between', value: [null, '2026-03-31'] } } as any,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('FILTER_BETWEEN_INVALID');
  });
});

describe('array-of-ops — AND semantics', () => {
  it('gte + lte combined with AND yields the intersection', () => {
    const result = engine.findDocuments({
      docType: docType('case'),
      filters: {
        opened_at: [
          { op: 'gte', value: '2026-03-01' },
          { op: 'lte', value: '2026-03-31' },
        ],
      } as any,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(3);
  });

  it('gte + lt + neq — three-way AND intersection', () => {
    // Scope tightly to March + exclude 03-15.
    // March dates in the corpus: 03-01, 03-15, 03-31. Minus 03-15 → 2 cases.
    const result = engine.findDocuments({
      docType: docType('case'),
      filters: {
        opened_at: [
          { op: 'gte', value: '2026-03-01' },
          { op: 'lt', value: '2026-04-01' },
          { op: 'neq', value: '2026-03-15' },
        ],
      } as any,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(2);
  });

  it('rejects empty array with FILTER_EMPTY_ARRAY', () => {
    const result = engine.findDocuments({
      docType: docType('case'),
      filters: { opened_at: [] } as any,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('FILTER_EMPTY_ARRAY');
  });

  it('rejects unknown op with FILTER_OP_INVALID', () => {
    const result = engine.findDocuments({
      docType: docType('case'),
      filters: { opened_at: { op: 'not_an_op', value: 'x' } } as any,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('FILTER_OP_INVALID');
  });

  it('expands between inside array-of-ops', () => {
    // Mixing between within an array: inner between desugars to [gte, lte],
    // outer array ANDs everything. Combined with neq this should still work.
    const result = engine.findDocuments({
      docType: docType('case'),
      filters: {
        opened_at: [
          { op: 'between', value: ['2026-03-01', '2026-03-31'] },
          { op: 'neq', value: '2026-03-15' },
        ],
      } as any,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // March range = 3 dates; exclude 03-15 → 2
    expect(result.value.total).toBe(2);
  });
});

describe('composite filters — mixed with other fields', () => {
  it('between on one field + shorthand eq on another', () => {
    const result = engine.findDocuments({
      docType: docType('case'),
      filters: {
        opened_at: { op: 'between', value: ['2026-03-01', '2026-03-31'] },
        status: 'open',
      } as any,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(3);
  });
});

describe('composite filters — aggregate', () => {
  it('aggregate respects between on filters', () => {
    const result = engine.aggregate({
      docType: docType('case'),
      groupBy: 'status',
      filters: { opened_at: { op: 'between', value: ['2026-03-01', '2026-03-31'] } } as any,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 3 March cases, all 'open' status
    const open = result.value.groups.find(g => g.value === 'open');
    expect(open?.count).toBe(3);
  });

  it('aggregate with R1 ref-chain + R2 between (canonical jrn-2026-093 shape)', () => {
    // case_note grouped by its case's status, filtered to March 2026.
    // This combines R1 (ref chain in groupBy) + R2 (between filter) into the
    // kind of single-call cross-doctype aggregate jrn-2026-093 called out.
    const result = engine.aggregate({
      docType: docType('case'),
      groupBy: 'client->status',
      filters: { opened_at: { op: 'between', value: ['2026-03-01', '2026-03-31'] } } as any,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 3 cases in March, all tied to the 'Filter Client' (status: active)
    const active = result.value.groups.find(g => g.value === 'active');
    expect(active?.count).toBe(3);
  });
});
