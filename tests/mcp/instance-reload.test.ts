// ============================================================================
// 0.6.9 — maad_instance_reload + SIGHUP acceptance tests
//
// Walks the 13 acceptance criteria from fup-2026-058:
//   #1  maad_instance_reload registered admin-only (role gate in handler)
//   #2  SIGHUP triggers same reload path, logs instance_reload_start/_complete
//   #3  Added project visible to maad_projects ≤500ms after reload
//   #4  Existing single-mode + gateway-pin sessions on unmodified projects untouched
//   #5  Removed project: subsequent X-Maad-Pin-Project → PIN_PROJECT_NOT_FOUND
//   #6  Removed project's single-mode sessions → SESSION_CANCELLED on next tool call
//   #7  Parse error leaves prior instance intact, returns INSTANCE_RELOAD_FAILED
//   #8  Concurrent reload attempts → INSTANCE_RELOAD_IN_PROGRESS
//   #9  Mutation of existing project path/role → INSTANCE_MUTATION_UNSUPPORTED, no partial apply
//   #10 Synthetic instances → INSTANCE_RELOAD_SYNTHETIC
//   #11 maad_health.instance block updates on success
//   #12 Audit event instance_reload with {projectsAdded, projectsRemoved, source}
//   #13 (this file)
//
// Plus bonus cases:
//   B1  No-op reload (identical yaml) — succeeds, added=0, removed=0
//   B2  Multi-mode whitelist pruning — session survives with remaining projects
//   B3  Multi-mode whitelist drained to empty → session cancelled
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EnginePool } from '../../src/instance/pool.js';
import { SessionRegistry } from '../../src/instance/session.js';
import { loadInstance, type InstanceConfig } from '../../src/instance/config.js';
import { performInstanceReload } from '../../src/mcp/instance-reload.js';
import { validatePinHeader } from '../../src/mcp/transport/pin.js';
import type { InstanceCtx } from '../../src/mcp/ctx.js';

function syntheticInstance(): InstanceConfig {
  return {
    name: 'legacy',
    source: 'synthetic',
    projects: [{ name: 'default', path: '/unused', role: 'admin' }],
  };
}

async function makeTempInstance(projects: Array<{ name: string; role?: string }>): Promise<{
  tmpRoot: string;
  configPath: string;
  projectPaths: Map<string, string>;
}> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'maad-reload-'));
  const projectPaths = new Map<string, string>();
  const yamlProjects = [];
  for (const p of projects) {
    const projectPath = path.join(tmpRoot, p.name);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(projectPath, { recursive: true });
    projectPaths.set(p.name, projectPath);
    yamlProjects.push(`  - name: ${p.name}\n    path: ${projectPath.replace(/\\/g, '/')}\n    role: ${p.role ?? 'admin'}`);
  }
  const configPath = path.join(tmpRoot, 'instance.yaml');
  await writeFile(configPath, `name: test-reload\nprojects:\n${yamlProjects.join('\n')}\n`, 'utf8');
  return { tmpRoot, configPath, projectPaths };
}

async function loadCtx(configPath: string): Promise<InstanceCtx> {
  const loaded = await loadInstance(configPath);
  if (!loaded.ok) throw new Error(`fixture load: ${loaded.errors.map(e => e.message).join('; ')}`);
  const instance = loaded.value;
  const pool = new EnginePool(instance);
  const sessions = new SessionRegistry(instance);
  return { instance, pool, sessions };
}

async function rewriteYaml(configPath: string, projects: Array<{ name: string; path: string; role?: string }>): Promise<void> {
  const yamlProjects = projects.map(p =>
    `  - name: ${p.name}\n    path: ${p.path.replace(/\\/g, '/')}\n    role: ${p.role ?? 'admin'}`
  ).join('\n');
  await writeFile(configPath, `name: test-reload\nprojects:\n${yamlProjects}\n`, 'utf8');
}

describe('maad_instance_reload + SIGHUP (fup-2026-058)', () => {
  let fixture: { tmpRoot: string; configPath: string; projectPaths: Map<string, string> } | null = null;

  afterEach(async () => {
    if (fixture) {
      await rm(fixture.tmpRoot, { recursive: true, force: true }).catch(() => {});
      fixture = null;
    }
  });

  // --- AC #10 Synthetic instances -------------------------------------------
  it('AC10: synthetic instance rejects with INSTANCE_RELOAD_SYNTHETIC', async () => {
    const instance = syntheticInstance();
    const pool = new EnginePool(instance);
    const sessions = new SessionRegistry(instance);
    const ctx: InstanceCtx = { instance, pool, sessions };

    const result = await performInstanceReload(ctx, 'tool');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe('INSTANCE_RELOAD_SYNTHETIC');
  });

  // --- AC #3 Added project visible after reload -----------------------------
  it('AC3: added project is visible in ctx.instance.projects after reload', async () => {
    fixture = await makeTempInstance([{ name: 'alpha' }]);
    const ctx = await loadCtx(fixture.configPath);
    expect(ctx.instance.projects.map(p => p.name)).toEqual(['alpha']);

    // Add "beta" via yaml rewrite + reload
    const { mkdir } = await import('node:fs/promises');
    const betaPath = path.join(fixture.tmpRoot, 'beta');
    await mkdir(betaPath, { recursive: true });
    await rewriteYaml(fixture.configPath, [
      { name: 'alpha', path: fixture.projectPaths.get('alpha')! },
      { name: 'beta', path: betaPath },
    ]);

    const result = await performInstanceReload(ctx, 'tool');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projectsAdded).toEqual(['beta']);
    expect(result.value.projectsRemoved).toEqual([]);
    expect(ctx.instance.projects.map(p => p.name).sort()).toEqual(['alpha', 'beta']);
  });

  // --- AC #4 Unmodified-project sessions unaffected + AC #6 removed-project sessions cancelled -
  it('AC4+6: single-mode on unmodified project survives; single-mode on removed project is cancelled', async () => {
    fixture = await makeTempInstance([{ name: 'keep' }, { name: 'drop' }]);
    const ctx = await loadCtx(fixture.configPath);

    // Bind two sessions — one to keep, one to drop
    ctx.sessions.create('sess-keep');
    const bindKeep = ctx.sessions.bindSingle('sess-keep', 'keep');
    expect(bindKeep.ok).toBe(true);

    ctx.sessions.create('sess-drop');
    const bindDrop = ctx.sessions.bindSingle('sess-drop', 'drop');
    expect(bindDrop.ok).toBe(true);

    // Remove 'drop' from yaml
    await rewriteYaml(fixture.configPath, [
      { name: 'keep', path: fixture.projectPaths.get('keep')! },
    ]);
    const result = await performInstanceReload(ctx, 'tool');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projectsRemoved).toEqual(['drop']);

    const keepSession = ctx.sessions.peek('sess-keep');
    const dropSession = ctx.sessions.peek('sess-drop');
    expect(keepSession?.cancelled).toBeFalsy();
    expect(dropSession?.cancelled).toBe(true);
    expect(result.value.sessionsCancelled).toContain('sess-drop');
  });

  // --- AC #5 Removed project no longer pinnable ----------------------------
  it('AC5: after removal, X-Maad-Pin-Project for removed project → PIN_PROJECT_NOT_FOUND', async () => {
    fixture = await makeTempInstance([{ name: 'alpha' }, { name: 'beta' }]);
    const ctx = await loadCtx(fixture.configPath);

    // Minimal IncomingMessage mock — pin validator only reads `headers`.
    const mockReq = (pinValue: string) => ({ headers: { 'x-maad-pin-project': pinValue } }) as unknown as import('node:http').IncomingMessage;

    // Baseline: pin validator accepts 'beta'
    const before = validatePinHeader(mockReq('beta'), ctx.instance);
    expect(before.status).toBe('valid');

    // Remove 'beta'
    await rewriteYaml(fixture.configPath, [
      { name: 'alpha', path: fixture.projectPaths.get('alpha')! },
    ]);
    await performInstanceReload(ctx, 'tool');

    const after = validatePinHeader(mockReq('beta'), ctx.instance);
    expect(after.status).toBe('rejected');
    if (after.status !== 'rejected') return;
    expect(after.code).toBe('PIN_PROJECT_NOT_FOUND');
  });

  // --- AC #7 Parse error leaves prior instance intact -----------------------
  it('AC7: parse error leaves prior instance intact, returns INSTANCE_RELOAD_FAILED', async () => {
    fixture = await makeTempInstance([{ name: 'alpha' }]);
    const ctx = await loadCtx(fixture.configPath);
    const projectsBefore = ctx.instance.projects.map(p => p.name);

    // Write garbage yaml
    await writeFile(fixture.configPath, 'this is: [not valid: yaml', 'utf8');

    const result = await performInstanceReload(ctx, 'tool');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe('INSTANCE_RELOAD_FAILED');
    // Instance unchanged
    expect(ctx.instance.projects.map(p => p.name)).toEqual(projectsBefore);
  });

  // --- AC #8 Concurrent reload → INSTANCE_RELOAD_IN_PROGRESS ---------------
  it('AC8: concurrent reload attempts reject with INSTANCE_RELOAD_IN_PROGRESS', async () => {
    fixture = await makeTempInstance([{ name: 'alpha' }]);
    const ctx = await loadCtx(fixture.configPath);

    // Kick off a reload; without awaiting, immediately call again
    const firstPromise = performInstanceReload(ctx, 'tool');
    const secondPromise = performInstanceReload(ctx, 'tool');

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    // One must succeed (the first-queued) and the other must be rejected as in-progress.
    const outcomes = [first, second];
    const succeeded = outcomes.filter(o => o.ok);
    const failed = outcomes.filter(o => !o.ok);
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(1);
    if (failed[0]?.ok) return;
    expect(failed[0]?.errors[0]?.code).toBe('INSTANCE_RELOAD_IN_PROGRESS');
  });

  // --- AC #9 Mutation rejected with no partial apply -----------------------
  it('AC9: path/role mutation → INSTANCE_MUTATION_UNSUPPORTED, no partial apply', async () => {
    fixture = await makeTempInstance([{ name: 'alpha', role: 'admin' }, { name: 'beta', role: 'admin' }]);
    const ctx = await loadCtx(fixture.configPath);
    const sizeBefore = ctx.instance.projects.length;

    // Mutate 'alpha' role from admin → reader
    await rewriteYaml(fixture.configPath, [
      { name: 'alpha', path: fixture.projectPaths.get('alpha')!, role: 'reader' },
      { name: 'beta', path: fixture.projectPaths.get('beta')! },
    ]);

    const result = await performInstanceReload(ctx, 'tool');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe('INSTANCE_MUTATION_UNSUPPORTED');
    // Instance untouched — no partial apply
    expect(ctx.instance.projects.length).toBe(sizeBefore);
    expect(ctx.instance.projects.find(p => p.name === 'alpha')?.role).toBe('admin');
  });

  // --- AC #11 maad_health.instance block updates ----------------------------
  it('AC11: pool.reloadStats() reflects counters after a reload', async () => {
    fixture = await makeTempInstance([{ name: 'alpha' }]);
    const ctx = await loadCtx(fixture.configPath);

    const statsBefore = ctx.pool.reloadStats();
    expect(statsBefore.reloadsAttempted).toBe(0);
    expect(statsBefore.reloadsSucceeded).toBe(0);
    expect(statsBefore.lastReloadAt).toBe(null);

    const { mkdir } = await import('node:fs/promises');
    const betaPath = path.join(fixture.tmpRoot, 'beta');
    await mkdir(betaPath, { recursive: true });
    await rewriteYaml(fixture.configPath, [
      { name: 'alpha', path: fixture.projectPaths.get('alpha')! },
      { name: 'beta', path: betaPath },
    ]);
    const result = await performInstanceReload(ctx, 'tool');
    expect(result.ok).toBe(true);

    const statsAfter = ctx.pool.reloadStats();
    expect(statsAfter.reloadsAttempted).toBe(1);
    expect(statsAfter.reloadsSucceeded).toBe(1);
    expect(statsAfter.reloadsFailed).toBe(0);
    expect(statsAfter.projectsAdded).toBe(1);
    expect(statsAfter.projectsRemoved).toBe(0);
    expect(statsAfter.lastReloadAt).toBeInstanceOf(Date);
  });

  // --- AC #12 Audit event emitted (structural presence) --------------------
  // Full audit-log capture is integration-test territory; here we assert the
  // success path returns the fields that drive the audit event shape.
  it('AC12: success result carries diff + source + counts for audit event', async () => {
    fixture = await makeTempInstance([{ name: 'alpha' }]);
    const ctx = await loadCtx(fixture.configPath);

    const { mkdir } = await import('node:fs/promises');
    const betaPath = path.join(fixture.tmpRoot, 'beta');
    await mkdir(betaPath, { recursive: true });
    await rewriteYaml(fixture.configPath, [
      { name: 'alpha', path: fixture.projectPaths.get('alpha')! },
      { name: 'beta', path: betaPath },
    ]);
    const result = await performInstanceReload(ctx, 'sighup');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.source).toBe('sighup');
    expect(result.value.projectsAdded).toEqual(['beta']);
    expect(result.value.projectsRemoved).toEqual([]);
    expect(typeof result.value.durationMs).toBe('number');
  });

  // --- AC #2 SIGHUP triggers same reload path (POSIX only) -----------------
  it.skipIf(process.platform === 'win32')('AC2: SIGHUP triggers performInstanceReload (POSIX)', async () => {
    fixture = await makeTempInstance([{ name: 'alpha' }]);
    const ctx = await loadCtx(fixture.configPath);

    const { installReloadSignalHandler, uninstallReloadSignalHandler } = await import('../../src/mcp/reload-signal.js');
    installReloadSignalHandler(ctx);
    try {
      const { mkdir } = await import('node:fs/promises');
      const betaPath = path.join(fixture.tmpRoot, 'beta');
      await mkdir(betaPath, { recursive: true });
      await rewriteYaml(fixture.configPath, [
        { name: 'alpha', path: fixture.projectPaths.get('alpha')! },
        { name: 'beta', path: betaPath },
      ]);

      process.emit('SIGHUP');
      // The SIGHUP handler dispatches asynchronously. Poll until the reload
      // lands rather than racing on a fixed sleep.
      for (let i = 0; i < 30; i++) {
        if (ctx.instance.projects.length === 2) break;
        await new Promise(r => setTimeout(r, 50));
      }
      expect(ctx.instance.projects.map(p => p.name).sort()).toEqual(['alpha', 'beta']);
    } finally {
      uninstallReloadSignalHandler();
    }
  });

  // --- Bonus B1: No-op reload ----------------------------------------------
  it('B1: identical yaml reload succeeds with zero added/removed', async () => {
    fixture = await makeTempInstance([{ name: 'alpha' }]);
    const ctx = await loadCtx(fixture.configPath);
    const result = await performInstanceReload(ctx, 'tool');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projectsAdded).toEqual([]);
    expect(result.value.projectsRemoved).toEqual([]);
    expect(ctx.pool.reloadStats().reloadsSucceeded).toBe(1);
  });

  // --- Bonus B2: Multi-mode whitelist pruned, session survives -------------
  it('B2: multi-mode session whose whitelist still has projects after pruning survives', async () => {
    fixture = await makeTempInstance([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    const ctx = await loadCtx(fixture.configPath);

    ctx.sessions.create('sess-multi');
    const bind = ctx.sessions.bindMulti('sess-multi', ['a', 'b', 'c']);
    expect(bind.ok).toBe(true);

    // Remove 'b'
    await rewriteYaml(fixture.configPath, [
      { name: 'a', path: fixture.projectPaths.get('a')! },
      { name: 'c', path: fixture.projectPaths.get('c')! },
    ]);
    const result = await performInstanceReload(ctx, 'tool');
    expect(result.ok).toBe(true);

    const session = ctx.sessions.peek('sess-multi');
    expect(session?.cancelled).toBeFalsy();
    expect(session?.whitelist?.sort()).toEqual(['a', 'c']);
    expect(session?.effectiveRoles.has('b')).toBe(false);
  });

  // --- Bonus B3: Multi-mode whitelist drained → session cancelled ----------
  it('B3: multi-mode session with only one project → cancelled when that project removed', async () => {
    fixture = await makeTempInstance([{ name: 'a' }, { name: 'only' }]);
    const ctx = await loadCtx(fixture.configPath);

    ctx.sessions.create('sess-single-multi');
    ctx.sessions.bindMulti('sess-single-multi', ['only']);

    await rewriteYaml(fixture.configPath, [
      { name: 'a', path: fixture.projectPaths.get('a')! },
    ]);
    await performInstanceReload(ctx, 'tool');

    const session = ctx.sessions.peek('sess-single-multi');
    expect(session?.cancelled).toBe(true);
    expect(session?.whitelist).toEqual([]);
  });

  // --- AC #1 Admin role gate is tested at the tool registration layer -----
  // The role check lives inside the `maad_instance_reload` handler in
  // src/mcp/tools/instance.ts — it rejects non-admin sessions with
  // INSUFFICIENT_ROLE before calling performInstanceReload. Integration via
  // a full MCP server is covered by the role-gated tool registration in
  // server.ts (only registered when legacyRole === 'admin'). A dedicated
  // handler unit test would require spinning up a full MCP server; the
  // structural guarantees are verified in roles.test.ts + kinds.test.ts.
});
