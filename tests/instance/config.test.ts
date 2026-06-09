// ============================================================================
// Instance config loader tests
// ============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { loadInstance, validateInstance, synthesizeLegacyInstance, getProject } from '../../src/instance/config.js';

const createdDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'maad-instance-'));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* windows */ }
  }
});

describe('loadInstance', () => {
  it('loads a valid instance.yaml', async () => {
    const dir = makeTempDir();
    const cfgPath = path.join(dir, 'instance.yaml');
    writeFileSync(cfgPath, `name: test-instance\nprojects:\n  - name: alpha\n    path: ${dir.replace(/\\/g, '/')}\n    role: admin\n    description: first project\n  - name: beta\n    path: ${dir.replace(/\\/g, '/')}\n    role: reader\n`);

    const result = await loadInstance(cfgPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.name).toBe('test-instance');
    expect(result.value.projects).toHaveLength(2);
    expect(result.value.projects[0].name).toBe('alpha');
    expect(result.value.projects[0].role).toBe('admin');
    expect(result.value.projects[0].description).toBe('first project');
    expect(result.value.projects[1].role).toBe('reader');
    expect(result.value.source).toBe('file');
  });

  it('fails when file does not exist', async () => {
    const result = await loadInstance('C:/definitely/not/a/real/path/instance.yaml');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('INSTANCE_CONFIG_NOT_FOUND');
  });

  it('resolves relative project paths against config directory', async () => {
    const dir = makeTempDir();
    const cfgPath = path.join(dir, 'instance.yaml');
    writeFileSync(cfgPath, `name: rel\nprojects:\n  - name: here\n    path: ./subdir\n`);
    const result = await loadInstance(cfgPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projects[0].path).toBe(path.resolve(dir, 'subdir'));
  });
});

describe('validateInstance', () => {
  it('rejects missing name', () => {
    const result = validateInstance({ projects: [{ name: 'a', path: '/x' }] });
    expect(result.ok).toBe(false);
  });

  it('rejects empty projects array', () => {
    const result = validateInstance({ name: 'x', projects: [] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('INSTANCE_CONFIG_INVALID');
  });

  it('rejects duplicate project names', () => {
    const result = validateInstance({
      name: 'x',
      projects: [
        { name: 'a', path: '/x' },
        { name: 'a', path: '/y' },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some(e => e.message.includes('duplicated'))).toBe(true);
  });

  it('rejects invalid project name format', () => {
    const result = validateInstance({
      name: 'x',
      projects: [{ name: 'Bad Name!', path: '/x' }],
    });
    expect(result.ok).toBe(false);
  });

  it('defaults role to reader when omitted', () => {
    const result = validateInstance({
      name: 'x',
      projects: [{ name: 'a', path: '/abs/path' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projects[0].role).toBe('reader');
  });
});

describe('synthesizeLegacyInstance', () => {
  it('wraps a single path into a synthetic one-project instance', () => {
    const inst = synthesizeLegacyInstance('C:/Dev/maadb', 'writer');
    expect(inst.source).toBe('synthetic');
    expect(inst.projects).toHaveLength(1);
    expect(inst.projects[0].name).toBe('default');
    expect(inst.projects[0].role).toBe('writer');
    expect(inst.projects[0].path).toBe(path.resolve('C:/Dev/maadb'));
  });
});

describe('getProject', () => {
  it('finds by name', () => {
    const inst = synthesizeLegacyInstance('/x', 'reader');
    expect(getProject(inst, 'default')?.name).toBe('default');
    expect(getProject(inst, 'nope')).toBeUndefined();
  });
});
