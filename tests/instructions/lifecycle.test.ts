// ============================================================================
// Managed-instruction lifecycle — stamp/classify/refresh + upgrade inertness
//
// Contract under test (dec: instruction lifecycle, 2026-07-13):
// - stamped files classify current/outdated/modified; unstamped = unmanaged
// - scaffold is strictly create-if-absent (upgrade inertness)
// - refresh plan: outdated+missing refresh; modified/unmanaged only with force
// ============================================================================

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import path from 'node:path';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import {
  MANAGED_ARTIFACTS, stampContent, parseStamp, classifyContent,
  checkProject, planRefresh, applyRefresh, engineVersion, hashBody,
} from '../../src/instructions/manifest.js';
import { ensureProjectSkills, emitInstructionsAdvisory } from '../../src/skills-scaffold.js';

const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-instructions-lifecycle');
let caseCounter = 0;
let root = '';

beforeEach(() => {
  root = path.join(TEMP_ROOT, `case-${caseCounter++}`);
  mkdirSync(root, { recursive: true });
});

afterAll(() => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const ARCHITECT = MANAGED_ARTIFACTS.find(a => a.name === 'architect-core')!;

function writeArtifact(relPath: string, content: string): void {
  const abs = path.join(root, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
}

// ---- Stamp + classification -------------------------------------------------

describe('stamp parse and classification', () => {
  it('stamped generator output round-trips and classifies current', () => {
    const stamped = stampContent(ARCHITECT.name, ARCHITECT.generate());
    const parsed = parseStamp(stamped)!;
    expect(parsed.name).toBe('architect-core');
    expect(parsed.engine).toBe(engineVersion());
    expect(hashBody(parsed.body)).toBe(parsed.hash);
    expect(classifyContent(stamped, ARCHITECT).state).toBe('current');
  });

  it('pristine stamp over stale content classifies outdated', () => {
    const staleBody = ARCHITECT.generate() + '\nOld trailing guidance since removed.\n';
    const stamped = stampContent(ARCHITECT.name, staleBody, '0.9.0');
    const status = classifyContent(stamped, ARCHITECT);
    expect(status.state).toBe('outdated');
    expect(status.stampedEngine).toBe('0.9.0');
  });

  it('user-edited content under a stamp classifies modified', () => {
    const stamped = stampContent(ARCHITECT.name, ARCHITECT.generate());
    const tampered = stamped + '\nMy local note.\n';
    expect(classifyContent(tampered, ARCHITECT).state).toBe('modified');
  });

  it('unstamped legacy content classifies unmanaged; absent file missing', () => {
    expect(classifyContent('# Old guide from 0.6.x\n', ARCHITECT).state).toBe('unmanaged');
    expect(classifyContent(null, ARCHITECT).state).toBe('missing');
  });

  it('CRLF round-trip does not misclassify a pristine file as modified', () => {
    const stamped = stampContent(ARCHITECT.name, ARCHITECT.generate());
    const crlf = stamped.replace(/\n/g, '\r\n');
    expect(classifyContent(crlf, ARCHITECT).state).toBe('current');
  });
});

// ---- Scaffold: create-if-absent + upgrade inertness --------------------------

describe('scaffold', () => {
  it('creates all managed artifacts stamped on an empty project', () => {
    const result = ensureProjectSkills(root);
    expect(result.created.sort()).toEqual(MANAGED_ARTIFACTS.map(a => a.relPath).sort());
    expect(result.errors).toEqual([]);
    for (const status of checkProject(root)) {
      expect(status.state, status.relPath).toBe('current');
    }
  });

  it('UPGRADE INERTNESS: a project with all files present gets zero writes', () => {
    // Old-vintage project: legacy unstamped files everywhere.
    for (const a of MANAGED_ARTIFACTS) writeArtifact(a.relPath, `# legacy ${a.name} from 0.6.x\n`);
    const before = new Map(MANAGED_ARTIFACTS.map(a => {
      const abs = path.join(root, a.relPath);
      return [a.relPath, { mtime: statSync(abs).mtimeMs, content: readFileSync(abs, 'utf-8') }];
    }));

    const result = ensureProjectSkills(root);
    emitInstructionsAdvisory(root); // must not write either

    expect(result.created).toEqual([]);
    expect(result.skipped.length).toBe(MANAGED_ARTIFACTS.length);
    for (const a of MANAGED_ARTIFACTS) {
      const abs = path.join(root, a.relPath);
      expect(readFileSync(abs, 'utf-8'), a.relPath).toBe(before.get(a.relPath)!.content);
      expect(statSync(abs).mtimeMs, a.relPath).toBe(before.get(a.relPath)!.mtime);
    }
  });
});

// ---- Refresh plan + apply -----------------------------------------------------

describe('refresh', () => {
  it('refreshes outdated and missing, leaves current untouched', () => {
    ensureProjectSkills(root);
    // Make architect-core outdated (pristine stamp over stale body) and delete schema-guide.
    const staleBody = ARCHITECT.generate() + '\nRemoved section.\n';
    writeArtifact(ARCHITECT.relPath, stampContent(ARCHITECT.name, staleBody, '0.9.0'));
    rmSync(path.join(root, '_skills/schema-guide.md'));

    const plan = planRefresh(root, { force: false });
    expect(plan.refresh.map(s => s.name).sort()).toEqual(['architect-core', 'schema-guide']);
    expect(plan.current.length).toBe(2);
    expect(plan.skippedModified).toEqual([]);
    expect(plan.skippedUnmanaged).toEqual([]);

    const written = applyRefresh(root, plan);
    expect(written.length).toBe(2);
    for (const status of checkProject(root)) {
      expect(status.state, status.relPath).toBe('current');
    }
  });

  it('never touches modified or unmanaged without force', () => {
    ensureProjectSkills(root);
    const stamped = readFileSync(path.join(root, ARCHITECT.relPath), 'utf-8');
    writeArtifact(ARCHITECT.relPath, stamped + '\nLocal customization.\n');       // modified
    writeArtifact('_skills/schema-guide.md', '# legacy unstamped guide\n');        // unmanaged

    const plan = planRefresh(root, { force: false });
    expect(plan.refresh).toEqual([]);
    expect(plan.skippedModified.map(s => s.name)).toEqual(['architect-core']);
    expect(plan.skippedUnmanaged.map(s => s.name)).toEqual(['schema-guide']);

    applyRefresh(root, plan);
    expect(readFileSync(path.join(root, ARCHITECT.relPath), 'utf-8')).toContain('Local customization.');
    expect(readFileSync(path.join(root, '_skills/schema-guide.md'), 'utf-8')).toBe('# legacy unstamped guide\n');
  });

  it('force adopts modified and unmanaged files', () => {
    ensureProjectSkills(root);
    const stamped = readFileSync(path.join(root, ARCHITECT.relPath), 'utf-8');
    writeArtifact(ARCHITECT.relPath, stamped + '\nLocal customization.\n');
    writeArtifact('_skills/schema-guide.md', '# legacy unstamped guide\n');

    const plan = planRefresh(root, { force: true });
    expect(plan.refresh.map(s => s.name).sort()).toEqual(['architect-core', 'schema-guide']);
    applyRefresh(root, plan);
    for (const status of checkProject(root)) {
      expect(status.state, status.relPath).toBe('current');
    }
  });
});
