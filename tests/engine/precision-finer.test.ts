// ============================================================================
// 0.19.0 — on_finer: opt-in handling of date values finer than store_precision.
// Default (unset) keeps storage-wins; warn surfaces a warning; error rejects.
// Both on_coarser and on_finer at error = exact-precision field.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { loadRegistry } from '../../src/registry/loader.js';
import { loadSchemas } from '../../src/schema/loader.js';
import { docType, docId } from '../../src/types.js';

const REGISTRY = `types:
  event:
    path: events
    id_prefix: evt
    schema: event.v1
`;

const SCHEMA = `type: event
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
    values: [open, closed]
    index: true
  event_at:
    type: date
    store_precision: day
    on_coarser: error
    on_finer: error
    index: true
  noted_at:
    type: date
    store_precision: day
    on_finer: warn
  logged_at:
    type: date
    store_precision: day
`;

function writeProject(root: string, schemaYaml: string): void {
  mkdirSync(path.join(root, '_registry'), { recursive: true });
  mkdirSync(path.join(root, '_schema'), { recursive: true });
  mkdirSync(path.join(root, 'events'), { recursive: true });
  writeFileSync(path.join(root, '_registry', 'object_types.yaml'), REGISTRY, 'utf-8');
  writeFileSync(path.join(root, '_schema', 'event.v1.yaml'), schemaYaml, 'utf-8');
}

function removeDir(root: string): void {
  try {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Windows may hold handles briefly — non-fatal
  }
}

describe('schema loader — on_finer', () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach(removeDir));

  async function load(schemaYaml: string) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'maad-finer-loader-'));
    roots.push(root);
    writeProject(root, schemaYaml);
    const reg = await loadRegistry(root);
    if (!reg.ok) throw new Error('registry failed');
    return loadSchemas(root, reg.value);
  }

  it('parses on_finer and leaves it null when unset', async () => {
    const schemas = await load(SCHEMA);
    expect(schemas.ok).toBe(true);
    if (!schemas.ok) return;
    const schema = schemas.value.getSchemaForType(docType('event'))!;
    expect(schema.fields.get('event_at')!.onFiner).toBe('error');
    expect(schema.fields.get('noted_at')!.onFiner).toBe('warn');
    expect(schema.fields.get('logged_at')!.onFiner).toBeNull();
  });

  it('rejects an invalid on_finer value', async () => {
    const schemas = await load(`type: event
version: 1
fields:
  event_at:
    type: date
    store_precision: day
    on_finer: truncate
`);
    expect(schemas.ok).toBe(false);
    if (schemas.ok) return;
    expect(schemas.errors.some(e => e.message.includes('invalid on_finer "truncate"'))).toBe(true);
  });

  it('rejects on_finer without store_precision', async () => {
    const schemas = await load(`type: event
version: 1
fields:
  event_at:
    type: date
    on_finer: error
`);
    expect(schemas.ok).toBe(false);
    if (schemas.ok) return;
    expect(schemas.errors.some(e => e.message.includes('on_finer without store_precision'))).toBe(true);
  });

  it('rejects on_finer on a non-date field', async () => {
    const schemas = await load(`type: event
version: 1
fields:
  title:
    type: string
    on_finer: error
`);
    expect(schemas.ok).toBe(false);
    if (schemas.ok) return;
    expect(schemas.errors.some(e => e.message.includes('cannot declare "on_finer"'))).toBe(true);
  });
});

describe('engine — on_finer enforcement', () => {
  let root: string;
  let engine: MaadEngine;

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'maad-finer-engine-'));
    writeProject(root, SCHEMA);
    // Historical record written before the contract: timestamps in day fields.
    writeFileSync(
      path.join(root, 'events', 'evt-historical.md'),
      `---
doc_id: evt-historical
doc_type: event
schema: event.v1
title: Historical
status: open
event_at: "2026-09-24T23:41:07Z"
logged_at: "2026-09-24T23:41:07Z"
---
Seeded before on_finer.
`,
      'utf-8',
    );
    engine = new MaadEngine();
    const init = await engine.init(root);
    expect(init.ok).toBe(true);
    await engine.indexAll({ force: true });
  });

  afterAll(async () => {
    engine.close();
    await new Promise(r => setTimeout(r, 100));
    removeDir(root);
  });

  it('error: rejects a timestamp in an exact day field', async () => {
    const result = await engine.createDocument(
      docType('event'), { title: 'Finer', event_at: '2026-09-24T23:41:07Z' }, undefined, 'evt-finer',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('VALIDATION_FAILED');
    expect(result.errors[0]!.message).toContain('event_at');
    expect(result.errors[0]!.message).toContain('second-precision');
  });

  it('error: rejects a coarser value on the same exact field', async () => {
    const result = await engine.createDocument(
      docType('event'), { title: 'Coarser', event_at: '2026-09' }, undefined, 'evt-coarser',
    );
    expect(result.ok).toBe(false);
  });

  it('accepts exactly the declared precision', async () => {
    const result = await engine.createDocument(
      docType('event'), { title: 'Exact', event_at: '2026-09-24' }, undefined, 'evt-exact',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.validation.warnings).toHaveLength(0);
  });

  it('warn: stores the finer value with a PRECISION_FINER_THAN_DECLARED warning', async () => {
    const result = await engine.createDocument(
      docType('event'), { title: 'Warn', noted_at: '2026-09-24T10:00:00Z' }, undefined, 'evt-warn',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const warning = result.value.validation.warnings.find(w => w.field === 'noted_at');
    expect(warning?.code).toBe('PRECISION_FINER_THAN_DECLARED');
  });

  it('unset: finer values still pass silently (storage wins)', async () => {
    const result = await engine.createDocument(
      docType('event'), { title: 'Lenient', logged_at: '2026-09-24T10:00:00.123Z' }, undefined, 'evt-lenient',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.validation.warnings).toHaveLength(0);
  });

  it('update of an unrelated field does not judge the unchanged historical timestamp', async () => {
    const result = await engine.updateDocument(docId('evt-historical'), { status: 'closed' });
    expect(result.ok).toBe(true);
  });

  it('update that writes a timestamp into the exact field is rejected', async () => {
    const result = await engine.updateDocument(docId('evt-exact'), { event_at: '2026-09-25T08:00:00Z' });
    expect(result.ok).toBe(false);
  });

  it('audit reports finer drift only on fields that set on_finer', async () => {
    const result = await engine.validate(undefined, { includePrecision: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const drift = result.value.precisionDrift!;
    const historical = drift.filter(d => (d.docId as string) === 'evt-historical');
    expect(historical).toEqual([
      { docId: 'evt-historical', field: 'event_at', declared: 'day', actual: 'second', direction: 'finer' },
    ]);
    // logged_at has no on_finer — its finer values are not drift.
    expect(drift.some(d => d.field === 'logged_at')).toBe(false);
  });

  it('schemaInfo exposes onFiner only when set', () => {
    const result = engine.schemaInfo(docType('event'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.fields.find(f => f.name === 'event_at')!.onFiner).toBe('error');
    expect(result.value.fields.find(f => f.name === 'logged_at')!.onFiner).toBeUndefined();
  });
});
