// ============================================================================
// 0.6.7 Phase 4 — schema loader precision DSL parse + validation tests.
// T10 from docs/specs/0.6.7-schema-precision.md.
// ============================================================================

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { loadRegistry } from '../../src/registry/loader.js';
import { loadSchemas } from '../../src/schema/loader.js';

const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-precision-loader');

function buildProject(schemaYaml: string): string {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true });
  mkdirSync(path.join(TEMP_ROOT, '_registry'), { recursive: true });
  mkdirSync(path.join(TEMP_ROOT, '_schema'), { recursive: true });
  writeFileSync(
    path.join(TEMP_ROOT, '_registry', 'object_types.yaml'),
    `types:
  event:
    path: events
    id_prefix: evt
    schema: event.v1
`,
    'utf-8',
  );
  writeFileSync(path.join(TEMP_ROOT, '_schema', 'event.v1.yaml'), schemaYaml, 'utf-8');
  return TEMP_ROOT;
}

function cleanup(): void {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true });
}

describe('schema loader — precision DSL parse (0.6.7)', () => {
  it('parses store_precision, on_coarser, display_precision on a date field', async () => {
    const root = buildProject(`
type: event
version: 1
fields:
  started_at:
    type: date
    store_precision: second
    on_coarser: warn
    display_precision: minute
`);
    const reg = await loadRegistry(root);
    expect(reg.ok).toBe(true);
    if (!reg.ok) return;
    const schemas = await loadSchemas(root, reg.value);
    expect(schemas.ok).toBe(true);
    if (!schemas.ok) return;

    const schema = schemas.value.getSchemaForType('event' as any);
    expect(schema).toBeDefined();
    const field = schema!.fields.get('started_at')!;
    expect(field.storePrecision).toBe('second');
    expect(field.onCoarser).toBe('warn');
    expect(field.displayPrecision).toBe('minute');
    cleanup();
  });

  it('defaults on_coarser to warn when store_precision declared without on_coarser', async () => {
    const root = buildProject(`
type: event
version: 1
fields:
  started_at:
    type: date
    store_precision: day
`);
    const reg = await loadRegistry(root);
    if (!reg.ok) return;
    const schemas = await loadSchemas(root, reg.value);
    expect(schemas.ok).toBe(true);
    if (!schemas.ok) return;
    const field = schemas.value.getSchemaForType('event' as any)!.fields.get('started_at')!;
    expect(field.storePrecision).toBe('day');
    expect(field.onCoarser).toBe('warn');
    expect(field.displayPrecision).toBeNull();
    cleanup();
  });

  // T10 — the load-bearing schema-level rule.
  it('T10: rejects a schema where display_precision is finer than store_precision', async () => {
    const root = buildProject(`
type: event
version: 1
fields:
  started_at:
    type: date
    store_precision: minute
    display_precision: second
`);
    const reg = await loadRegistry(root);
    if (!reg.ok) return;
    const schemas = await loadSchemas(root, reg.value);
    expect(schemas.ok).toBe(false);
    if (schemas.ok) return;
    expect(schemas.errors[0]!.code).toBe('SCHEMA_INVALID');
    expect(schemas.errors[0]!.message).toContain('display_precision');
    expect(schemas.errors[0]!.message).toContain('finer than');
    cleanup();
  });

  it('accepts display_precision equal to store_precision', async () => {
    const root = buildProject(`
type: event
version: 1
fields:
  started_at:
    type: date
    store_precision: minute
    display_precision: minute
`);
    const reg = await loadRegistry(root);
    if (!reg.ok) return;
    const schemas = await loadSchemas(root, reg.value);
    expect(schemas.ok).toBe(true);
    cleanup();
  });

  it('rejects invalid store_precision value', async () => {
    const root = buildProject(`
type: event
version: 1
fields:
  started_at:
    type: date
    store_precision: seconds
`);
    const reg = await loadRegistry(root);
    if (!reg.ok) return;
    const schemas = await loadSchemas(root, reg.value);
    expect(schemas.ok).toBe(false);
    if (schemas.ok) return;
    expect(schemas.errors[0]!.message).toContain('store_precision');
    expect(schemas.errors[0]!.message).toContain('seconds');
    cleanup();
  });

  it('rejects invalid on_coarser value', async () => {
    const root = buildProject(`
type: event
version: 1
fields:
  started_at:
    type: date
    store_precision: minute
    on_coarser: panic
`);
    const reg = await loadRegistry(root);
    if (!reg.ok) return;
    const schemas = await loadSchemas(root, reg.value);
    expect(schemas.ok).toBe(false);
    if (schemas.ok) return;
    expect(schemas.errors[0]!.message).toContain('on_coarser');
    cleanup();
  });

  it('rejects precision keys on non-date fields', async () => {
    const root = buildProject(`
type: event
version: 1
fields:
  title:
    type: string
    store_precision: day
`);
    const reg = await loadRegistry(root);
    if (!reg.ok) return;
    const schemas = await loadSchemas(root, reg.value);
    expect(schemas.ok).toBe(false);
    if (schemas.ok) return;
    expect(schemas.errors[0]!.message).toContain('store_precision');
    expect(schemas.errors[0]!.message).toContain('only valid on date fields');
    cleanup();
  });

  it('absent precision keys leave field in null/lenient state (backward compat)', async () => {
    const root = buildProject(`
type: event
version: 1
fields:
  started_at:
    type: date
`);
    const reg = await loadRegistry(root);
    if (!reg.ok) return;
    const schemas = await loadSchemas(root, reg.value);
    expect(schemas.ok).toBe(true);
    if (!schemas.ok) return;
    const field = schemas.value.getSchemaForType('event' as any)!.fields.get('started_at')!;
    expect(field.storePrecision).toBeNull();
    expect(field.onCoarser).toBeNull();
    expect(field.displayPrecision).toBeNull();
    cleanup();
  });
});
