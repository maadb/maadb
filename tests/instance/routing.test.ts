// ============================================================================
// End-to-end routing tests — withEngine + SessionRegistry + EnginePool
// Exercises the full routing path without needing an MCP transport.
// ============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EnginePool } from '../../src/instance/pool.js';
import { SessionRegistry, __resetStdioSessionId } from '../../src/instance/session.js';
import type { InstanceConfig } from '../../src/instance/config.js';
import type { InstanceCtx } from '../../src/mcp/ctx.js';
import { withEngine } from '../../src/mcp/with-session.js';

const createdDirs: string[] = [];

function makeTempDir(label = 'proj'): string {
  const dir = mkdtempSync(path.join(tmpdir(), `maad-routing-${label}-`));
  createdDirs.push(dir);
  return dir;
}

function makeCtx(projects: Array<{ name: string; path: string; role?: 'reader' | 'writer' | 'admin' }>): InstanceCtx {
  const instance: InstanceConfig = {
    name: 'rtest',
    source: 'file',
    projects: projects.map(p => ({ name: p.name, path: p.path, role: p.role ?? 'admin' })),
  };
  return { instance, pool: new EnginePool(instance), sessions: new SessionRegistry(instance) };
}

function syntheticCtx(projectPath: string, role: 'reader' | 'writer' | 'admin' = 'admin'): InstanceCtx {
  const instance: InstanceConfig = {
    name: 'legacy-rtest',
    source: 'synthetic',
    projects: [{ name: 'default', path: projectPath, role }],
  };
  return { instance, pool: new EnginePool(instance), sessions: new SessionRegistry(instance) };
}

function parseResponse(resp: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(resp.content[0].text);
}

async function call(ctx: InstanceCtx, sid: string, toolName: string, args: Record<string, unknown>): Promise<any> {
  const resp = await withEngine(ctx, { sessionId: sid }, toolName, args, ({ engine, projectName }) => {
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { project: projectName, summary: engine.summary() } }) }] };
  });
  return parseResponse(resp);
}

afterEach(async () => {
  __resetStdioSessionId();
  await new Promise(r => setTimeout(r, 50));
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* windows */ }
  }
});

describe('routing — single-mode binding', () => {
  it('routes every call to the bound project', async () => {
    const dirA = makeTempDir('a');
    const dirB = makeTempDir('b');
    const ctx = makeCtx([{ name: 'alpha', path: dirA }, { name: 'beta', path: dirB }]);

    ctx.sessions.create('sid-1');
    expect(ctx.sessions.bindSingle('sid-1', 'alpha').ok).toBe(true);

    const result = await call(ctx, 'sid-1', 'maad_summary', {});
    expect(result.ok).toBe(true);
    expect(result.data.project).toBe('alpha');

    await ctx.pool.closeAll();
  });

  it('ignores `project=` arg in single mode (lock is absolute)', async () => {
    const dirA = makeTempDir('a');
    const dirB = makeTempDir('b');
    const ctx = makeCtx([{ name: 'alpha', path: dirA }, { name: 'beta', path: dirB }]);

    ctx.sessions.create('sid-1');
    ctx.sessions.bindSingle('sid-1', 'alpha');

    const result = await call(ctx, 'sid-1', 'maad_summary', { project: 'beta' });
    expect(result.data.project).toBe('alpha');

    await ctx.pool.closeAll();
  });
});

describe('routing — multi-mode binding', () => {
  it('requires `project=` on every call', async () => {
    const dirA = makeTempDir('a');
    const dirB = makeTempDir('b');
    const ctx = makeCtx([{ name: 'alpha', path: dirA }, { name: 'beta', path: dirB }]);

    ctx.sessions.create('sid-1');
    ctx.sessions.bindMulti('sid-1', ['alpha', 'beta']);

    const noArg = await call(ctx, 'sid-1', 'maad_summary', {});
    expect(noArg.ok).toBe(false);
    expect(noArg.errors[0].code).toBe('PROJECT_REQUIRED');

    const withArg = await call(ctx, 'sid-1', 'maad_summary', { project: 'beta' });
    expect(withArg.ok).toBe(true);
    expect(withArg.data.project).toBe('beta');

    await ctx.pool.closeAll();
  });

  it('rejects calls to projects outside the whitelist', async () => {
    const dirA = makeTempDir('a');
    const dirB = makeTempDir('b');
    const dirC = makeTempDir('c');
    const ctx = makeCtx([
      { name: 'alpha', path: dirA },
      { name: 'beta', path: dirB },
      { name: 'gamma', path: dirC },
    ]);

    ctx.sessions.create('sid-1');
    ctx.sessions.bindMulti('sid-1', ['alpha', 'beta']);

    const denied = await call(ctx, 'sid-1', 'maad_summary', { project: 'gamma' });
    expect(denied.ok).toBe(false);
    expect(denied.errors[0].code).toBe('PROJECT_NOT_WHITELISTED');

    await ctx.pool.closeAll();
  });
});

describe('routing — unbound sessions', () => {
  it('blocks tool calls until a project is bound (real instance)', async () => {
    const dir = makeTempDir();
    const ctx = makeCtx([{ name: 'alpha', path: dir }]);

    const result = await call(ctx, 'sid-1', 'maad_summary', {});
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('SESSION_UNBOUND');

    await ctx.pool.closeAll();
  });

  it('auto-binds the session in synthetic (legacy) mode', async () => {
    const dir = makeTempDir();
    const ctx = syntheticCtx(dir, 'admin');

    const result = await call(ctx, 'sid-1', 'maad_summary', {});
    expect(result.ok).toBe(true);
    expect(result.data.project).toBe('default');

    const state = ctx.sessions.get('sid-1')!;
    expect(state.mode).toBe('single');
    expect(state.activeProject).toBe('default');

    await ctx.pool.closeAll();
  });
});

describe('routing — role enforcement', () => {
  it('denies writer tools when session is bound as reader', async () => {
    const dir = makeTempDir();
    const ctx = makeCtx([{ name: 'alpha', path: dir, role: 'admin' }]);

    ctx.sessions.create('sid-1');
    ctx.sessions.bindSingle('sid-1', 'alpha', { as: 'reader' });

    const denied = await call(ctx, 'sid-1', 'maad_create', {});
    expect(denied.ok).toBe(false);
    expect(denied.errors[0].code).toBe('INSUFFICIENT_ROLE');

    // Reader tool still works
    const allowed = await call(ctx, 'sid-1', 'maad_summary', {});
    expect(allowed.ok).toBe(true);

    await ctx.pool.closeAll();
  });

  it('denies admin tools when project role is writer', async () => {
    const dir = makeTempDir();
    const ctx = makeCtx([{ name: 'alpha', path: dir, role: 'writer' }]);

    ctx.sessions.create('sid-1');
    ctx.sessions.bindSingle('sid-1', 'alpha');

    const denied = await call(ctx, 'sid-1', 'maad_delete', {});
    expect(denied.ok).toBe(false);
    expect(denied.errors[0].code).toBe('INSUFFICIENT_ROLE');

    await ctx.pool.closeAll();
  });
});

describe('routing — empty-project boot via pool', () => {
  it('initializes an empty project on first use', async () => {
    const dir = makeTempDir('empty');
    const ctx = makeCtx([{ name: 'alpha', path: dir }]);

    ctx.sessions.create('sid-1');
    ctx.sessions.bindSingle('sid-1', 'alpha');

    const result = await call(ctx, 'sid-1', 'maad_summary', {});
    expect(result.ok).toBe(true);

    // Pool initialized the empty project — registry and skills materialized
    expect(existsSync(path.join(dir, '_registry', 'object_types.yaml'))).toBe(true);
    expect(existsSync(path.join(dir, '_skills', 'architect-core.md'))).toBe(true);

    await ctx.pool.closeAll();
  });
});

describe('routing — per-session isolation', () => {
  it('two sessions bind to different projects and never cross-talk', async () => {
    const dirA = makeTempDir('a');
    const dirB = makeTempDir('b');
    const ctx = makeCtx([{ name: 'alpha', path: dirA }, { name: 'beta', path: dirB }]);

    ctx.sessions.create('sid-a');
    ctx.sessions.create('sid-b');
    ctx.sessions.bindSingle('sid-a', 'alpha');
    ctx.sessions.bindSingle('sid-b', 'beta');

    const aResult = await call(ctx, 'sid-a', 'maad_summary', {});
    const bResult = await call(ctx, 'sid-b', 'maad_summary', {});

    expect(aResult.data.project).toBe('alpha');
    expect(bResult.data.project).toBe('beta');

    await ctx.pool.closeAll();
  });
});
