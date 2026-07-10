import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadRegistry } from '../../src/registry/loader.js';
import { loadSchemas } from '../../src/schema/loader.js';
import { docType, schemaRef } from '../../src/types.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/simple-crm');

let root: string;
const outsideRoots: string[] = [];

function outsideDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `maad-registry-${label}-`));
  outsideRoots.push(dir);
  return dir;
}

function replaceRegistry(search: string, replacement: string): void {
  const file = path.join(root, '_registry', 'object_types.yaml');
  const next = readFileSync(file, 'utf-8').replace(search, replacement);
  writeFileSync(file, next, 'utf-8');
}

function linkDirectory(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'maad-registry-boundary-'));
  cpSync(FIXTURE, root, { recursive: true });
});

afterEach(() => {
  try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows handles */ }
  while (outsideRoots.length > 0) {
    const dir = outsideRoots.pop()!;
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows handles */ }
  }
});

describe('registry path boundaries', () => {
  it('rejects traversal in type, schema, and template references', async () => {
    replaceRegistry('path: clients/', 'path: ../clients/');
    let result = await loadRegistry(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(error => error.code === 'REGISTRY_INVALID')).toBe(true);

    cpSync(FIXTURE, root, { recursive: true, force: true });
    replaceRegistry('schema: client.v1', 'schema: ../client.v1');
    result = await loadRegistry(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(error => error.message.includes('positive integer'))).toBe(true);

    cpSync(FIXTURE, root, { recursive: true, force: true });
    replaceRegistry(
      '    schema: client.v1',
      '    schema: client.v1\n    template: ../outside.md',
    );
    result = await loadRegistry(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(error => error.message.includes('template escapes'))).toBe(true);
  });

  it('rejects a type directory that resolves through an outward symlink', async () => {
    const outside = outsideDir('type');
    linkDirectory(outside, path.join(root, 'escape'));
    replaceRegistry('path: clients/', 'path: escape/clients/');

    const result = await loadRegistry(root);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some(error =>
        error.code === 'REGISTRY_INVALID' && error.message.includes('path escapes project root'))).toBe(true);
    }
  });

  it('rejects schema and template files reached through outward directory symlinks', async () => {
    const originalSchema = path.join(root, '_schema');
    const externalSchema = path.join(outsideDir('schema'), 'schema-files');
    cpSync(originalSchema, externalSchema, { recursive: true });
    rmSync(originalSchema, { recursive: true, force: true });
    linkDirectory(externalSchema, originalSchema);

    let result = await loadRegistry(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(error => error.message.includes('schema escapes'))).toBe(true);

    rmSync(originalSchema, { recursive: true, force: true });
    cpSync(path.join(FIXTURE, '_schema'), originalSchema, { recursive: true });
    const externalTemplates = outsideDir('template');
    writeFileSync(path.join(externalTemplates, 'client.md'), '# Outside\n', 'utf-8');
    linkDirectory(externalTemplates, path.join(root, '_templates'));
    replaceRegistry(
      '    schema: client.v1',
      '    schema: client.v1\n    template: _templates/client.md',
    );

    result = await loadRegistry(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some(error => error.message.includes('template escapes'))).toBe(true);
  });

  it('rejects a registry file reached through an outward directory symlink', async () => {
    const originalRegistry = path.join(root, '_registry');
    const externalRegistry = path.join(outsideDir('registry'), 'registry-files');
    cpSync(originalRegistry, externalRegistry, { recursive: true });
    rmSync(originalRegistry, { recursive: true, force: true });
    linkDirectory(externalRegistry, originalRegistry);

    const result = await loadRegistry(root);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]!.code).toBe('REGISTRY_INVALID');
  });

  it('rejects an unsafe schema reference passed directly to the schema loader', async () => {
    const loaded = await loadRegistry(root);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const clientType = docType('client');
    const client = loaded.value.types.get(clientType)!;
    loaded.value.types.set(clientType, {
      ...client,
      schemaRef: schemaRef('../outside.v1'),
    });

    const result = await loadSchemas(root, loaded.value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]!.code).toBe('SCHEMA_INVALID');
  });
});
