// ============================================================================
// Bootstrap tests — empty-project boot, self-heal, _skills scaffolding
// Covers the 0.2.13 fix: engine must boot on empty directories so the agent
// can enter Architect mode via the summary bootstrapHint.
// ============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { MaadEngine } from '../../src/engine.js';
import { ensureProjectSkills } from '../../src/skills-scaffold.js';

const createdDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `maad-bootstrap-${prefix}-`));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await new Promise(r => setTimeout(r, 50));
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows file handle lag — non-fatal
    }
  }
});

describe('engine bootstrap — empty project', () => {
  it('boots successfully on a fully empty directory', async () => {
    const dir = makeTempDir('empty');
    const engine = new MaadEngine();

    const result = await engine.init(dir);
    expect(result.ok).toBe(true);

    // Self-heal wrote the registry and schema dir
    expect(existsSync(path.join(dir, '_registry', 'object_types.yaml'))).toBe(true);
    expect(existsSync(path.join(dir, '_schema'))).toBe(true);
    expect(existsSync(path.join(dir, '_backend'))).toBe(true);

    // Registry file is minimal, not seeded with starter types
    const regContent = readFileSync(path.join(dir, '_registry', 'object_types.yaml'), 'utf-8');
    expect(regContent).toContain('types:');
    expect(regContent).not.toContain('daily_log');
    expect(regContent).not.toContain('memory_entry');

    engine.close();
  });

  it('summary returns structured empty-state on a fresh project', async () => {
    const dir = makeTempDir('summary');
    const engine = new MaadEngine();
    await engine.init(dir);

    const summary = engine.summary();
    expect(summary.emptyProject).toBe(true);
    expect(summary.bootstrapHint).toBe('_skills/architect-core.md');
    expect(summary.readOnly).toBe(false);
    expect(summary.totalDocuments).toBe(0);
    expect(summary.types).toEqual([]);

    engine.close();
  });

  it('health mirrors the same empty-state signal', async () => {
    const dir = makeTempDir('health');
    const engine = new MaadEngine();
    await engine.init(dir);

    const health = engine.health();
    expect(health.emptyProject).toBe(true);
    expect(health.bootstrapHint).toBe('_skills/architect-core.md');
    expect(health.registeredTypes).toBe(0);
    expect(health.totalDocuments).toBe(0);

    engine.close();
  });

  it('self-heals a partial directory that has _registry but no _schema', async () => {
    const dir = makeTempDir('partial');
    mkdirSync(path.join(dir, '_registry'), { recursive: true });
    writeFileSync(path.join(dir, '_registry', 'object_types.yaml'), 'types: {}\n', 'utf-8');

    const engine = new MaadEngine();
    const result = await engine.init(dir);
    expect(result.ok).toBe(true);
    expect(existsSync(path.join(dir, '_schema'))).toBe(true);

    engine.close();
  });

  it('engine.init() is idempotent — second call is a no-op', async () => {
    const dir = makeTempDir('idempotent');
    const engine1 = new MaadEngine();
    const r1 = await engine1.init(dir);
    expect(r1.ok).toBe(true);
    engine1.close();

    const engine2 = new MaadEngine();
    const r2 = await engine2.init(dir);
    expect(r2.ok).toBe(true);

    const health = engine2.health();
    expect(health.emptyProject).toBe(true);

    engine2.close();
  });

  it('refuses to self-heal in read-only mode', async () => {
    const dir = makeTempDir('readonly');
    const engine = new MaadEngine();
    const result = await engine.init(dir, { readOnly: true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('READ_ONLY');
  });

  it('boots two engines on two separate empty dirs (multi-project stub)', async () => {
    const dirA = makeTempDir('multi-a');
    const dirB = makeTempDir('multi-b');

    const engineA = new MaadEngine();
    const engineB = new MaadEngine();

    const rA = await engineA.init(dirA);
    const rB = await engineB.init(dirB);

    expect(rA.ok).toBe(true);
    expect(rB.ok).toBe(true);
    expect(engineA.getProjectRoot()).toBe(path.resolve(dirA));
    expect(engineB.getProjectRoot()).toBe(path.resolve(dirB));

    engineA.close();
    engineB.close();
  });
});

describe('ensureProjectSkills', () => {
  it('creates all three guide files in an empty directory', () => {
    const dir = makeTempDir('skills-fresh');
    const result = ensureProjectSkills(dir);

    expect(result.created).toHaveLength(3);
    expect(result.created).toContain(path.join('_skills', 'architect-core.md'));
    expect(result.created).toContain(path.join('_skills', 'schema-guide.md'));
    expect(result.created).toContain(path.join('_skills', 'import-guide.md'));
    expect(result.errors).toEqual([]);

    expect(existsSync(path.join(dir, '_skills', 'architect-core.md'))).toBe(true);
    expect(existsSync(path.join(dir, '_skills', 'schema-guide.md'))).toBe(true);
    expect(existsSync(path.join(dir, '_skills', 'import-guide.md'))).toBe(true);
  });

  it('does not overwrite existing customized skill files', () => {
    const dir = makeTempDir('skills-customized');
    const skillDir = path.join(dir, '_skills');
    mkdirSync(skillDir, { recursive: true });
    const customContent = '# My customized architect guide\n\nCustom content.';
    writeFileSync(path.join(skillDir, 'architect-core.md'), customContent, 'utf-8');

    const result = ensureProjectSkills(dir);

    // architect-core.md was skipped, the other two were created
    expect(result.skipped).toContain(path.join('_skills', 'architect-core.md'));
    expect(result.created).toContain(path.join('_skills', 'schema-guide.md'));
    expect(result.created).toContain(path.join('_skills', 'import-guide.md'));

    // Custom content is preserved
    const actual = readFileSync(path.join(skillDir, 'architect-core.md'), 'utf-8');
    expect(actual).toBe(customContent);
  });

  it('is idempotent — second call creates nothing new', () => {
    const dir = makeTempDir('skills-idempotent');
    const first = ensureProjectSkills(dir);
    expect(first.created).toHaveLength(3);

    const second = ensureProjectSkills(dir);
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(3);
    expect(second.errors).toEqual([]);
  });
});
