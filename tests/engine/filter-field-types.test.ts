// ============================================================================
// Filter comparison contract. A filter compares by the schema's field type, not
// by the JSON type of the value; a date-only bound covers the whole day; and a
// filter that cannot match as written is reported in `filterWarnings` instead of
// returning an unexplained zero.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docType } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-filter-field-types');

const ENTRY_SCHEMA = `type: work_entry
version: 1
required:
  - doc_id
  - title
fields:
  title:
    type: string
    index: true
  code:
    type: string
    index: true
  hours:
    type: number
    index: true
  rate:
    type: amount
    index: true
  readings:
    type: list
    item_type: number
    index: true
  client_ref:
    type: ref
    target: client
    index: true
  note:
    type: string
`;

const STAMP_SCHEMA = `type: stamp
version: 1
required:
  - doc_id
  - title
fields:
  title:
    type: string
    index: true
  at:
    type: date
    index: true
  days:
    type: list
    item_type: date
    index: true
  label:
    type: string
    index: true
`;

// Shares `hours` with work_entry as text, so an unscoped filter spans both types.
const SHIFT_SCHEMA = `type: shift_note
version: 1
required:
  - doc_id
  - title
fields:
  title:
    type: string
    index: true
  hours:
    type: string
    index: true
`;

const entry = docType('work_entry');
const stamp = docType('stamp');

let engine: MaadEngine;

beforeAll(async () => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  cpSync(FIXTURE_SRC, TEMP_ROOT, { recursive: true });
  const backendDir = path.join(TEMP_ROOT, '_backend');
  if (existsSync(backendDir)) rmSync(backendDir, { recursive: true, maxRetries: 10, retryDelay: 200 });

  writeFileSync(path.join(TEMP_ROOT, '_schema', 'work_entry.v1.yaml'), ENTRY_SCHEMA, 'utf-8');
  writeFileSync(path.join(TEMP_ROOT, '_schema', 'stamp.v1.yaml'), STAMP_SCHEMA, 'utf-8');
  writeFileSync(path.join(TEMP_ROOT, '_schema', 'shift_note.v1.yaml'), SHIFT_SCHEMA, 'utf-8');
  const registryPath = path.join(TEMP_ROOT, '_registry', 'object_types.yaml');
  writeFileSync(
    registryPath,
    readFileSync(registryPath, 'utf-8').replace(
      'extraction:',
      '  work_entry:\n    path: work-entries/\n    id_prefix: wrk\n    schema: work_entry.v1\n' +
      '  stamp:\n    path: stamps/\n    id_prefix: stp\n    schema: stamp.v1\n' +
      '  shift_note:\n    path: shift-notes/\n    id_prefix: shf\n    schema: shift_note.v1\n\nextraction:',
    ),
    'utf-8',
  );
  for (const dir of ['work-entries', 'stamps', 'shift-notes']) mkdirSync(path.join(TEMP_ROOT, dir), { recursive: true });

  engine = new MaadEngine();
  const init = await engine.init(TEMP_ROOT);
  expect(init.ok).toBe(true);
  await engine.indexAll({ force: true });

  const client = await engine.createDocument(docType('client'), { name: 'Filter Client', status: 'active' }, 'c');
  expect(client.ok).toBe(true);
  if (!client.ok) return;

  // Text and numeric order disagree: as text, "10" < "100" < "2" < "9".
  for (const [title, hours, rate, readings] of [
    ['h2', 2, '2.00 USD', [2]],
    ['h9', 9, '9.50 USD', [3, 9]],
    ['h10', 10, '10.00 USD', [1, 20]],
    ['h100', 100, '100.00 USD', [100]],
  ] as const) {
    const created = await engine.createDocument(entry, {
      title, code: String(hours), hours, rate, readings: [...readings], client_ref: client.value.docId, note: 'unindexed',
    }, title);
    expect(created.ok).toBe(true);
  }

  for (const [title, at] of [
    ['d04', '2026-11-04'],
    ['d05', '2026-11-05'],
    ['d05-utc', '2026-11-05T15:00:00Z'],
    ['d05-offset', '2026-11-05T23:30:00-05:00'],
    ['d06', '2026-11-06'],
    ['d06-utc', '2026-11-06T00:00:00Z'],
  ] as const) {
    const created = await engine.createDocument(stamp, { title, at, label: at }, title);
    expect(created.ok).toBe(true);
  }

  const shift = await engine.createDocument(docType('shift_note'), { title: 'long', hours: '5 hrs' }, 's');
  expect(shift.ok).toBe(true);
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

function titles(type: ReturnType<typeof docType>, filters: unknown): string[] {
  const result = engine.findDocuments({ docType: type, filters: filters as any, fields: ['title'], limit: 100 });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) return [];
  return result.value.results.map(r => r.fields!['title']!).sort();
}

function warnings(filters: unknown, type: ReturnType<typeof docType> | null = entry) {
  const result = engine.findDocuments({ ...(type ? { docType: type } : {}), filters: filters as any });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return result.ok ? result.value.filterWarnings : undefined;
}

describe('numeric fields compare as numbers whatever the value type', () => {
  it('a numeric string bound gives the same rows as a number bound', () => {
    expect(titles(entry, { hours: { op: 'gte', value: 10 } })).toEqual(['h10', 'h100']);
    expect(titles(entry, { hours: { op: 'gte', value: '10' } })).toEqual(['h10', 'h100']);
    expect(titles(entry, { hours: { op: 'gt', value: '10' } })).toEqual(['h100']);
    expect(titles(entry, { hours: { op: 'lte', value: '9' } })).toEqual(['h2', 'h9']);
    expect(titles(entry, { hours: { op: 'lt', value: '10.0' } })).toEqual(['h2', 'h9']);
  });

  it('amount fields compare on the number, with or without a currency', () => {
    expect(titles(entry, { rate: { op: 'gte', value: '10' } })).toEqual(['h10', 'h100']);
    expect(titles(entry, { rate: { op: 'gte', value: '10.00 USD' } })).toEqual(['h10', 'h100']);
    expect(titles(entry, { rate: { op: 'lt', value: 10 } })).toEqual(['h2', 'h9']);
  });

  it('between takes numeric strings and checks their order as numbers', () => {
    expect(titles(entry, { hours: { op: 'between', value: ['9', '10'] } })).toEqual(['h10', 'h9']);
    const reversed = engine.findDocuments({ docType: entry, filters: { hours: { op: 'between', value: ['100', '20'] } } as any });
    expect(reversed.ok).toBe(false);
    if (!reversed.ok) expect(reversed.errors[0]!.code).toBe('FILTER_BETWEEN_INVALID');
  });

  it('eq, in and neq compare numerically too', () => {
    expect(titles(entry, { hours: { op: 'eq', value: '10.0' } })).toEqual(['h10']);
    expect(titles(entry, { hours: 10 })).toEqual(['h10']);
    expect(titles(entry, { hours: { op: 'in', value: ['10.0', 2] } })).toEqual(['h10', 'h2']);
    expect(titles(entry, { hours: { op: 'neq', value: '10.0' } })).toEqual(['h100', 'h2', 'h9']);
    expect(titles(entry, { rate: { op: 'eq', value: 9.5 } })).toEqual(['h9']);
    expect(titles(entry, { rate: { op: 'eq', value: '9.50 USD' } })).toEqual(['h9']);
    expect(titles(entry, { rate: { op: 'eq', value: '9.50 EUR' } })).toEqual([]);
  });

  it('list items compare by item type, and all ops must hold for one item', () => {
    expect(titles(entry, { readings: { op: 'gte', value: '20' } })).toEqual(['h10', 'h100']);
    expect(titles(entry, { readings: [{ op: 'gte', value: '5' }, { op: 'lte', value: '10' }] })).toEqual(['h9']);
  });

  it('holds on the sort-driven query path', () => {
    const result = engine.findDocuments({
      docType: entry, filters: { hours: { op: 'gte', value: '10' } } as any, fields: ['title'], sortBy: 'hours', sortOrder: 'asc', limit: 10,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.results.map(r => r.fields!['title'])).toEqual(['h10', 'h100']);
  });

  it('list filters mean the same with a sort on another field', () => {
    const sorted = (filters: unknown) => {
      const result = engine.findDocuments({ docType: entry, filters: filters as any, fields: ['title'], sortBy: 'hours', sortOrder: 'asc', limit: 10 });
      expect(result.ok).toBe(true);
      return result.ok ? result.value.results.map(r => r.fields!['title']) : [];
    };
    // h10 holds [1, 20]: no one item is in 5..10, and it does hold 20.
    expect(sorted({ readings: [{ op: 'gte', value: 5 }, { op: 'lte', value: 10 }] })).toEqual(['h9']);
    expect(sorted({ readings: { op: 'neq', value: 20 } })).toEqual(['h2', 'h9', 'h100']);
    expect(titles(entry, { readings: { op: 'neq', value: 20 } })).toEqual(['h100', 'h2', 'h9']);
  });

  it('holds for aggregate, ref-chain aggregate, join and verify', async () => {
    const filters = { hours: { op: 'gte', value: '10' } } as any;
    const aggregated = engine.aggregate({ docType: entry, groupBy: 'code', filters });
    expect(aggregated.ok && aggregated.value.total).toBe(2);
    const chained = engine.aggregate({ docType: entry, groupBy: 'client_ref->name', filters });
    expect(chained.ok && chained.value.total).toBe(2);
    const joined = engine.join({ docType: entry, refs: ['client_ref'], filters });
    expect(joined.ok && joined.value.total).toBe(2);
    const counted = engine.verifyCount(entry, 2, filters);
    expect(counted.ok && counted.value.grounded).toBe(true);
  });

  it('holds for the integrity sweep scope', async () => {
    // Drift on the record with 100 hours: as text, "100" <= "9", so a text compare would report it.
    const found = engine.findDocuments({ docType: entry, filters: { hours: 100 } as any });
    expect(found.ok).toBe(true);
    if (!found.ok) return;
    const file = path.join(TEMP_ROOT, found.value.results[0]!.filePath as string);
    const original = readFileSync(file, 'utf-8');
    writeFileSync(file, `${original}\nDrift.\n`, 'utf-8');
    try {
      const drift = async (filter: unknown) => {
        const result = await engine.verifyIntegrity({ docType: entry, filter: filter as any });
        return result.ok ? result.value.findings.hash_drift : -1;
      };
      expect(await drift({ hours: { op: 'gte', value: '10' } })).toBe(1);
      expect(await drift({ hours: { op: 'lte', value: '9' } })).toBe(0);
    } finally {
      writeFileSync(file, original, 'utf-8');
    }
  });

  it('repair_where acts on the same records its preview counts', async () => {
    const result = await engine.repairWhere({ hours: { op: 'between', value: ['9', '10'] } } as any, entry, ['prune_orphan_refs'], 100);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.value.totalRequested).toBe(2);
  });

  it('a value that is not a number matches nothing and says so', () => {
    for (const op of ['gt', 'gte', 'lt', 'lte']) {
      expect(titles(entry, { hours: { op, value: 'abc' } })).toEqual([]);
      expect(warnings({ hours: { op, value: 'abc' } })).toEqual([{ field: 'hours', reason: 'not_numeric' }]);
    }
    // A date string must not parse as its leading year.
    expect(titles(entry, { hours: { op: 'lte', value: '2026-11-05' } })).toEqual([]);
    expect(titles(entry, { rate: { op: 'lte', value: '2026-11-05' } })).toEqual([]);
    expect(titles(entry, { rate: { op: 'lte', value: '2026.11.05' } })).toEqual([]);
    expect(warnings({ rate: { op: 'lte', value: '1.2.3' } })).toEqual([{ field: 'rate', reason: 'not_numeric' }]);
    expect(titles(entry, { hours: { op: 'gte', value: '' } })).toEqual([]);
    expect(titles(entry, { hours: { op: 'eq', value: 'abc' } })).toEqual([]);
    expect(warnings({ hours: { op: 'eq', value: 'abc' } })).toEqual([{ field: 'hours', reason: 'not_numeric' }]);
    expect(titles(entry, { hours: { op: 'in', value: ['abc', '10'] } })).toEqual(['h10']);
    expect(warnings({ hours: { op: 'in', value: ['abc', '10'] } })).toEqual([{ field: 'hours', reason: 'not_numeric' }]);
    // neq keeps its meaning: no record has that value.
    expect(titles(entry, { hours: { op: 'neq', value: 'abc' } })).toEqual(['h10', 'h100', 'h2', 'h9']);
  });

  it('a caller cannot choose the comparison', () => {
    expect(titles(entry, { hours: { op: 'eq', value: '10', compare: 'none' } })).toEqual(['h10']);
    expect(titles(entry, { hours: { op: 'lte', value: 'abc', compare: 'row', numericValue: 5 } })).toEqual([]);
    expect(titles(entry, { code: { op: 'lte', value: '9', numericValue: 5, compare: 'numeric' } })).toEqual(['h10', 'h100', 'h2', 'h9']);
    expect(titles(entry, { nope: { op: 'eq', value: 'x', compare: 'none' } })).toEqual([]);
  });
});

describe('text fields compare as text whatever the value type', () => {
  it('a number bound on a string field compares as text', () => {
    expect(titles(entry, { code: { op: 'gte', value: 2 } })).toEqual(['h2', 'h9']);
    expect(titles(entry, { code: { op: 'gte', value: '2' } })).toEqual(['h2', 'h9']);
  });

  it('a year as a number works on a date field', () => {
    expect(titles(stamp, { at: { op: 'gte', value: 2026 } })).toHaveLength(6);
    expect(titles(stamp, { at: { op: 'lte', value: 2026 } })).toHaveLength(6);
    expect(titles(stamp, { at: { op: 'lt', value: 2026 } })).toEqual([]);
  });
});

describe('a filter with no docType follows each row', () => {
  // `hours` is a number on work_entry and text on shift_note ("5 hrs").
  const total = (value: unknown) => {
    const result = engine.aggregate({ groupBy: 'title', filters: { hours: { op: 'gte', value } } as any });
    expect(result.ok).toBe(true);
    return result.ok ? result.value.total : -1;
  };

  it('number rows compare numerically and text rows as text', () => {
    expect(total('10')).toBe(3); // h10, h100, and "5 hrs" >= "10" as text
    expect(total(10)).toBe(3);
  });

  it('a value that is only text still matches the text rows', () => {
    expect(total('5')).toBe(4); // h9, h10, h100, and "5 hrs" >= "5" as text
    expect(total('a')).toBe(0);
    const result = engine.findDocuments({ filters: { hours: { op: 'lte', value: '6 hrs' } } as any, fields: ['title'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.map(r => r.fields!['title'])).toEqual(['long']);
    expect(result.value.filterWarnings).toBeUndefined();
  });

  it('eq, in and neq follow each row too', () => {
    const titlesFor = (filter: unknown) => {
      const result = engine.findDocuments({ filters: { hours: filter } as any, fields: ['title'], limit: 100 });
      expect(result.ok).toBe(true);
      return result.ok ? result.value.results.map(r => r.fields!['title']!).sort() : [];
    };
    expect(titlesFor({ op: 'eq', value: '10.0' })).toEqual(['h10']);
    expect(titlesFor({ op: 'eq', value: '5 hrs' })).toEqual(['long']);
    expect(titlesFor({ op: 'in', value: ['10.0', '5 hrs'] })).toEqual(['h10', 'long']);
    expect(titlesFor({ op: 'neq', value: '10.0' })).toEqual(['h100', 'h2', 'h9', 'long']);
  });

  it('a type that does not declare the field is not a problem', () => {
    expect(warnings({ at: { op: 'gte', value: '2026' } }, null)).toBeUndefined();
  });
});

describe('filters that cannot match are reported, not refused', () => {
  it('reports an undeclared field and keeps returning zero', () => {
    const result = engine.findDocuments({ docType: entry, filters: { nope: 'x' } as any });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(0);
    expect(result.value.filterWarnings).toEqual([{ field: 'nope', reason: 'undeclared' }]);
  });

  it('reports a field declared without index: true', () => {
    expect(titles(entry, { note: 'unindexed' })).toEqual([]);
    expect(warnings({ note: 'unindexed' })).toEqual([{ field: 'note', reason: 'unindexed' }]);
  });

  it('reports system fields, which are not in the field index', () => {
    expect(titles(entry, { doc_id: 'wrk-1' })).toEqual([]);
    expect(warnings({ doc_id: 'wrk-1' })).toEqual([{ field: 'doc_id', reason: 'undeclared' }]);
  });

  it('reports each field once, and still narrows by the good filters', () => {
    expect(warnings({ nope: [{ op: 'gte', value: 'a' }, { op: 'lte', value: 'b' }], hours: 10 }))
      .toEqual([{ field: 'nope', reason: 'undeclared' }]);
  });

  it('omits the field when every filter is usable', () => {
    const result = engine.findDocuments({ docType: entry, filters: { hours: { op: 'gte', value: '10' } } as any });
    expect(result.ok && 'filterWarnings' in result.value).toBe(false);
    const aggregated = engine.aggregate({ docType: entry, groupBy: 'code' });
    expect(aggregated.ok && 'filterWarnings' in aggregated.value).toBe(false);
  });

  it('reports on aggregate without changing unindexedFields', () => {
    const result = engine.aggregate({ docType: entry, groupBy: 'code', filters: { nope: 'x' } as any });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(0);
    expect(result.value.filterWarnings).toEqual([{ field: 'nope', reason: 'undeclared' }]);
    expect(result.value.unindexedFields).toBeUndefined();
  });

  it('reports on ref-chain aggregate, join and verify', async () => {
    const expected = [{ field: 'nope', reason: 'undeclared' }];
    const filters = { nope: 'x' } as any;
    const chained = engine.aggregate({ docType: entry, groupBy: 'client_ref->name', filters });
    expect(chained.ok && chained.value.filterWarnings).toEqual(expected);
    const joined = engine.join({ docType: entry, refs: ['client_ref'], filters });
    expect(joined.ok && joined.value.filterWarnings).toEqual(expected);
    const counted = engine.verifyCount(entry, 0, filters);
    expect(counted.ok && counted.value.grounded).toBe(true);
    expect(counted.ok && counted.value.filterWarnings).toEqual(expected);
    const integrity = await engine.verifyIntegrity({ docType: entry, filter: filters });
    expect(integrity.ok && integrity.value.filterWarnings).toEqual(expected);
  });
});

describe('date bounds', () => {
  it('lte on a date-only bound keeps the whole day', () => {
    expect(titles(stamp, { at: { op: 'lte', value: '2026-11-05' } })).toEqual(['d04', 'd05', 'd05-offset', 'd05-utc']);
  });

  it('gt on a date-only bound starts the next day, so lte and gt split the rows', () => {
    expect(titles(stamp, { at: { op: 'gt', value: '2026-11-05' } })).toEqual(['d06', 'd06-utc']);
  });

  it('gte and lt on a date-only bound are unchanged', () => {
    expect(titles(stamp, { at: { op: 'gte', value: '2026-11-05' } })).toEqual(['d05', 'd05-offset', 'd05-utc', 'd06', 'd06-utc']);
    expect(titles(stamp, { at: { op: 'lt', value: '2026-11-05' } })).toEqual(['d04']);
  });

  it('a lt next-day bound gives the same rows as lte', () => {
    expect(titles(stamp, { at: { op: 'lt', value: '2026-11-06' } }))
      .toEqual(titles(stamp, { at: { op: 'lte', value: '2026-11-05' } }));
  });

  it('between covers the whole of its last day', () => {
    expect(titles(stamp, { at: { op: 'between', value: ['2026-11-05', '2026-11-05'] } })).toEqual(['d05', 'd05-offset', 'd05-utc']);
  });

  it('a calendar day is the day as written, not converted to a zone', () => {
    // 23:30 at -05:00 is the next day in UTC; the record still files under the 5th.
    expect(titles(stamp, { at: { op: 'lte', value: '2026-11-05' } })).toContain('d05-offset');
    expect(titles(stamp, { at: { op: 'gt', value: '2026-11-05' } })).not.toContain('d05-offset');
  });

  it('month and year bounds keep the whole period', () => {
    expect(titles(stamp, { at: { op: 'lte', value: '2026-11' } })).toHaveLength(6);
    expect(titles(stamp, { at: { op: 'gt', value: '2026-11' } })).toEqual([]);
    expect(titles(stamp, { at: { op: 'lte', value: '2026-10' } })).toEqual([]);
    expect(titles(stamp, { at: { op: 'lte', value: '2026' } })).toHaveLength(6);
    expect(titles(stamp, { at: { op: 'gt', value: '2026' } })).toEqual([]);
  });

  it('rolls over month ends, year ends and leap days', async () => {
    for (const [title, at] of [
      ['y-in', '2027-12-31T10:00:00Z'], ['y-out', '2028-01-01'],
      ['l-in', '2028-02-29T10:00:00Z'], ['l-out', '2028-03-01'],
      ['m-in', '2029-12-15'], ['m-out', '2030-01-01'],
    ] as const) {
      const created = await engine.createDocument(stamp, { title, at }, title);
      expect(created.ok).toBe(true);
    }
    const between = (lo: string, hi: string) => titles(stamp, { at: { op: 'between', value: [lo, hi] } });
    expect(between('2027-12-01', '2027-12-31')).toEqual(['y-in']);
    expect(between('2028-02-01', '2028-02-29')).toEqual(['l-in']);
    expect(between('2029-12', '2029-12')).toEqual(['m-in']);
  });

  it('leaves an instant bound and an impossible date as plain text', () => {
    expect(titles(stamp, { at: { op: 'lte', value: '2026-11-05T15:00:00Z' } })).toEqual(['d04', 'd05', 'd05-utc']);
    expect(titles(stamp, { at: { op: 'lte', value: '2026-02-30' } })).toEqual([]);
    expect(titles(stamp, { at: { op: 'lte', value: '2026-13' } })).toEqual(titles(stamp, { at: { op: 'lt', value: '2026-13' } }));
  });

  it('list items of dates get the same bounds', async () => {
    const created = await engine.createDocument(stamp, { title: 'with-days', days: ['2031-05-05T15:00:00Z'] }, 'days');
    expect(created.ok).toBe(true);
    expect(titles(stamp, { days: { op: 'lte', value: '2031-05-05' } })).toEqual(['with-days']);
    expect(titles(stamp, { days: { op: 'gt', value: '2031-05-05' } })).toEqual([]);
  });

  it('a string field that holds dates still compares as text', () => {
    expect(titles(stamp, { label: { op: 'lte', value: '2026-11-05' } })).toEqual(['d04', 'd05']);
  });
});
