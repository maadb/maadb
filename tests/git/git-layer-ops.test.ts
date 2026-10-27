// ============================================================================
// GitLayer operations under simple-git 4.
//
// simple-git 4 guards every GIT_* env key: ambient ones are dropped from the
// child env, and explicitly supplied ones throw unless the instance lists them
// in `allowEnvironment`. The engine passes the commit identity through .env(),
// so each git operation GitLayer runs is exercised here against a real repo,
// with hostile ambient env (EDITOR, VISUAL, PAGER, GIT_*) set.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { GitLayer } from '../../src/git/index.js';
import { buildGitEnv, GIT_IDENTITY_ENV_KEYS, resolveCommitAuthor } from '../../src/git/commit.js';
import { docId, docType } from '../../src/types.js';

const AMBIENT: Record<string, string> = {
  EDITOR: 'false',
  VISUAL: 'false',
  PAGER: 'false',
  GIT_ASKPASS: 'false',
  GIT_EDITOR: 'false',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_PARAMETERS: "'user.name=ambient'",
  GIT_AUTHOR_NAME: 'ambient-author',
};

let root: string;
let layer: GitLayer;
const saved: Record<string, string | undefined> = {};
const FILE = 'clients/cli-acme.md';
const ID = docId('cli-acme');

function writeDoc(status: string, body: string): void {
  writeFileSync(
    path.join(root, FILE),
    `---\ndoc_id: cli-acme\ndoc_type: client\nstatus: ${status}\n---\n\n${body}\n`,
    'utf-8',
  );
}

beforeAll(async () => {
  for (const [k, v] of Object.entries(AMBIENT)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  root = mkdtempSync(path.join(tmpdir(), 'maadb-git-ops-'));
  mkdirSync(path.join(root, 'clients'));
  layer = new GitLayer(root);
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('buildGitEnv', () => {
  it('strips unsafe and ambient GIT_* keys, keeping only the commit identity', () => {
    const env = buildGitEnv();
    for (const key of ['EDITOR', 'VISUAL', 'PAGER', 'GIT_ASKPASS', 'GIT_EDITOR', 'GIT_TERMINAL_PROMPT', 'GIT_CONFIG_PARAMETERS']) {
      expect(env[key]).toBeUndefined();
    }
    const gitKeys = Object.keys(env).filter(k => k.toUpperCase().startsWith('GIT_')).sort();
    expect(gitKeys).toEqual([...GIT_IDENTITY_ENV_KEYS].sort());
    expect(env['GIT_AUTHOR_NAME']).toBe('maadb-engine');
    expect(env['PATH'] ?? env['Path']).toBeDefined();
  });
});

describe('GitLayer operations (simple-git 4)', () => {
  let firstSha: string;
  let secondSha: string;

  it('initRepo creates the repo and an identity-stamped initial commit', async () => {
    expect(await layer.isRepo()).toBe(false);
    await layer.initRepo();
    expect(await layer.isRepo()).toBe(true);
    const log = await simpleGit(root).log();
    expect(log.latest?.message).toBe('maad:init — Initialize MAAD project');
    expect(log.latest?.author_name).toBe('maadb-engine');
  });

  it('headSha and currentBranch resolve HEAD via revparse', async () => {
    expect(await layer.headSha()).toMatch(/^[0-9a-f]{40}$/);
    expect(await layer.currentBranch()).not.toBe('HEAD');
  });

  it('commit stages and commits with the engine identity, not the ambient one', async () => {
    writeDoc('active', 'First body.');
    const outcome = await layer.commit({
      action: 'create', docId: ID, docType: docType('client'),
      detail: '', summary: 'created', files: [FILE],
    });
    expect(outcome.status).toBe('committed');
    if (outcome.status === 'committed') firstSha = outcome.sha as string;
    const latest = (await simpleGit(root).log()).latest;
    expect(latest?.author_name).toBe('maadb-engine');
    expect(latest?.author_email).toBe(resolveCommitAuthor().GIT_AUTHOR_EMAIL);
  });

  it('commit with nothing staged is a noop (status pathspec)', async () => {
    const outcome = await layer.commit({
      action: 'update', docId: ID, docType: docType('client'),
      detail: '', summary: 'no change', files: [FILE],
    });
    expect(outcome.status).toBe('noop');
  });

  it('history and audit read maad commits via log', async () => {
    writeDoc('closed', 'Second body.');
    const outcome = await layer.commit({
      action: 'update', docId: ID, docType: docType('client'),
      detail: 'fields:status', summary: 'closed', files: [FILE],
    });
    expect(outcome.status).toBe('committed');
    if (outcome.status === 'committed') secondSha = outcome.sha as string;

    const history = await layer.history(FILE);
    expect(history.map(c => c.action)).toEqual(['update', 'create']);
    expect(history[0]!.author).toBe('maadb-engine');

    const audit = await layer.audit();
    const entry = audit.find(e => (e.docId as string) === 'cli-acme');
    expect(entry?.actions).toBe(2);
  });

  it('diff reads both versions via show and the body via diff', async () => {
    const diff = await layer.diff(FILE, ID, firstSha, secondSha);
    expect(diff?.frontmatterChanges['status']).toEqual({ from: 'active', to: 'closed' });
    expect(diff?.bodyDiff).toContain('+Second body.');
  });

  it('snapshot reads the document at a commit', async () => {
    const snap = await layer.snapshot(FILE, ID, firstSha);
    expect(snap?.frontmatter['status']).toBe('active');
    expect(snap?.body).toContain('First body.');
  });

  it('annotated tags: create at HEAD and at a sha, list by prefix, delete', async () => {
    await layer.addAnnotatedTag('maad-backup/one', 'backup one');
    await layer.addAnnotatedTag('maad-backup/two', 'backup two', firstSha);
    const tags = await layer.listTagsByPrefix('maad-backup/');
    expect(tags.map(t => [t.tag, t.sha, t.message])).toEqual([
      ['maad-backup/one', secondSha, 'backup one'],
      ['maad-backup/two', firstSha, 'backup two'],
    ]);
    await layer.deleteTag('maad-backup/one');
    expect((await layer.listTagsByPrefix('maad-backup/')).map(t => t.tag)).toEqual(['maad-backup/two']);
  });

  it('raw add/commit through getSimpleGit (instructions refresh path) still works', async () => {
    writeFileSync(path.join(root, 'notes.md'), 'notes\n', 'utf-8');
    const sg = layer.getSimpleGit();
    await sg.add(['notes.md']);
    const result = await sg.commit('maad:instructions — refresh');
    expect(result.commit).not.toBe('');
  });
});
