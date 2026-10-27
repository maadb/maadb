// ============================================================================
// The session role gate fails closed: an engine-bound tool with an operation
// kind but no role assignment is refused for every role, including admin, and
// its handler never runs. No shipped tool is in that state (see the
// completeness test in roles.test.ts), so the roles lookup is stubbed here.
// ============================================================================

import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

vi.mock('../../src/mcp/roles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/mcp/roles.js')>();
  return {
    ...actual,
    getMinRoleForTool: (name: string) => (name === 'maad_summary' ? null : actual.getMinRoleForTool(name)),
  };
});

const { EnginePool } = await import('../../src/instance/pool.js');
const { SessionRegistry, __resetStdioSessionId } = await import('../../src/instance/session.js');
const { withEngine } = await import('../../src/mcp/with-session.js');
import type { InstanceConfig } from '../../src/instance/config.js';

const dirs: string[] = [];
afterEach(() => {
  __resetStdioSessionId();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('role gate — fails closed', () => {
  it('refuses a classified tool that has no role assignment, even for admin', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'maad-role-gate-'));
    dirs.push(dir);
    const instance: InstanceConfig = { name: 'gate', source: 'file', projects: [{ name: 'alpha', path: dir, role: 'admin' }] };
    const ctx = { instance, pool: new EnginePool(instance), sessions: new SessionRegistry(instance) };
    ctx.sessions.create('sid-1');
    expect(ctx.sessions.bindSingle('sid-1', 'alpha').ok).toBe(true);

    let ran = false;
    const resp = await withEngine(ctx, { sessionId: 'sid-1' }, 'maad_summary', {}, () => {
      ran = true;
      return { content: [{ type: 'text', text: '{"ok":true}' }] };
    });
    const result = JSON.parse((resp.content[0] as { text: string }).text);
    expect(ran).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.errors[0].code).toBe('INSUFFICIENT_ROLE');

    await ctx.pool.closeAll();
  });
});
