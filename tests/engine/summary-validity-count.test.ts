// ============================================================================
// 0.7.17 — summary() validation-error count is backed by per-doc validity
// persisted at index time (documents.valid), not by re-reading and
// re-validating every file on each call. This verifies the count is correct
// (invalid records on disk are tallied) and that reindexing a record fixes its
// validity. The prior implementation also silently capped at 100k docs via
// findDocuments({ limit: 100000 }); the SQL COUNT is uncapped.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-summary-validity');

const INVOICE_SCHEMA = `type: invoice
version: 1
required:
  - doc_id
  - name
fields:
  name:
    type: string
    index: true
`;

let engine: MaadEngine;

function writeInvoice(id: string, body: string): void {
  writeFileSync(path.join(TEMP_ROOT, 'invoices', `${id}.md`), body, 'utf-8');
}

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

  // Two valid records, one structurally invalid (missing the required `name`).
  // Files are written directly so the invalid one lands on disk the way a
  // hand-edited or migrated record would — bypassing the write-time validator.
  writeInvoice('inv-ok-1', '---\ndoc_id: inv-ok-1\ndoc_type: invoice\nschema: invoice.v1\nname: First\n---\n\nbody\n');
  writeInvoice('inv-ok-2', '---\ndoc_id: inv-ok-2\ndoc_type: invoice\nschema: invoice.v1\nname: Second\n---\n\nbody\n');
  writeInvoice('inv-bad', '---\ndoc_id: inv-bad\ndoc_type: invoice\nschema: invoice.v1\n---\n\nmissing name\n');

  engine = new MaadEngine();
  const initResult = await engine.init(TEMP_ROOT);
  expect(initResult.ok).toBe(true);
  await engine.indexAll({ force: true });
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

describe('summary() validation-error count', () => {
  it('counts the one structurally-invalid record', () => {
    const s = engine.summary();
    expect(s.warnings.validationErrors).toBe(1);
  });

  it('all three invoices are indexed and findable regardless of validity', async () => {
    const result = await engine.findDocuments({ docType: 'invoice' as never, limit: 100 } as never);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.value.results.map(r => r.docId as string).sort();
    expect(ids).toEqual(['inv-bad', 'inv-ok-1', 'inv-ok-2']);
  });

  it('reindexing after the record is repaired clears the error count', async () => {
    writeInvoice('inv-bad', '---\ndoc_id: inv-bad\ndoc_type: invoice\nschema: invoice.v1\nname: Repaired\n---\n\nfixed\n');
    await engine.indexAll({ force: true });
    expect(engine.summary().warnings.validationErrors).toBe(0);
  });
});
