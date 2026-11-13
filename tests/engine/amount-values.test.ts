// ============================================================================
// 0.24.0 — amounts that are not in canonical form: records are never dropped
// from unfiltered reads, signs and decimal commas read correctly, and numeric
// filters report how many records they could not compare.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MaadEngine } from '../../src/engine.js';
import { docType } from '../../src/types.js';
import { parseAmountNumber } from '../../src/engine/helpers.js';

describe('parseAmountNumber', () => {
  it.each([
    ['1000.00 USD', 1000],
    ['1,000.00 USD', 1000],
    ['$1,000.00', 1000],
    ['USD 1,000.00', 1000],
    ['€ 1,500', 1500],
    ['-1000.00 USD', -1000],
    ['-$1,000.00', -1000],
    ['$-5', -5],
    ['−7.50 USD', -7.5],
    ['($1,000.00)', -1000],
    ['(1,000.00) USD', -1000],
    ['1.000,50 EUR', 1000.5],
    ['1.000.000', 1000000],
    ['12.', 12],
    ['about a thousand', null],
    ['', null],
  ])('%j reads as %j', (raw, expected) => {
    expect(parseAmountNumber(raw)).toBe(expected);
  });
});

describe('amount fields in queries', () => {
  let root: string;
  let engine: MaadEngine;
  const invoice = docType('invoice');

  const VALUES: Record<string, string> = {
    'inv-plain': '1000.00 USD',
    'inv-comma': '1,000.00 USD',
    'inv-symbol': '$1,000.00',
    'inv-credit': '-250.00 USD',
    'inv-paren': '($100.00)',
    'inv-words': 'about a thousand',
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'maad-amount-'));
    await mkdir(path.join(root, '_registry'), { recursive: true });
    await mkdir(path.join(root, '_schema'), { recursive: true });
    await mkdir(path.join(root, 'invoices'), { recursive: true });
    await writeFile(path.join(root, '_registry/object_types.yaml'),
      'types:\n  invoice:\n    path: invoices/\n    id_prefix: inv\n    schema: invoice.v1\n');
    await writeFile(path.join(root, '_schema/invoice.v1.yaml'),
      'type: invoice\nversion: 1\nrequired: [doc_id, total]\nfields:\n  total:\n    type: amount\n    index: true\n  status:\n    type: string\n    index: true\n');
    for (const [id, total] of Object.entries(VALUES)) {
      await writeFile(path.join(root, 'invoices', `${id}.md`),
        `---\ndoc_id: ${id}\ndoc_type: invoice\nschema: invoice.v1\ntotal: "${total}"\nstatus: open\n---\n\n# ${id}\n`);
    }
    engine = new MaadEngine();
    expect((await engine.init(root)).ok).toBe(true);
    await engine.indexAll({ force: true });
  });

  afterAll(async () => {
    engine.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  });

  it('returns every record, with its amount as written, when no numeric filter applies', () => {
    const r = engine.findDocuments({ docType: invoice, fields: ['total'], limit: 50 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.total).toBe(6);
    const byId = Object.fromEntries(r.value.results.map(m => [m.docId as string, m.fields?.['total']]));
    expect(byId).toEqual(VALUES);
    expect(r.value.unparsedValues).toBeUndefined();
  });

  it('compares written forms as numbers and keeps the sign', () => {
    const atLeast = engine.findDocuments({ docType: invoice, filters: { total: { op: 'gte', value: 1000 } } as never });
    const negative = engine.findDocuments({ docType: invoice, filters: { total: { op: 'lt', value: 0 } } as never });
    if (!atLeast.ok || !negative.ok) throw new Error('query failed');
    expect(atLeast.value.results.map(m => m.docId).sort()).toEqual(['inv-comma', 'inv-plain', 'inv-symbol']);
    expect(negative.value.results.map(m => m.docId).sort()).toEqual(['inv-credit', 'inv-paren']);
  });

  it('reports how many records a numeric filter could not compare', () => {
    const r = engine.findDocuments({ docType: invoice, filters: { total: { op: 'gte', value: 0 } } as never });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.unparsedValues).toEqual([{ field: 'total', count: 1 }]);

    const page = engine.findDocuments({ docType: invoice, filters: { total: { op: 'gte', value: 0 } } as never }, { includeTotal: false });
    if (!page.ok) throw new Error('query failed');
    expect(page.value.unparsedValues).toEqual([{ field: 'total', count: 1 }]);
  });

  it('a text filter does not report unparsed amounts', () => {
    const r = engine.findDocuments({ docType: invoice, filters: { status: 'open' } as never });
    if (!r.ok) throw new Error('query failed');
    expect(r.value.total).toBe(6);
    expect(r.value.unparsedValues).toBeUndefined();
  });

  it('sums credits as negative amounts', () => {
    const agg = engine.aggregate({ docType: invoice, groupBy: 'status', metric: { field: 'total', op: 'sum' } } as never);
    expect(agg.ok).toBe(true);
    if (!agg.ok) return;
    // 1000 * 3 - 250 - 100; the unparsed record counts but adds nothing.
    expect(agg.value.totalMetric).toBe(2650);
  });

  it('rebuilds indexed amounts once when the stored parser revision is older', async () => {
    const backend = (engine as unknown as { backend: { setMeta(k: string, v: string): void; db: { prepare(sql: string): { run(...a: unknown[]): unknown } } } }).backend;
    backend.db.prepare(`UPDATE field_index SET numeric_value = 250 WHERE doc_id = 'inv-credit' AND field_name = 'total'`).run();
    backend.setMeta('schema_index_fp:invoice', 'fingerprint-from-an-older-release');

    await engine.indexAll();

    const negative = engine.findDocuments({ docType: invoice, filters: { total: { op: 'lt', value: 0 } } as never });
    if (!negative.ok) throw new Error('query failed');
    expect(negative.value.results.map(m => m.docId)).toContain('inv-credit');
  });
});
