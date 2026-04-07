import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { simpleGit } from 'simple-git';
import { MaadEngine } from '../../src/engine.js';
import { docId, docType } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-git');

let engine: MaadEngine;

beforeAll(async () => {
  // Clean slate
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true });
  cpSync(FIXTURE_SRC, TEMP_ROOT, { recursive: true });
  const backendDir = path.join(TEMP_ROOT, '_backend');
  if (existsSync(backendDir)) rmSync(backendDir, { recursive: true });

  // Initialize git repo
  const git = simpleGit(TEMP_ROOT);
  await git.init();
  await git.addConfig('user.email', 'test@test.com');
  await git.addConfig('user.name', 'Test');
  await git.add('.');
  await git.commit('Initial commit');

  // Init engine
  engine = new MaadEngine();
  const result = await engine.init(TEMP_ROOT);
  expect(result.ok).toBe(true);
  await engine.indexAll({ force: true });
});

afterAll(async () => {
  engine.close();
  // Small delay to let file handles release on Windows
  await new Promise(r => setTimeout(r, 100));
  try {
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch {
    // Windows may hold handles briefly — non-fatal
  }
});

describe('git auto-commit on create', () => {
  it('creates a commit when a document is created', async () => {
    const result = await engine.createDocument(
      docType('client'),
      { name: 'GitTest Corp', status: 'active' },
      'A test client for git.',
      'cli-gittest',
    );
    expect(result.ok).toBe(true);

    // Check git log
    const git = simpleGit(TEMP_ROOT);
    const log = await git.log({ maxCount: 1 });
    expect(log.latest?.message).toContain('maad:create');
    expect(log.latest?.message).toContain('cli-gittest');
    expect(log.latest?.message).toContain('[client]');
  });
});

describe('git auto-commit on update', () => {
  it('creates a commit when a document is updated', async () => {
    const result = await engine.updateDocument(
      docId('cli-gittest'),
      { status: 'inactive' },
    );
    expect(result.ok).toBe(true);

    const git = simpleGit(TEMP_ROOT);
    const log = await git.log({ maxCount: 1 });
    expect(log.latest?.message).toContain('maad:update');
    expect(log.latest?.message).toContain('fields:status');
  });
});

describe('history', () => {
  it('returns commit history for a document', async () => {
    const result = await engine.history(docId('cli-gittest'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBeGreaterThanOrEqual(2); // create + update
    expect(result.value[0]!.action).toBe('update');
    expect(result.value[1]!.action).toBe('create');
  });

  it('returns empty for document with no MAAD commits', async () => {
    // cli-acme was added in the initial commit (not a MAAD commit)
    const result = await engine.history(docId('cli-acme'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });
});

describe('audit', () => {
  it('returns project-wide activity', async () => {
    const result = await engine.audit();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBeGreaterThanOrEqual(1);
    const gitTestEntry = result.value.find(e => (e.docId as string) === 'cli-gittest');
    expect(gitTestEntry).toBeDefined();
    expect(gitTestEntry!.actions).toBeGreaterThanOrEqual(2);
  });
});

describe('no git graceful degradation', () => {
  it('engine works without git', async () => {
    // Create a project without git
    const noGitRoot = path.resolve(__dirname, '../fixtures/_temp-nogit');
    if (existsSync(noGitRoot)) rmSync(noGitRoot, { recursive: true });
    cpSync(FIXTURE_SRC, noGitRoot, { recursive: true });
    const bd = path.join(noGitRoot, '_backend');
    if (existsSync(bd)) rmSync(bd, { recursive: true });

    const noGitEngine = new MaadEngine();
    const initResult = await noGitEngine.init(noGitRoot);
    expect(initResult.ok).toBe(true);

    // CRUD still works
    const indexResult = await noGitEngine.indexAll({ force: true });
    expect(indexResult.indexed).toBe(4);

    // Audit returns error
    const auditResult = await noGitEngine.audit();
    expect(auditResult.ok).toBe(false);
    if (!auditResult.ok) {
      expect(auditResult.errors[0]!.code).toBe('GIT_NOT_INITIALIZED');
    }

    noGitEngine.close();
    await new Promise(r => setTimeout(r, 100));
    try {
      if (existsSync(noGitRoot)) rmSync(noGitRoot, { recursive: true, force: true });
    } catch {
      // non-fatal
    }
  });
});
