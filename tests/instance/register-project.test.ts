// ============================================================================
// 0.23.0 — engine-owned project registration: registerProject and the
// maad_register_project tool.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registerProject } from '../../src/instance/register.js';
import { loadInstance } from '../../src/instance/config.js';
import { EnginePool } from '../../src/instance/pool.js';
import { SessionRegistry } from '../../src/instance/session.js';
import { registerReload } from '../../src/mcp/tools/instance.js';
import type { InstanceCtx } from '../../src/mcp/ctx.js';
import type { TokenRecord } from '../../src/auth/types.js';
import { makeTokenFixture, type TokenFixture } from '../support/token-fixture.js';

let tmpRoot: string;
let configPath: string;

const BASE_YAML = [
  '# Fictional test instance. This comment must survive registration.',
  'name: register-test',
  'projects:',
  '  - name: alpha',
  '    path: alpha',
  '    role: admin',
  '    history_mode: feed',
  '',
].join('\n');

beforeEach(async () => {
  tmpRoot = await mkdtemp(path.join(tmpdir(), 'maad-register-'));
  await mkdir(path.join(tmpRoot, 'alpha'));
  configPath = path.join(tmpRoot, 'instance.yaml');
  await writeFile(configPath, BASE_YAML, 'utf8');
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
});

describe('registerProject', () => {
  it('creates, scaffolds, git-inits an audit project and appends it in place', async () => {
    const r = await registerProject(configPath, { name: 'beta', role: 'writer', historyMode: 'audit', description: 'Fictional "beta"' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ name: 'beta', role: 'writer', historyMode: 'audit', registered: true, directoryCreated: true, gitInitialized: true });

    const dir = path.join(tmpRoot, 'beta');
    expect(existsSync(path.join(dir, '.git'))).toBe(true);
    expect(existsSync(path.join(dir, '_schema'))).toBe(true);
    expect(await readFile(path.join(dir, '_registry', 'object_types.yaml'), 'utf8')).toBe('types: {}\n');

    const text = await readFile(configPath, 'utf8');
    expect(text.startsWith(BASE_YAML.trimEnd())).toBe(true);
    expect(text).toContain('# Fictional test instance.');

    const loaded = await loadInstance(configPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const beta = loaded.value.projects.find(p => p.name === 'beta')!;
    expect(beta.path).toBe(dir);
    expect(beta.configuredHistoryMode).toBe('audit');
    expect(beta.historyModeSource).toBe('project');
    expect(beta.description).toBe('Fictional "beta"');
  });

  it('a feed project gets no Git repository', async () => {
    const r = await registerProject(configPath, { name: 'feed-one', role: 'admin', historyMode: 'feed', path: 'nested/feed-one' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.gitInitialized).toBe(false);
    expect(existsSync(path.join(tmpRoot, 'nested', 'feed-one', '.git'))).toBe(false);
  });

  it('keeps batch history options', async () => {
    const r = await registerProject(configPath, { name: 'batched', role: 'admin', historyMode: 'batch', historyOptions: { max_writes: 20 } });
    expect(r.ok).toBe(true);
    const loaded = await loadInstance(configPath);
    if (!loaded.ok) throw new Error('load');
    expect(loaded.value.projects.find(p => p.name === 'batched')?.historyOptions).toEqual({ max_writes: 20 });
  });

  it('is idempotent for the same declaration', async () => {
    const first = await registerProject(configPath, { name: 'beta', role: 'admin', historyMode: 'audit' });
    expect(first.ok).toBe(true);
    const text = await readFile(configPath, 'utf8');

    const again = await registerProject(configPath, { name: 'beta', role: 'admin', historyMode: 'audit' });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.registered).toBe(false);
    expect(await readFile(configPath, 'utf8')).toBe(text);
  });

  it('refuses a different mode, role or path for a registered name', async () => {
    const r = await registerProject(configPath, { name: 'alpha', role: 'reader', historyMode: 'audit' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]?.code).toBe('PROJECT_ALREADY_REGISTERED');
    expect(r.errors[0]?.details?.['conflicts']).toEqual(['role', 'historyMode']);
    expect(await readFile(configPath, 'utf8')).toBe(BASE_YAML);
  });

  it.each([
    ['../outside', 'parent escape'],
    ['', 'empty'],
    ['.', 'the instance folder itself'],
    ['alpha/inner', 'inside another project'],
  ])('refuses path %j (%s)', async (p) => {
    const r = await registerProject(configPath, { name: 'gamma', role: 'admin', historyMode: 'feed', path: p });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]?.code).toBe('PROJECT_PATH_INVALID');
    expect(await readFile(configPath, 'utf8')).toBe(BASE_YAML);
  });

  it('refuses an absolute path', async () => {
    const r = await registerProject(configPath, { name: 'gamma', role: 'admin', historyMode: 'feed', path: path.join(tmpRoot, 'gamma') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.code).toBe('PROJECT_PATH_INVALID');
  });

  it('refuses a path inside the engine install folder', async () => {
    const r = await registerProject(
      configPath,
      { name: 'gamma', role: 'admin', historyMode: 'feed', path: 'engine/gamma' },
      { engineRoot: path.join(tmpRoot, 'engine') },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.code).toBe('PROJECT_PATH_INVALID');
    expect(existsSync(path.join(tmpRoot, 'engine'))).toBe(false);
  });

  it('confirms an operator entry outside the instance folder when no path is passed', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'maad-register-outside-'));
    try {
      const entry = ['  - name: legacy', `    path: ${outside.replace(/\\/g, '/')}`, '    role: admin', '    history_mode: feed', ''].join('\n');
      await writeFile(configPath, BASE_YAML + entry, 'utf8');
      const r = await registerProject(configPath, { name: 'legacy', role: 'admin', historyMode: 'feed' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.registered).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('refuses an existing folder whose _registry links outside', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'maad-register-link-'));
    try {
      await mkdir(path.join(tmpRoot, 'linked'));
      const { symlink } = await import('node:fs/promises');
      await symlink(outside, path.join(tmpRoot, 'linked', '_registry'), process.platform === 'win32' ? 'junction' : 'dir');
      const r = await registerProject(configPath, { name: 'linked', role: 'admin', historyMode: 'feed' });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors[0]?.code).toBe('PROJECT_PATH_INVALID');
      expect(existsSync(path.join(outside, 'object_types.yaml'))).toBe(false);
      expect(await readFile(configPath, 'utf8')).toBe(BASE_YAML);
    } finally {
      await rm(outside, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('refuses a bad name', async () => {
    const r = await registerProject(configPath, { name: 'Bad Name', role: 'admin', historyMode: 'feed' });
    expect(r.ok).toBe(false);
  });

  it('serializes concurrent registrations so none is lost', async () => {
    const names = ['p1', 'p2', 'p3', 'p4', 'p5'];
    const results = await Promise.all(names.map(name => registerProject(configPath, { name, role: 'admin', historyMode: 'feed' })));
    expect(results.every(r => r.ok)).toBe(true);
    const loaded = await loadInstance(configPath);
    if (!loaded.ok) throw new Error('load');
    expect(loaded.value.projects.map(p => p.name).sort()).toEqual(['alpha', ...names].sort());
  });

  it('falls back to a full rewrite when projects is not the last block', async () => {
    await writeFile(configPath, 'projects: [{ name: alpha, path: alpha, role: admin, history_mode: feed }]\nname: register-test\n', 'utf8');
    const r = await registerProject(configPath, { name: 'beta', role: 'admin', historyMode: 'feed' });
    expect(r.ok).toBe(true);
    const loaded = await loadInstance(configPath);
    if (!loaded.ok) throw new Error('load');
    expect(loaded.value.name).toBe('register-test');
    expect(loaded.value.projects.map(p => p.name)).toEqual(['alpha', 'beta']);
  });

  it('refuses to write when the current file is invalid', async () => {
    await writeFile(configPath, 'name: register-test\nprojects:\n  - name: alpha\n', 'utf8');
    const r = await registerProject(configPath, { name: 'beta', role: 'admin', historyMode: 'feed' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.code).toBe('PROJECT_REGISTER_FAILED');
    expect(existsSync(path.join(tmpRoot, 'beta'))).toBe(false);
  });
});

describe('maad_register_project tool', () => {
  type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;
  let fx: TokenFixture;
  let ctx: InstanceCtx;
  let handlers: Map<string, Handler>;

  beforeEach(async () => {
    fx = await makeTokenFixture({ role: 'admin', projects: [{ name: '*' }] });
    const loaded = await loadInstance(configPath);
    if (!loaded.ok) throw new Error('load');
    const instance = loaded.value;
    ctx = { instance, pool: new EnginePool(instance), sessions: new SessionRegistry(instance), tokens: fx.store } as InstanceCtx;
    handlers = new Map();
    registerReload({ registerTool: (name: string, _d: unknown, h: Handler) => { handlers.set(name, h); } } as never, ctx);
  });

  afterEach(async () => {
    await ctx.pool.closeAll();
    await fx.cleanup();
  });

  function bind(sessionId: string, role: 'reader' | 'writer' | 'admin', token?: TokenRecord): void {
    const state = ctx.sessions.create(sessionId);
    state.mode = 'single';
    state.activeProject = 'alpha';
    state.effectiveRoles.set('alpha', role);
    if (token) state.token = token;
  }

  async function call(sessionId: string, args: Record<string, unknown>) {
    const res = await handlers.get('maad_register_project')!(args, { sessionId });
    return JSON.parse(res.content[0]!.text) as { ok: boolean; data?: Record<string, unknown>; errors?: Array<{ code: string }> };
  }

  it('registers, reloads, and serves the new project', async () => {
    bind('s-root', 'admin', fx.record);
    const res = await call('s-root', { name: 'beta', role: 'admin', historyMode: 'audit' });
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ name: 'beta', registered: true, reloaded: true, gitInitialized: true });
    expect(ctx.instance.projects.map(p => p.name)).toContain('beta');

    // The scaffold is enough for the engine to open the project and write to it.
    const engine = await ctx.pool.get('beta');
    expect(engine.ok).toBe(true);
    if (!engine.ok) return;

    const again = await call('s-root', { name: 'beta', role: 'admin', historyMode: 'audit' });
    expect(again.ok).toBe(true);
    expect(again.data).toMatchObject({ registered: false, reloaded: false });
  });

  it('concurrent tool calls all register and reload without a spurious error', async () => {
    bind('s-root', 'admin', fx.record);
    const names = ['c1', 'c2', 'c3'];
    const results = await Promise.all(names.map(name => call('s-root', { name, role: 'admin', historyMode: 'feed' })));
    expect(results.map(r => r.ok)).toEqual([true, true, true]);
    for (const name of names) expect(ctx.instance.projects.map(p => p.name)).toContain(name);
  });

  it('refuses a token without an admin wildcard grant', async () => {
    const scoped = await fx.store.issue({ role: 'admin', projects: [{ name: 'alpha' }] });
    if (!scoped.ok) throw new Error('issue');
    bind('s-scoped', 'admin', scoped.value.record);
    const res = await call('s-scoped', { name: 'beta', role: 'admin', historyMode: 'feed' });
    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.code).toBe('INSUFFICIENT_ROLE');
    expect(await readFile(configPath, 'utf8')).toBe(BASE_YAML);
  });

  it('refuses a non-admin binding and an unbound session', async () => {
    bind('s-writer', 'writer', fx.record);
    expect((await call('s-writer', { name: 'beta', role: 'admin', historyMode: 'feed' })).errors?.[0]?.code).toBe('INSUFFICIENT_ROLE');
    ctx.sessions.create('s-unbound');
    expect((await call('s-unbound', { name: 'beta', role: 'admin', historyMode: 'feed' })).errors?.[0]?.code).toBe('SESSION_UNBOUND');
    expect(await readFile(configPath, 'utf8')).toBe(BASE_YAML);
  });
});
