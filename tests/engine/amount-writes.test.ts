// ============================================================================
// 0.25.0 — amount writes: a leading minus is accepted for credits, and an
// update re-checks only the amounts it changes, so a stored amount in another
// form no longer blocks edits to the record's other fields.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MaadEngine } from '../../src/engine.js';
import { docId, docType } from '../../src/types.js';
import { normalizeAmount } from '../../src/extractor/normalizers.js';

describe('amount writes', () => {
  let root: string;
  let engine: MaadEngine;
  const invoice = docType('invoice');

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'maad-amount-writes-'));
    await mkdir(path.join(root, '_registry'), { recursive: true });
    await mkdir(path.join(root, '_schema'), { recursive: true });
    await mkdir(path.join(root, 'invoices'), { recursive: true });
    await writeFile(path.join(root, '_registry/object_types.yaml'),
      'types:\n  invoice:\n    path: invoices/\n    id_prefix: inv\n    schema: invoice.v1\n');
    await writeFile(path.join(root, '_schema/invoice.v1.yaml'),
      'type: invoice\nversion: 1\nrequired: [doc_id, total]\nfields:\n'
      + '  total:\n    type: amount\n    index: true\n'
      + '  fees:\n    type: list\n    item_type: amount\n'
      + '  status:\n    type: string\n    index: true\n');
    // Written by hand, outside the engine, in a form a write would refuse.
    await writeFile(path.join(root, 'invoices', 'inv-imported.md'),
      '---\ndoc_id: inv-imported\ndoc_type: invoice\nschema: invoice.v1\ntotal: "$1,000.00"\nstatus: open\n---\n\n# inv-imported\n');
    engine = new MaadEngine();
    expect((await engine.init(root)).ok).toBe(true);
    await engine.indexAll({ force: true });
  });

  afterAll(async () => {
    engine.close();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  });

  it('creates a record with a negative amount', async () => {
    const r = await engine.createDocument(invoice, { total: '-250.00 USD', status: 'open' }, undefined, 'inv-credit');
    expect(r.ok).toBe(true);
    const negative = engine.findDocuments({ docType: invoice, filters: { total: { op: 'lt', value: 0 } } as never });
    if (!negative.ok) throw new Error('query failed');
    expect(negative.value.results.map(m => m.docId)).toEqual(['inv-credit']);
  });

  it('still refuses amounts that are not "<number> <CURRENCY>"', async () => {
    for (const total of ['$1,000.00', '- 5.00 USD', '+5.00 USD', '5 usd']) {
      const r = await engine.createDocument(invoice, { total, status: 'open' });
      expect(r.ok, total).toBe(false);
      if (!r.ok) expect(r.errors[0]!.code).toBe('VALIDATION_FAILED');
    }
  });

  it('updates other fields of a record whose stored amount is in another form', async () => {
    const r = await engine.updateDocument(docId('inv-imported'), { status: 'paid' });
    expect(r.ok).toBe(true);
    const raw = await readFile(path.join(root, 'invoices', 'inv-imported.md'), 'utf8');
    expect(raw).toContain('status: paid');
    expect(raw).toMatch(/total: ['"]?\$1,000\.00/);
  });

  it('checks the amount when the update changes it', async () => {
    const bad = await engine.updateDocument(docId('inv-imported'), { total: '1.000,00 EUR' });
    expect(bad.ok).toBe(false);
    const good = await engine.updateDocument(docId('inv-imported'), { total: '1000.00 USD' });
    expect(good.ok).toBe(true);
  });

  it('checks list-of-amount items on create and when changed', async () => {
    const neg = await engine.createDocument(invoice, { total: '10.00 USD', fees: ['-1.50 USD', '2.00 USD'] }, undefined, 'inv-fees');
    expect(neg.ok).toBe(true);
    const bad = await engine.updateDocument(docId('inv-fees'), { fees: ['$2'] });
    expect(bad.ok).toBe(false);
  });

  it('extracts negative amounts', () => {
    expect(normalizeAmount('-250.00 USD')).toEqual({ amount: -250, currency: 'USD' });
  });
});
