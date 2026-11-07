// ============================================================================
// Aggregate totals contract. `total` and `totalMetric` cover the whole scope,
// so they never move with `limit`; `truncated`, `groupsReturned` and
// `groupsTotal` say when groups were cut; records with no value for the group
// field are reported in `missing` instead of disappearing.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docType } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-aggregate-totals');

const ENTRY_SCHEMA = `type: time_entry
version: 1
required:
  - doc_id
  - title
fields:
  title:
    type: string
    index: true
  account:
    type: string
    index: true
  client_ref:
    type: ref
    target: client
    index: true
  hours:
    type: number
    index: true
  tags:
    type: list
    item_type: string
    index: true
  note:
    type: string
  rawhours:
    type: number
`;

// Declares `account` but no record sets it.
const OTHER_SCHEMA = `type: other_entry
version: 1
required:
  - doc_id
  - title
fields:
  title:
    type: string
    index: true
  account:
    type: string
    index: true
  hours:
    type: number
    index: true
`;

const TIME_ENTRY = docType('time_entry');

// Six groups by account plus two records with no account.
//   a: 3 records, 6h. b: 2 records, 5h, one with no hours. c, d, e: 1 record each.
//   f: 1 record, no hours at all. (none): 2 records, 7h.
const ENTRIES: Array<Record<string, unknown>> = [
  { title: 'e1', account: 'a', hours: 1, tags: ['x', 'y'], note: 'n', rawhours: 10 },
  { title: 'e2', account: 'a', hours: 2, tags: ['x'] },
  { title: 'e3', account: 'a', hours: 3 },
  { title: 'e4', account: 'b', hours: 5, tags: ['y'] },
  { title: 'e5', account: 'b' },
  { title: 'e6', account: 'c', hours: 1 },
  { title: 'e7', account: 'd', hours: 1 },
  { title: 'e8', account: 'e', hours: 1 },
  { title: 'e9', account: 'f' },
  { title: 'e10', hours: 3 },
  { title: 'e11', hours: 4 },
];
const ALL_HOURS = 21;

let engine: MaadEngine;
let clientA = '';
let clientB = '';

beforeAll(async () => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  cpSync(FIXTURE_SRC, TEMP_ROOT, { recursive: true });
  const backendDir = path.join(TEMP_ROOT, '_backend');
  if (existsSync(backendDir)) rmSync(backendDir, { recursive: true, maxRetries: 10, retryDelay: 200 });

  writeFileSync(path.join(TEMP_ROOT, '_schema', 'time_entry.v1.yaml'), ENTRY_SCHEMA, 'utf-8');
  writeFileSync(path.join(TEMP_ROOT, '_schema', 'other_entry.v1.yaml'), OTHER_SCHEMA, 'utf-8');
  const registryPath = path.join(TEMP_ROOT, '_registry', 'object_types.yaml');
  const registry = readFileSync(registryPath, 'utf-8');
  writeFileSync(
    registryPath,
    registry.replace(
      'extraction:',
      '  time_entry:\n    path: time_entries/\n    id_prefix: te\n    schema: time_entry.v1\n' +
      '  other_entry:\n    path: other_entries/\n    id_prefix: oe\n    schema: other_entry.v1\n\nextraction:',
    ),
    'utf-8',
  );
  mkdirSync(path.join(TEMP_ROOT, 'time_entries'), { recursive: true });
  mkdirSync(path.join(TEMP_ROOT, 'other_entries'), { recursive: true });

  engine = new MaadEngine();
  const initResult = await engine.init(TEMP_ROOT);
  expect(initResult.ok).toBe(true);
  await engine.indexAll({ force: true });

  const a = await engine.createDocument(docType('client'), { name: 'Totals A', status: 'active' }, 'A');
  const b = await engine.createDocument(docType('client'), { name: 'Totals B', status: 'active' }, 'B');
  expect(a.ok && b.ok).toBe(true);
  if (!a.ok || !b.ok) return;
  clientA = a.value.docId as string;
  clientB = b.value.docId as string;

  for (const [i, fields] of ENTRIES.entries()) {
    // e1-e4 point at client A, e5 at client B (no hours), e6 at a broken ref.
    const client_ref = i < 4 ? clientA : i === 4 ? clientB : i === 5 ? 'cli-does-not-exist' : undefined;
    const created = await engine.createDocument(
      TIME_ENTRY,
      client_ref === undefined ? fields : { ...fields, client_ref },
      String(fields['title']),
    );
    expect(created.ok).toBe(true);
  }

  for (const hours of [100, 200]) {
    const created = await engine.createDocument(docType('other_entry'), { title: `o${hours}`, hours }, `o${hours}`);
    expect(created.ok).toBe(true);
  }
});

afterAll(async () => {
  engine.close();
  await new Promise(r => setTimeout(r, 100));
  try {
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Windows may hold handles briefly — non-fatal
  }
});

function run(query: Omit<Parameters<MaadEngine['aggregate']>[0], 'docType'>) {
  const result = engine.aggregate({ docType: TIME_ENTRY, ...query });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('aggregate failed');
  return result.value;
}

describe('aggregate totals — limit', () => {
  it('reports truncation and keeps total when limit cuts groups', () => {
    const value = run({ groupBy: 'account', limit: 2 });
    expect(value.groups).toHaveLength(2);
    expect(value.groupsReturned).toBe(2);
    expect(value.groupsTotal).toBe(6);
    expect(value.truncated).toBe(true);
    expect(value.total).toBe(ENTRIES.length);
  });

  it('reports no truncation when every group fits', () => {
    const value = run({ groupBy: 'account', limit: 6 });
    expect(value.groupsReturned).toBe(6);
    expect(value.groupsTotal).toBe(6);
    expect(value.truncated).toBe(false);
  });

  it('does not move total or totalMetric with limit', () => {
    for (const limit of [1, 2, 3, 50]) {
      const value = run({ groupBy: 'account', metric: { field: 'hours', op: 'sum' }, limit });
      expect(value.total).toBe(ENTRIES.length);
      expect(value.totalMetric).toBe(ALL_HOURS);
    }
  });

  it('reports truncation on an empty scope as false', () => {
    const value = run({ groupBy: 'account', filters: { title: { op: 'eq', value: 'nothing' } } });
    expect(value.groups).toHaveLength(0);
    expect(value.groupsTotal).toBe(0);
    expect(value.truncated).toBe(false);
    expect(value.total).toBe(0);
    expect(value.missing).toEqual({ count: 0 });
  });
});

describe('aggregate totals — missing group', () => {
  it('counts records with no value for the group field', () => {
    const value = run({ groupBy: 'account' });
    expect(value.missing).toEqual({ count: 2 });
    expect(value.groups.map(g => g.value)).not.toContain('null');
  });

  it('carries the metric for records with no group value', () => {
    expect(run({ groupBy: 'account', metric: { field: 'hours', op: 'sum' } }).missing).toEqual({ count: 2, metric: 7 });
    expect(run({ groupBy: 'account', metric: { field: 'hours', op: 'count' } }).missing).toEqual({ count: 2, metric: 2 });
    expect(run({ groupBy: 'account', metric: { field: 'hours', op: 'avg' } }).missing).toEqual({ count: 2, metric: 3.5 });
  });

  it('respects filters', () => {
    const value = run({ groupBy: 'account', filters: { hours: { op: 'gte', value: 4 } } });
    expect(value.total).toBe(2);
    expect(value.missing).toEqual({ count: 1 });
    expect(value.groups).toEqual([{ value: 'b', count: 1 }]);
  });

  it('counts unscoped records of a type that declares the field but never sets it', () => {
    // Clients do not declare `account`, so they are not missing one. other_entry
    // declares it and no record sets it, so both of its records are.
    const result = engine.aggregate({ groupBy: 'account', metric: { field: 'hours', op: 'sum' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(ENTRIES.length + 2);
    expect(result.value.totalMetric).toBe(ALL_HOURS + 300);
    expect(result.value.missing).toEqual({ count: 4, metric: 307 });
    expect(result.value.unindexedFields).toBeUndefined();
  });

  it('matches the scoped result for a type that never sets the field', () => {
    const result = engine.aggregate({ docType: docType('other_entry'), groupBy: 'account', metric: { field: 'hours', op: 'sum' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.missing).toEqual({ count: 2, metric: 300 });
  });
});

describe('aggregate totals — fields that are not indexed', () => {
  it('names a declared group field that is not indexed', () => {
    const value = run({ groupBy: 'note' });
    expect(value.groups).toHaveLength(0);
    expect(value.unindexedFields).toEqual(['note']);
  });

  it('names an undeclared group field', () => {
    const value = run({ groupBy: 'not_a_field' });
    expect(value.total).toBe(ENTRIES.length);
    expect(value.missing).toEqual({ count: ENTRIES.length });
    expect(value.unindexedFields).toEqual(['not_a_field']);
  });

  it('names a metric field that is not indexed', () => {
    const value = run({ groupBy: 'account', metric: { field: 'rawhours', op: 'sum' } });
    expect(value.unindexedFields).toEqual(['rawhours']);
  });

  it('ignores the field of a count metric, which reads no value', () => {
    const value = run({ groupBy: 'account', metric: { field: 'rawhours', op: 'count' } });
    expect(value.unindexedFields).toBeUndefined();
  });

  it('names an unindexed metric on a ref chain', () => {
    const value = run({ groupBy: 'client_ref->status', metric: { field: 'rawhours', op: 'sum' } });
    expect(value.unindexedFields).toEqual(['rawhours']);
  });

  it('omits the field when everything is indexed', () => {
    expect(run({ groupBy: 'account', metric: { field: 'hours', op: 'sum' } }).unindexedFields).toBeUndefined();
  });
});

describe('aggregate totals — metric op', () => {
  it('never places the op in SQL', () => {
    const op = '(select count(*) from documents)+max' as 'max';
    const value = run({ groupBy: 'account', metric: { field: 'hours', op } });
    expect(value.totalMetric).toBe(5);
    expect(value.groups.find(g => g.value === 'c')?.metric).toBe(1);
  });
});

describe('aggregate totals — metrics', () => {
  it('keeps records that have no metric value in their group', () => {
    const value = run({ groupBy: 'account', metric: { field: 'hours', op: 'sum' } });
    const byValue = new Map(value.groups.map(g => [g.value, g]));
    expect(byValue.get('b')).toMatchObject({ count: 2, metric: 5 });
    expect(byValue.get('f')).toMatchObject({ count: 1, metric: null });
    expect(value.groupsTotal).toBe(6);
  });

  it('computes whole-scope avg, min and max rather than combining group values', () => {
    expect(run({ groupBy: 'account', metric: { field: 'hours', op: 'avg' } }).totalMetric).toBeCloseTo(ALL_HOURS / 9);
    expect(run({ groupBy: 'account', metric: { field: 'hours', op: 'min' }, limit: 1 }).totalMetric).toBe(1);
    expect(run({ groupBy: 'account', metric: { field: 'hours', op: 'max' }, limit: 1 }).totalMetric).toBe(5);
  });

  it('counts records over the whole scope for a count metric', () => {
    // The count op counts records in the group; it does not read the metric field.
    const value = run({ groupBy: 'account', metric: { field: 'hours', op: 'count' }, limit: 1 });
    expect(value.totalMetric).toBe(ENTRIES.length);
  });
});

describe('aggregate totals — list group fields', () => {
  it('counts a document once in total even when it is in two groups', () => {
    const value = run({ groupBy: 'tags' });
    const byValue = new Map(value.groups.map(g => [g.value, g.count]));
    expect(byValue.get('x')).toBe(2);
    expect(byValue.get('y')).toBe(2);
    expect(value.total).toBe(ENTRIES.length);
    expect(value.missing).toEqual({ count: 8 });
  });

  it('counts a document\'s metric once in totalMetric', () => {
    const value = run({ groupBy: 'tags', metric: { field: 'hours', op: 'sum' } });
    const byValue = new Map(value.groups.map(g => [g.value, g.metric]));
    expect(byValue.get('x')).toBe(3);
    expect(byValue.get('y')).toBe(6);
    expect(value.totalMetric).toBe(ALL_HOURS);
  });
});

describe('aggregate totals — ref chains', () => {
  it('reports totals over the whole scope and truncates after merging', () => {
    const value = run({ groupBy: 'client_ref->status', limit: 1 });
    // client A and B merge into `active`; the broken ref bins as unresolved.
    expect(value.groupsReturned).toBe(1);
    expect(value.groupsTotal).toBe(2);
    expect(value.truncated).toBe(true);
    expect(value.total).toBe(ENTRIES.length);
    expect(value.missing).toEqual({ count: 5 });
  });

  it('does not move totalMetric with limit', () => {
    for (const limit of [1, 50]) {
      const value = run({ groupBy: 'client_ref->status', metric: { field: 'hours', op: 'sum' }, limit });
      expect(value.totalMetric).toBe(ALL_HOURS);
    }
  });

  it('weights a merged avg by records with a value', () => {
    // active: e1-e4 have 1+2+3+5 hours; e5 (client B) has none and must not dilute it.
    const value = run({ groupBy: 'client_ref->status', metric: { field: 'hours', op: 'avg' } });
    const active = value.groups.find(g => g.value === 'active');
    expect(active?.count).toBe(5);
    expect(active?.metric).toBeCloseTo(11 / 4);
  });

  it('does not report a metric-less group as zero in a merged min', () => {
    // client B's only entry has no hours, so it must not pull the merged min to 0.
    const value = run({ groupBy: 'client_ref->status', metric: { field: 'hours', op: 'min' } });
    expect(value.groups.find(g => g.value === 'active')?.metric).toBe(1);
  });
});
