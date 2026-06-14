// ============================================================================
// 0.7.17 — missing-sort-field contract. A query sorted on a scalar schema field
// must still return docs that have NO value for that field (sorting changes
// order, never the result SET), and place them on the NULL-ordering side:
// SQLite orders NULL as smallest, so missing values sort LAST under DESC and
// FIRST under ASC. This pins the behavior the sort-index-driven fast path
// (0.7.17) must preserve — its present-value arm is index-driven and would
// otherwise drop field-less docs; a second arm gathers them back. The contract
// matches the prior aggregate path (correlated MAX/MIN → NULL for missing).
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docType } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-sort-missing');

const INVOICE_SCHEMA = `type: invoice
version: 1
required:
  - doc_id
  - name
fields:
  name:
    type: string
    index: true
  label:
    type: string
    index: true
  score:
    type: number
    index: true
`;

let engine: MaadEngine;

beforeAll(async () => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  cpSync(FIXTURE_SRC, TEMP_ROOT, { recursive: true });
  const backendDir = path.join(TEMP_ROOT, '_backend');
  if (existsSync(backendDir)) rmSync(backendDir, { recursive: true, maxRetries: 10, retryDelay: 200 });

  writeFileSync(path.join(TEMP_ROOT, '_schema', 'invoice.v1.yaml'), INVOICE_SCHEMA, 'utf-8');
  const registryPath = path.join(TEMP_ROOT, '_registry', 'object_types.yaml');
  const registry = readFileSync(registryPath, 'utf-8');
  writeFileSync(
    registryPath,
    registry.replace(
      'extraction:',
      '  invoice:\n    path: invoices/\n    id_prefix: inv\n    schema: invoice.v1\n\nextraction:',
    ),
    'utf-8',
  );
  mkdirSync(path.join(TEMP_ROOT, 'invoices'), { recursive: true });

  engine = new MaadEngine();
  const initResult = await engine.init(TEMP_ROOT);
  expect(initResult.ok).toBe(true);
  await engine.indexAll({ force: true });

  // inv-1/2/3 carry the optional sort fields; inv-4/5 carry neither. label and
  // score values are chosen so present-value order is unambiguous.
  const docs: Array<[string, Record<string, unknown>]> = [
    ['inv-1', { name: 'one', label: 'alpha', score: 30 }],
    ['inv-2', { name: 'two', label: 'charlie', score: 10 }],
    ['inv-3', { name: 'three', label: 'bravo', score: 20 }],
    ['inv-4', { name: 'four' }],
    ['inv-5', { name: 'five' }],
  ];
  for (const [id, fields] of docs) {
    const result = await engine.createDocument(docType('invoice'), fields, undefined, id);
    if (!result.ok) throw new Error(`create ${id} failed: ${JSON.stringify(result.errors)}`);
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

async function queryIds(
  sortBy: string,
  sortOrder: 'asc' | 'desc',
  page?: { limit: number; offset: number },
): Promise<string[]> {
  const q: Parameters<typeof engine.findDocuments>[0] = { docType: docType('invoice'), sortBy, sortOrder };
  if (page) { q.limit = page.limit; q.offset = page.offset; }
  const result = await engine.findDocuments(q);
  expect(result.ok).toBe(true);
  if (!result.ok) return [];
  return result.value.results.map(r => r.docId as string);
}

describe('missing scalar sort field — string field', () => {
  it('DESC: present in value order, then missing (by doc_id desc)', async () => {
    expect(await queryIds('label', 'desc')).toEqual(['inv-2', 'inv-3', 'inv-1', 'inv-5', 'inv-4']);
  });

  it('ASC: missing first (by doc_id asc), then present in value order', async () => {
    expect(await queryIds('label', 'asc')).toEqual(['inv-4', 'inv-5', 'inv-1', 'inv-3', 'inv-2']);
  });

  it('result SET is complete — sorting never drops field-less docs', async () => {
    const ids = await queryIds('label', 'desc');
    expect([...ids].sort()).toEqual(['inv-1', 'inv-2', 'inv-3', 'inv-4', 'inv-5']);
  });
});

describe('missing scalar sort field — numeric field', () => {
  it('DESC: present numeric desc, then missing', async () => {
    expect(await queryIds('score', 'desc')).toEqual(['inv-1', 'inv-3', 'inv-2', 'inv-5', 'inv-4']);
  });

  it('ASC: missing first, then present numeric asc', async () => {
    expect(await queryIds('score', 'asc')).toEqual(['inv-4', 'inv-5', 'inv-2', 'inv-3', 'inv-1']);
  });
});

describe('pagination across the present/missing boundary', () => {
  // label DESC full order: inv-2, inv-3, inv-1 | inv-5, inv-4
  it('page 0 stays within present', async () => {
    expect(await queryIds('label', 'desc', { limit: 2, offset: 0 })).toEqual(['inv-2', 'inv-3']);
  });

  it('page 1 straddles the boundary (last present + first missing)', async () => {
    expect(await queryIds('label', 'desc', { limit: 2, offset: 2 })).toEqual(['inv-1', 'inv-5']);
  });

  it('page 2 is all missing', async () => {
    expect(await queryIds('label', 'desc', { limit: 2, offset: 4 })).toEqual(['inv-4']);
  });
});
