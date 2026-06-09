// ============================================================================
// 0.7.14 — numeric sort contract. sortBy on a number/amount schema field must
// order on field_index.numeric_value, not the TEXT field_value column, so
// 9 < 100 sorts numerically instead of "100" < "9". List-field sort keys are
// deterministic (MIN of the items ascending, MAX descending) instead of an
// arbitrary field_index row.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docType } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-numeric-sort');

const INVOICE_SCHEMA = `type: invoice
version: 1
required:
  - doc_id
  - name
fields:
  name:
    type: string
    index: true
  total:
    type: number
    index: true
  amount_due:
    type: amount
    index: true
  scores:
    type: list
    item_type: string
    index: true
`;

let engine: MaadEngine;

beforeAll(async () => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  cpSync(FIXTURE_SRC, TEMP_ROOT, { recursive: true });
  const backendDir = path.join(TEMP_ROOT, '_backend');
  if (existsSync(backendDir)) rmSync(backendDir, { recursive: true, maxRetries: 10, retryDelay: 200 });

  // Add an invoice type carrying number, amount, and list fields
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

  // Values chosen so lexicographic and numeric order disagree: "100" < "2" < "9"
  for (const [name, total, due, scores] of [
    ['inv-a', 9, '9.50 USD', ['b', 'z']],
    ['inv-b', 100, '100.00 USD', ['a', 'y']],
    ['inv-c', 2, '2.25 USD', ['c', 'x']],
  ] as const) {
    const result = await engine.createDocument(
      docType('invoice'),
      { name, total, amount_due: due, scores: [...scores] },
      undefined,
      name,
    );
    if (!result.ok) throw new Error(`create ${name} failed: ${JSON.stringify(result.errors)}`);
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

async function queryIds(sortBy: string, sortOrder: 'asc' | 'desc'): Promise<string[]> {
  const result = await engine.findDocuments({ docType: docType('invoice'), sortBy, sortOrder });
  expect(result.ok).toBe(true);
  if (!result.ok) return [];
  return result.value.results.map(r => r.docId as string);
}

describe('numeric sort on number fields', () => {
  it('sorts ascending numerically (2 < 9 < 100)', async () => {
    expect(await queryIds('total', 'asc')).toEqual(['inv-c', 'inv-a', 'inv-b']);
  });

  it('sorts descending numerically (100 > 9 > 2)', async () => {
    expect(await queryIds('total', 'desc')).toEqual(['inv-b', 'inv-a', 'inv-c']);
  });
});

describe('numeric sort on amount fields', () => {
  it('sorts ascending on the parsed numeric amount', async () => {
    expect(await queryIds('amount_due', 'asc')).toEqual(['inv-c', 'inv-a', 'inv-b']);
  });
});

describe('string fields still sort lexicographically', () => {
  it('sorts by name as text', async () => {
    expect(await queryIds('name', 'asc')).toEqual(['inv-a', 'inv-b', 'inv-c']);
  });
});

describe('list-field sort key is deterministic', () => {
  it('ascending keys on the smallest item per doc', async () => {
    // min items: inv-b 'a', inv-a 'b', inv-c 'c'
    expect(await queryIds('scores', 'asc')).toEqual(['inv-b', 'inv-a', 'inv-c']);
  });

  it('descending keys on the largest item per doc', async () => {
    // max items: inv-a 'z', inv-b 'y', inv-c 'x'
    expect(await queryIds('scores', 'desc')).toEqual(['inv-a', 'inv-b', 'inv-c']);
  });
});
