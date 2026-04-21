// ============================================================================
// 0.6.11 — Live notifications tests (fup-2026-035)
//
// Unit-tests the fan-out contract: registerNotifier / unregisterNotifier /
// notifyWrite + subscription filter matching against SessionState. Doesn't
// spin up a full MCP server — the transport-level smoke test that per-session
// notifiers actually reach MCP clients is deferred to an e2e pass; here we
// pin down the routing logic that drives the feature.
//
// Durability gate is enforced by the CALLER (write tool handlers) rather
// than by notifyWrite itself, so these tests exercise the match matrix —
// docTypes allowlist, project filter, single-mode default, multi-mode
// default, empty subscription (no subscription = no emit), zero-overhead
// path (no notifiers registered = no iteration).
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionRegistry } from '../../src/instance/session.js';
import { EnginePool } from '../../src/instance/pool.js';
import type { InstanceConfig } from '../../src/instance/config.js';
import type { InstanceCtx } from '../../src/mcp/ctx.js';
import {
  notifyWrite,
  registerNotifier,
  unregisterNotifier,
  notifierCount,
  __resetNotifiers,
  type ChangeEvent,
} from '../../src/mcp/notifications.js';

function makeInstance(projects: string[]): InstanceConfig {
  return {
    name: 'test-notify',
    source: 'file',
    projects: projects.map(n => ({ name: n, path: `/unused/${n}`, role: 'admin' as const })),
  };
}

function makeCtx(projects: string[]): InstanceCtx {
  const instance = makeInstance(projects);
  return {
    instance,
    pool: new EnginePool(instance),
    sessions: new SessionRegistry(instance),
  };
}

function makeEvent(overrides: Partial<ChangeEvent> = {}): ChangeEvent {
  return {
    action: 'create',
    docId: 'doc-1',
    docType: 'note',
    project: 'alpha',
    updatedAt: '2026-04-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('Live notifications — registry + filter matching', () => {
  beforeEach(() => {
    __resetNotifiers();
  });

  it('zero-overhead fast path: no notifiers registered → notifyWrite returns without iterating', async () => {
    const ctx = makeCtx(['alpha']);
    // Create a session with a subscription — the iteration SHOULD skip because
    // no notifiers are registered (the fast path short-circuits before the
    // sessions snapshot even runs).
    ctx.sessions.create('sess-orphan');
    ctx.sessions.bindSingle('sess-orphan', 'alpha');
    const state = ctx.sessions.get('sess-orphan')!;
    state.subscription = { docTypes: null, project: null, createdAt: new Date() };

    let delivered = 0;
    // Deliberately do NOT register a notifier.
    await notifyWrite(ctx, makeEvent());
    expect(delivered).toBe(0);
    expect(notifierCount()).toBe(0);
  });

  it('registers a notifier, fires on matching event, unregister removes it', async () => {
    const ctx = makeCtx(['alpha']);
    ctx.sessions.create('sess-1');
    ctx.sessions.bindSingle('sess-1', 'alpha');
    const state = ctx.sessions.get('sess-1')!;
    state.subscription = { docTypes: null, project: null, createdAt: new Date() };

    const delivered: ChangeEvent[] = [];
    registerNotifier('sess-1', async (event) => { delivered.push(event); });
    expect(notifierCount()).toBe(1);

    await notifyWrite(ctx, makeEvent({ docId: 'doc-a' }));
    expect(delivered.length).toBe(1);
    expect(delivered[0]?.docId).toBe('doc-a');

    unregisterNotifier('sess-1');
    expect(notifierCount()).toBe(0);

    await notifyWrite(ctx, makeEvent({ docId: 'doc-b' }));
    expect(delivered.length).toBe(1); // no new delivery
  });

  it('session without subscription does not receive notifications', async () => {
    const ctx = makeCtx(['alpha']);
    ctx.sessions.create('sess-unsubbed');
    ctx.sessions.bindSingle('sess-unsubbed', 'alpha');
    // No subscription set.

    const delivered: ChangeEvent[] = [];
    registerNotifier('sess-unsubbed', async (event) => { delivered.push(event); });

    await notifyWrite(ctx, makeEvent());
    expect(delivered.length).toBe(0);
  });

  it('docTypes allowlist filters: match hit', async () => {
    const ctx = makeCtx(['alpha']);
    ctx.sessions.create('sess-filtered');
    ctx.sessions.bindSingle('sess-filtered', 'alpha');
    const state = ctx.sessions.get('sess-filtered')!;
    state.subscription = { docTypes: ['note', 'client'], project: null, createdAt: new Date() };

    const delivered: ChangeEvent[] = [];
    registerNotifier('sess-filtered', async (event) => { delivered.push(event); });

    await notifyWrite(ctx, makeEvent({ docType: 'note' }));
    expect(delivered.length).toBe(1);
  });

  it('docTypes allowlist filters: miss', async () => {
    const ctx = makeCtx(['alpha']);
    ctx.sessions.create('sess-filtered');
    ctx.sessions.bindSingle('sess-filtered', 'alpha');
    const state = ctx.sessions.get('sess-filtered')!;
    state.subscription = { docTypes: ['client'], project: null, createdAt: new Date() };

    const delivered: ChangeEvent[] = [];
    registerNotifier('sess-filtered', async (event) => { delivered.push(event); });

    await notifyWrite(ctx, makeEvent({ docType: 'note' })); // note not in allowlist
    expect(delivered.length).toBe(0);
  });

  it('single-mode session with null project → defaults to activeProject', async () => {
    const ctx = makeCtx(['alpha', 'beta']);
    ctx.sessions.create('sess-single');
    ctx.sessions.bindSingle('sess-single', 'alpha');
    const state = ctx.sessions.get('sess-single')!;
    state.subscription = { docTypes: null, project: null, createdAt: new Date() };

    const delivered: ChangeEvent[] = [];
    registerNotifier('sess-single', async (event) => { delivered.push(event); });

    await notifyWrite(ctx, makeEvent({ project: 'alpha' }));
    expect(delivered.length).toBe(1);

    await notifyWrite(ctx, makeEvent({ project: 'beta', docId: 'doc-beta' }));
    expect(delivered.length).toBe(1); // beta event doesn't reach single-alpha subscriber
  });

  it('multi-mode session with null project → matches any whitelisted project', async () => {
    const ctx = makeCtx(['alpha', 'beta', 'gamma']);
    ctx.sessions.create('sess-multi');
    ctx.sessions.bindMulti('sess-multi', ['alpha', 'beta']);
    const state = ctx.sessions.get('sess-multi')!;
    state.subscription = { docTypes: null, project: null, createdAt: new Date() };

    const delivered: ChangeEvent[] = [];
    registerNotifier('sess-multi', async (event) => { delivered.push(event); });

    await notifyWrite(ctx, makeEvent({ project: 'alpha' }));
    await notifyWrite(ctx, makeEvent({ project: 'beta', docId: 'doc-b' }));
    expect(delivered.length).toBe(2);

    await notifyWrite(ctx, makeEvent({ project: 'gamma', docId: 'doc-c' })); // not in whitelist
    expect(delivered.length).toBe(2);
  });

  it('explicit project filter overrides session default scope', async () => {
    const ctx = makeCtx(['alpha', 'beta']);
    ctx.sessions.create('sess-explicit');
    ctx.sessions.bindMulti('sess-explicit', ['alpha', 'beta']);
    const state = ctx.sessions.get('sess-explicit')!;
    // Explicit project=alpha — beta events should be ignored even though
    // multi-mode session whitelists both.
    state.subscription = { docTypes: null, project: 'alpha', createdAt: new Date() };

    const delivered: ChangeEvent[] = [];
    registerNotifier('sess-explicit', async (event) => { delivered.push(event); });

    await notifyWrite(ctx, makeEvent({ project: 'alpha' }));
    expect(delivered.length).toBe(1);

    await notifyWrite(ctx, makeEvent({ project: 'beta', docId: 'doc-b' }));
    expect(delivered.length).toBe(1); // explicit filter rejects beta
  });

  it('notifier throws → error logged, write continues (does not propagate)', async () => {
    const ctx = makeCtx(['alpha']);
    ctx.sessions.create('sess-broken');
    ctx.sessions.bindSingle('sess-broken', 'alpha');
    const state = ctx.sessions.get('sess-broken')!;
    state.subscription = { docTypes: null, project: null, createdAt: new Date() };

    registerNotifier('sess-broken', async () => {
      throw new Error('transport dead');
    });

    // Must not throw — a broken notifier channel cannot kill the write path.
    await expect(notifyWrite(ctx, makeEvent())).resolves.toBeUndefined();
  });

  it('multiple sessions subscribing to the same event each get delivery', async () => {
    const ctx = makeCtx(['alpha']);
    ctx.sessions.create('sess-a');
    ctx.sessions.bindSingle('sess-a', 'alpha');
    ctx.sessions.get('sess-a')!.subscription = { docTypes: null, project: null, createdAt: new Date() };
    ctx.sessions.create('sess-b');
    ctx.sessions.bindSingle('sess-b', 'alpha');
    ctx.sessions.get('sess-b')!.subscription = { docTypes: null, project: null, createdAt: new Date() };

    let aCount = 0, bCount = 0;
    registerNotifier('sess-a', async () => { aCount++; });
    registerNotifier('sess-b', async () => { bCount++; });

    await notifyWrite(ctx, makeEvent());
    expect(aCount).toBe(1);
    expect(bCount).toBe(1);
  });

  it('SessionRegistry create handler fires on new session', () => {
    const ctx = makeCtx(['alpha']);
    const created: string[] = [];
    ctx.sessions.registerCreateHandler((sid) => { created.push(sid); });

    ctx.sessions.create('sess-created');
    expect(created).toEqual(['sess-created']);

    // Duplicate create is idempotent — no double-fire.
    ctx.sessions.create('sess-created');
    expect(created).toEqual(['sess-created']);
  });
});
