// ============================================================================
// Admin token tools are limited to the caller's own token scope.
//
// A token that is admin on one project must not be able to issue a token that
// reaches further than itself, nor see, revoke or rotate tokens outside its
// projects. Covers the pure scope rules and the real tool handlers.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EnginePool } from '../../src/instance/pool.js';
import { SessionRegistry } from '../../src/instance/session.js';
import type { InstanceConfig } from '../../src/instance/config.js';
import type { InstanceCtx } from '../../src/mcp/ctx.js';
import { register } from '../../src/mcp/tools/auth.js';
import { issueExceedsScope, withinCallerScope } from '../../src/auth/scope.js';
import type { TokenRecord } from '../../src/auth/types.js';
import { makeTokenFixture, type TokenFixture } from '../support/token-fixture.js';

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }> }>;

function instance(): InstanceConfig {
  return {
    name: 'scope-test',
    source: 'synthetic',
    projects: [
      { name: 'alpha', path: '/unused-a', role: 'admin' },
      { name: 'beta', path: '/unused-b', role: 'admin' },
    ],
  };
}

describe('token scope rules', () => {
  const alphaAdmin = { role: 'admin', projects: [{ name: 'alpha' }] } as const;
  const wildcardAdmin = { role: 'admin', projects: [{ name: '*' }] } as const;

  it('allows an issue inside the issuer scope', () => {
    expect(issueExceedsScope(alphaAdmin, { role: 'writer', projects: [{ name: 'alpha' }] })).toBeNull();
    expect(issueExceedsScope(wildcardAdmin, { role: 'admin', projects: [{ name: '*' }] })).toBeNull();
    expect(issueExceedsScope(wildcardAdmin, { role: 'admin', projects: [{ name: 'beta' }] })).toBeNull();
  });

  it('refuses a wildcard issue from a single-project token', () => {
    expect(issueExceedsScope(alphaAdmin, { role: 'admin', projects: [{ name: '*' }] })).toMatch(/wildcard/);
  });

  it('refuses a project the issuer does not reach', () => {
    expect(issueExceedsScope(alphaAdmin, { role: 'reader', projects: [{ name: 'beta' }] })).toMatch(/does not reach/);
  });

  it('refuses a role above what the issuer holds on that project', () => {
    const reducedAlpha = { role: 'admin', projects: [{ name: 'alpha', role: 'writer' }] } as const;
    expect(issueExceedsScope(reducedAlpha, { role: 'admin', projects: [{ name: 'alpha' }] })).toMatch(/holds "writer"/);
    expect(issueExceedsScope(reducedAlpha, { role: 'writer', projects: [{ name: 'alpha' }] })).toBeNull();
  });

  it('refuses a global role above the issuer global role', () => {
    const writerToken = { role: 'writer', projects: [{ name: '*' }] } as const;
    expect(issueExceedsScope(writerToken, { role: 'admin', projects: [{ name: 'alpha' }] })).toMatch(/cannot issue/);
  });

  it('lets a project-scoped admin act only on tokens inside its projects', () => {
    expect(withinCallerScope(alphaAdmin, { projects: [{ name: 'alpha' }] })).toBe(true);
    expect(withinCallerScope(alphaAdmin, { projects: [{ name: 'alpha' }, { name: 'beta' }] })).toBe(false);
    expect(withinCallerScope(alphaAdmin, { projects: [{ name: '*' }] })).toBe(false);
    expect(withinCallerScope(wildcardAdmin, { projects: [{ name: '*' }] })).toBe(true);
    expect(withinCallerScope(wildcardAdmin, { projects: [{ name: 'beta' }] })).toBe(true);
  });
});

describe('admin token tools enforce the caller scope', () => {
  let fx: TokenFixture;
  let handlers: Map<string, Handler>;
  let ctx: InstanceCtx;

  function callerSession(sessionId: string, token: TokenRecord, projects: string[]): void {
    const state = ctx.sessions.create(sessionId);
    state.mode = 'multi';
    state.whitelist = projects;
    for (const p of projects) state.effectiveRoles.set(p, 'admin');
    state.token = token;
  }

  async function call(tool: string, sessionId: string, args: Record<string, unknown> = {}) {
    const handler = handlers.get(tool);
    if (!handler) throw new Error(`tool not registered: ${tool}`);
    const res = await handler(args, { sessionId });
    return JSON.parse(res.content[0]!.text) as { ok: boolean; data?: Record<string, unknown>; errors?: Array<{ code: string; message: string }> };
  }

  async function issueDirect(role: 'reader' | 'writer' | 'admin', projects: Array<{ name: string }>): Promise<TokenRecord> {
    const out = await fx.store.issue({ role, projects });
    if (!out.ok) throw new Error('fixture issue failed');
    return out.value.record;
  }

  beforeEach(async () => {
    fx = await makeTokenFixture({ role: 'admin', projects: [{ name: '*' }] });
    const inst = instance();
    ctx = { instance: inst, pool: new EnginePool(inst), sessions: new SessionRegistry(inst), tokens: fx.store } as InstanceCtx;
    handlers = new Map();
    const fakeServer = {
      registerTool: (name: string, _def: unknown, handler: Handler) => { handlers.set(name, handler); },
    };
    register(fakeServer as never, ctx);
  });

  afterEach(async () => { await fx.cleanup(); });

  it('a single-project admin cannot issue a wildcard admin token', async () => {
    const alphaAdmin = await issueDirect('admin', [{ name: 'alpha' }]);
    callerSession('s-alpha', alphaAdmin, ['alpha']);
    const before = fx.store.list().length;

    const res = await call('maad_issue_token', 's-alpha', { role: 'admin', projects: [{ name: '*' }] });

    expect(res.ok).toBe(false);
    expect(res.errors?.[0]?.code).toBe('INSUFFICIENT_ROLE');
    expect(fx.store.list().length).toBe(before);
  });

  it('a single-project admin can still issue a token inside its own project', async () => {
    const alphaAdmin = await issueDirect('admin', [{ name: 'alpha' }]);
    callerSession('s-alpha', alphaAdmin, ['alpha']);

    const res = await call('maad_issue_token', 's-alpha', { role: 'writer', projects: [{ name: 'alpha' }] });

    expect(res.ok).toBe(true);
  });

  it('a wildcard admin can issue a wildcard token', async () => {
    callerSession('s-root', fx.record, ['alpha', 'beta']);

    const res = await call('maad_issue_token', 's-root', { role: 'admin', projects: [{ name: '*' }] });

    expect(res.ok).toBe(true);
  });

  it('list shows only tokens inside the caller scope', async () => {
    const alphaAdmin = await issueDirect('admin', [{ name: 'alpha' }]);
    const alphaReader = await issueDirect('reader', [{ name: 'alpha' }]);
    const betaWriter = await issueDirect('writer', [{ name: 'beta' }]);
    callerSession('s-alpha', alphaAdmin, ['alpha']);

    const res = await call('maad_list_tokens', 's-alpha');
    const ids = (res.data?.['tokens'] as Array<{ id: string }>).map(t => t.id);

    expect(ids).toContain(alphaAdmin.id);
    expect(ids).toContain(alphaReader.id);
    expect(ids).not.toContain(betaWriter.id);
    expect(ids).not.toContain(fx.record.id);
  });

  it('show, revoke and rotate treat an out-of-scope token as not found', async () => {
    const alphaAdmin = await issueDirect('admin', [{ name: 'alpha' }]);
    const betaWriter = await issueDirect('writer', [{ name: 'beta' }]);
    callerSession('s-alpha', alphaAdmin, ['alpha']);

    for (const tool of ['maad_show_token', 'maad_revoke_token', 'maad_rotate_token']) {
      const res = await call(tool, 's-alpha', { id: betaWriter.id });
      expect(res.ok, tool).toBe(false);
      expect(res.errors?.[0]?.code, tool).toBe('TOKEN_NOT_FOUND');
    }
    expect(fx.store.lookupById(betaWriter.id)?.revokedAt).toBeUndefined();
  });

  it('a project-scoped admin can revoke a token inside its own project', async () => {
    const alphaAdmin = await issueDirect('admin', [{ name: 'alpha' }]);
    const alphaReader = await issueDirect('reader', [{ name: 'alpha' }]);
    callerSession('s-alpha', alphaAdmin, ['alpha']);

    const res = await call('maad_revoke_token', 's-alpha', { id: alphaReader.id });

    expect(res.ok).toBe(true);
    expect(fx.store.lookupById(alphaReader.id)?.revokedAt).toBeDefined();
  });

  it('a wildcard admin can still manage any token', async () => {
    const betaWriter = await issueDirect('writer', [{ name: 'beta' }]);
    callerSession('s-root', fx.record, ['alpha', 'beta']);

    expect((await call('maad_show_token', 's-root', { id: betaWriter.id })).ok).toBe(true);
    expect((await call('maad_revoke_token', 's-root', { id: betaWriter.id })).ok).toBe(true);
  });

  it('refuses every tool for a session with no token', async () => {
    const state = ctx.sessions.create('s-none');
    state.mode = 'multi';
    state.effectiveRoles.set('alpha', 'admin');

    for (const [tool, args] of [
      ['maad_issue_token', { role: 'reader', projects: [{ name: 'alpha' }] }],
      ['maad_list_tokens', {}],
      ['maad_show_token', { id: fx.record.id }],
      ['maad_revoke_token', { id: fx.record.id }],
      ['maad_rotate_token', { id: fx.record.id }],
    ] as const) {
      const res = await call(tool, 's-none', args as Record<string, unknown>);
      expect(res.ok, tool).toBe(false);
      expect(res.errors?.[0]?.code, tool).toBe('INSUFFICIENT_ROLE');
    }
  });
});
