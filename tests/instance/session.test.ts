// ============================================================================
// SessionRegistry tests
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionRegistry, resolveSessionId, __resetStdioSessionId } from '../../src/instance/session.js';
import type { InstanceConfig } from '../../src/instance/config.js';

function makeInstance(): InstanceConfig {
  return {
    name: 'test',
    source: 'file',
    projects: [
      { name: 'alpha', path: '/a', role: 'admin' },
      { name: 'beta', path: '/b', role: 'writer' },
      { name: 'gamma', path: '/c', role: 'reader' },
    ],
  };
}

describe('SessionRegistry', () => {
  let reg: SessionRegistry;

  beforeEach(() => {
    reg = new SessionRegistry(makeInstance());
  });

  it('creates unbound sessions', () => {
    const s = reg.create('sid-1');
    expect(s.sessionId).toBe('sid-1');
    expect(s.mode).toBeNull();
    expect(s.effectiveRoles.size).toBe(0);
    expect(reg.size()).toBe(1);
  });

  it('create is idempotent', () => {
    const a = reg.create('sid-1');
    const b = reg.create('sid-1');
    expect(a).toBe(b);
    expect(reg.size()).toBe(1);
  });

  it('destroy removes a session', () => {
    reg.create('sid-1');
    reg.destroy('sid-1');
    expect(reg.size()).toBe(0);
    expect(reg.get('sid-1')).toBeUndefined();
  });

  describe('bindSingle', () => {
    it('binds to a known project with configured role', () => {
      reg.create('sid-1');
      const result = reg.bindSingle('sid-1', 'alpha');
      expect(result.ok).toBe(true);
      const s = reg.get('sid-1')!;
      expect(s.mode).toBe('single');
      expect(s.activeProject).toBe('alpha');
      expect(s.effectiveRoles.get('alpha')).toBe('admin');
    });

    it('applies role downgrade via as=', () => {
      reg.create('sid-1');
      const result = reg.bindSingle('sid-1', 'alpha', { as: 'reader' });
      expect(result.ok).toBe(true);
      expect(reg.get('sid-1')!.effectiveRoles.get('alpha')).toBe('reader');
    });

    it('rejects role upgrade beyond configured role', () => {
      reg.create('sid-1');
      const result = reg.bindSingle('sid-1', 'gamma', { as: 'admin' });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors[0].code).toBe('ROLE_UPGRADE_DENIED');
    });

    it('rejects unknown project', () => {
      reg.create('sid-1');
      const result = reg.bindSingle('sid-1', 'ghost');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors[0].code).toBe('PROJECT_UNKNOWN');
    });

    it('rejects rebind of an already-bound session', () => {
      reg.create('sid-1');
      expect(reg.bindSingle('sid-1', 'alpha').ok).toBe(true);
      const second = reg.bindSingle('sid-1', 'beta');
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.errors[0].code).toBe('SESSION_ALREADY_BOUND');
    });

    it('rejects unknown session', () => {
      const result = reg.bindSingle('never-created', 'alpha');
      expect(result.ok).toBe(false);
    });

    it('tags bindingSource=client_tool by default', () => {
      reg.create('sid-1');
      expect(reg.bindSingle('sid-1', 'alpha').ok).toBe(true);
      expect(reg.get('sid-1')!.bindingSource).toBe('client_tool');
    });

    it('tags bindingSource=gateway_pin when source option is passed', () => {
      reg.create('sid-1');
      expect(reg.bindSingle('sid-1', 'alpha', { source: 'gateway_pin' }).ok).toBe(true);
      expect(reg.get('sid-1')!.bindingSource).toBe('gateway_pin');
    });

    it('rejects rebind of a pinned session with SESSION_PINNED (precedes SESSION_ALREADY_BOUND)', () => {
      reg.create('sid-1');
      expect(reg.bindSingle('sid-1', 'alpha', { source: 'gateway_pin' }).ok).toBe(true);
      const second = reg.bindSingle('sid-1', 'beta');
      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.errors[0].code).toBe('SESSION_PINNED');
      expect(second.errors[0].message).toContain("'alpha'");
      expect(second.errors[0].message).toContain('X-Maad-Pin-Project');
    });
  });

  describe('bindMulti', () => {
    it('binds to a whitelist with per-project effective roles', () => {
      reg.create('sid-1');
      const result = reg.bindMulti('sid-1', ['alpha', 'beta', 'gamma']);
      expect(result.ok).toBe(true);
      const s = reg.get('sid-1')!;
      expect(s.mode).toBe('multi');
      expect(s.whitelist).toEqual(['alpha', 'beta', 'gamma']);
      expect(s.effectiveRoles.get('alpha')).toBe('admin');
      expect(s.effectiveRoles.get('beta')).toBe('writer');
      expect(s.effectiveRoles.get('gamma')).toBe('reader');
    });

    it('applies as= downgrade to every project', () => {
      reg.create('sid-1');
      const result = reg.bindMulti('sid-1', ['alpha', 'beta'], { as: 'reader' });
      expect(result.ok).toBe(true);
      const s = reg.get('sid-1')!;
      expect(s.effectiveRoles.get('alpha')).toBe('reader');
      expect(s.effectiveRoles.get('beta')).toBe('reader');
    });

    it('rejects if any project in the list would be upgraded by as=', () => {
      reg.create('sid-1');
      const result = reg.bindMulti('sid-1', ['alpha', 'gamma'], { as: 'writer' });
      expect(result.ok).toBe(false);
    });

    it('rejects empty project list', () => {
      reg.create('sid-1');
      const result = reg.bindMulti('sid-1', []);
      expect(result.ok).toBe(false);
    });

    it('rejects if any project is unknown', () => {
      reg.create('sid-1');
      const result = reg.bindMulti('sid-1', ['alpha', 'ghost']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors[0].code).toBe('PROJECT_UNKNOWN');
    });

    it('rejects bindMulti on a pinned session with SESSION_PINNED', () => {
      reg.create('sid-1');
      expect(reg.bindSingle('sid-1', 'alpha', { source: 'gateway_pin' }).ok).toBe(true);
      const result = reg.bindMulti('sid-1', ['beta', 'gamma']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors[0].code).toBe('SESSION_PINNED');
    });
  });
});

describe('resolveSessionId', () => {
  beforeEach(() => __resetStdioSessionId());

  it('reads sessionId directly from extra when transport supplies it', () => {
    const id = resolveSessionId({ sessionId: 'http-direct' });
    expect(id).toBe('http-direct');
  });

  it('reads sessionId from _meta when present', () => {
    const id = resolveSessionId({ _meta: { sessionId: 'http-abc' } });
    expect(id).toBe('http-abc');
  });

  it('reads sessionId from params._meta when present', () => {
    const id = resolveSessionId({ params: { _meta: { sessionId: 'http-xyz' } } });
    expect(id).toBe('http-xyz');
  });

  it('falls back to a stable stdio session ID when no meta', () => {
    const a = resolveSessionId({});
    const b = resolveSessionId({ params: {} });
    expect(a).toBe(b);
    expect(a.startsWith('stdio-')).toBe(true);
  });

  it('returns a new stdio id after reset', () => {
    const a = resolveSessionId({});
    __resetStdioSessionId();
    const b = resolveSessionId({});
    expect(a).not.toBe(b);
  });
});
