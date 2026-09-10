import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { loadRegistry } from '../../src/registry/loader.js';
import { loadSchemas, loadSchemasFromSnapshot } from '../../src/schema/loader.js';
import { docType, schemaRef, type Registry } from '../../src/types.js';

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/simple-crm');

describe('loadSchemas', () => {
  it('loads all schemas referenced by registry', async () => {
    const regResult = await loadRegistry(FIXTURE_ROOT);
    expect(regResult.ok).toBe(true);
    if (!regResult.ok) return;

    const schemaResult = await loadSchemas(FIXTURE_ROOT, regResult.value);
    expect(schemaResult.ok).toBe(true);
    if (!schemaResult.ok) return;

    const store = schemaResult.value;
    expect(store.schemas.size).toBe(4);
  });

  it('parses case schema fields correctly', async () => {
    const regResult = await loadRegistry(FIXTURE_ROOT);
    if (!regResult.ok) return;

    const schemaResult = await loadSchemas(FIXTURE_ROOT, regResult.value);
    if (!schemaResult.ok) return;

    const caseSchema = schemaResult.value.getSchemaForType('case' as any);
    expect(caseSchema).toBeDefined();
    expect(caseSchema!.required).toContain('title');
    expect(caseSchema!.required).toContain('client');
    expect(caseSchema!.required).toContain('status');

    const statusField = caseSchema!.fields.get('status');
    expect(statusField).toBeDefined();
    expect(statusField!.type).toBe('enum');
    expect(statusField!.values).toEqual(['open', 'pending', 'closed']);
    expect(statusField!.index).toBe(true);
  });

  it('parses ref fields with targets', async () => {
    const regResult = await loadRegistry(FIXTURE_ROOT);
    if (!regResult.ok) return;

    const schemaResult = await loadSchemas(FIXTURE_ROOT, regResult.value);
    if (!schemaResult.ok) return;

    const caseSchema = schemaResult.value.getSchemaForType('case' as any);
    const clientField = caseSchema!.fields.get('client');
    expect(clientField).toBeDefined();
    expect(clientField!.type).toBe('ref');
    expect(clientField!.target).toBe('client');
  });

  it('defaults date format to YYYY-MM-DD', async () => {
    const regResult = await loadRegistry(FIXTURE_ROOT);
    if (!regResult.ok) return;

    const schemaResult = await loadSchemas(FIXTURE_ROOT, regResult.value);
    if (!schemaResult.ok) return;

    const caseSchema = schemaResult.value.getSchemaForType('case' as any);
    const dateField = caseSchema!.fields.get('opened_at');
    expect(dateField!.format).toBe('YYYY-MM-DD');
    expect(dateField!.role).toBe('created_at');
  });

  it('resolves schemas by type', async () => {
    const regResult = await loadRegistry(FIXTURE_ROOT);
    if (!regResult.ok) return;

    const schemaResult = await loadSchemas(FIXTURE_ROOT, regResult.value);
    if (!schemaResult.ok) return;

    const store = schemaResult.value;
    expect(store.getSchemaForType('client' as any)).toBeDefined();
    expect(store.getSchemaForType('nonexistent' as any)).toBeUndefined();
    expect(store.getSchema('client.v1' as any)).toBeDefined();
  });
});

describe('schema source snapshots', () => {
  let root: string;
  let registry: Registry;
  const ref = schemaRef('note.v1');
  const source = 'type: note\nversion: 1\nrequired: [title]\nfields:\n'
    + '  title: {type: string, max_length: 40, soft_max_length: 30, multiline: false, default: Untitled}\n'
    + '  parent: {type: ref, target: note}\n'
    + '  state: {type: enum, values: [open, closed]}\n'
    + '  observed: {type: date, store_precision: second, display_precision: day}\n'
    + 'template:\n  headings:\n    - {level: 1, text: Summary, id: summary}\n';
  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'schema-snapshot-'));
    mkdirSync(path.join(root, '_registry')); mkdirSync(path.join(root, '_schema'));
    writeFileSync(path.join(root, '_registry/object_types.yaml'), 'types:\n  note: {path: notes, id_prefix: nt, schema: note.v1}\n');
    writeFileSync(path.join(root, '_schema/note.v1.yaml'), source);
    const result = await loadRegistry(root);
    if (!result.ok) throw new Error(JSON.stringify(result));
    registry = result.value;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    const relative = path.relative(tmpdir(), root);
    expect(relative && !relative.startsWith('..') && !path.isAbsolute(relative)).toBeTruthy();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it.each([false, true])('shares parser semantics and all effective fields with disk loading (frontmatter: %s)', async wrapped => {
    const raw = wrapped ? `---\n${source}---\nSchema description\n` : source;
    writeFileSync(path.join(root, '_schema/note.v1.yaml'), raw);
    const disk = await loadSchemas(root, registry);
    const snapshot = await loadSchemasFromSnapshot(registry, new Map([[ref, raw]]));
    expect(disk.ok).toBe(true); expect(snapshot.ok).toBe(true);
    if (!disk.ok || !snapshot.ok) throw new Error('Expected valid schemas');
    expect(snapshot.value.schemas).toEqual(disk.value.schemas);
    const schema = snapshot.value.getSchemaForType(docType('note'))!;
    expect(schema.fields.get('title')).toMatchObject({ maxLength: 40, softMaxLength: 30, multiline: false, defaultValue: 'Untitled' });
    expect(schema.fields.get('observed')).toMatchObject({ storePrecision: 'second', displayPrecision: 'day', onCoarser: 'warn', format: 'YYYY-MM-DD' });
    expect(schema.fields.get('parent')?.target).toBe('note');
    expect(schema.fields.get('state')?.values).toEqual(['open', 'closed']);
    expect(schema.template).toEqual([{ level: 1, text: 'Summary', id: 'summary' }]);
    expect(snapshot.value.cachedFiles.size).toBe(0);
    expect(snapshot.value.isStale()).toBe(true);
    expect(disk.value.cachedFiles.size).toBe(2);
    expect(disk.value.isStale()).toBe(false);
  });

  it.each([
    ['unknown constraint', source.replace('max_length: 40', 'unknown_constraint: 40')],
    ['invalid constraint', source.replace('max_length: 40', 'max_length: 0')],
    ['invalid precision', source.replace('display_precision: day', 'display_precision: millisecond')],
    ['unknown reference', source.replace('target: note', 'target: missing')],
    ['undefined required field', source.replace('[title]', '[missing]')],
    ['invalid YAML', 'type: ['],
    ['BOM', '\uFEFF' + source],
  ])('preserves shared rejection for %s', async (_name, raw) => {
    writeFileSync(path.join(root, '_schema/note.v1.yaml'), raw);
    const disk = await loadSchemas(root, registry);
    const snapshot = await loadSchemasFromSnapshot(registry, new Map([[ref, raw]]));
    expect(disk.ok).toBe(false);
    expect(snapshot).toEqual(disk);
  });

  it('never reads disk or substitutes a missing snapshot entry', async () => {
    const read = vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('Disk access forbidden'));
    const stat = vi.spyOn(fs, 'stat').mockRejectedValue(new Error('Disk access forbidden'));
    const missing = await loadSchemasFromSnapshot(registry, new Map());
    expect(!missing.ok && missing.errors[0]!.code).toBe('SCHEMA_NOT_FOUND');
    const loaded = await loadSchemasFromSnapshot(registry, new Map([[ref, source]]));
    expect(loaded.ok).toBe(true);
    expect(read).not.toHaveBeenCalled(); expect(stat).not.toHaveBeenCalled();
  });

  it('freezes snapshot entries before asynchronous validation', async () => {
    const other = schemaRef('other.v1');
    registry.types.set(docType('other'), { name: docType('other'), path: 'others', idPrefix: 'ot', schemaRef: other, template: null });
    const sources = new Map([[ref, source], [other, source.replace('type: note', 'type: other')]]);
    const pending = loadSchemasFromSnapshot(registry, sources);
    // The second source has not been requested when the first reader yields.
    sources.set(other, 'type: [');
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.getSchema(other)?.fields.get('title')?.maxLength).toBe(40);
  });

  it.each(['before', 'during'])('cancels %s validation without returning a partial store', async when => {
    const controller = new AbortController();
    if (when === 'before') controller.abort();
    const pending = loadSchemasFromSnapshot(registry, new Map([[ref, source]]), { signal: controller.signal });
    controller.abort();
    const result = await pending;
    expect(!result.ok && result.errors[0]!.code).toBe('REQUEST_TIMEOUT');
    expect(result).not.toHaveProperty('value');
  });
});
