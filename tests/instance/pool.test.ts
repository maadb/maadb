// ============================================================================
// EnginePool tests — lazy init, caching, eviction, empty-project boot
// ============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EnginePool } from '../../src/instance/pool.js';
import type { InstanceConfig } from '../../src/instance/config.js';

const createdDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'maad-pool-'));
  createdDirs.push(dir);
  return dir;
}

function makeInstance(projects: Array<{ name: string; path: string; role?: 'reader' | 'writer' | 'admin' }>): InstanceConfig {
  return {
    name: 'test-instance',
    projects: projects.map(p => ({ name: p.name, path: p.path, role: p.role ?? 'admin' })),
    source: 'file',
  };
}

afterEach(async () => {
  await new Promise(r => setTimeout(r, 50));
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* windows */ }
  }
});

describe('EnginePool', () => {
  it('lazy-inits an engine on first get and caches thereafter', async () => {
    const dir = makeTempDir();
    const pool = new EnginePool(makeInstance([{ name: 'alpha', path: dir }]));
    expect(pool.has('alpha')).toBe(false);

    const first = await pool.get('alpha');
    expect(first.ok).toBe(true);
    expect(pool.has('alpha')).toBe(true);

    const second = await pool.get('alpha');
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value).toBe(first.value);
    }

    await pool.closeAll();
  });

  it('returns PROJECT_UNKNOWN for names not in the instance', async () => {
    const dir = makeTempDir();
    const pool = new EnginePool(makeInstance([{ name: 'alpha', path: dir }]));
    const result = await pool.get('ghost');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].code).toBe('PROJECT_UNKNOWN');
    await pool.closeAll();
  });

  it('initializes engines independently for multiple projects', async () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    const pool = new EnginePool(makeInstance([
      { name: 'alpha', path: dirA },
      { name: 'beta', path: dirB },
    ]));

    const a = await pool.get('alpha');
    const b = await pool.get('beta');
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.value).not.toBe(b.value);
    }

    await pool.closeAll();
  });

  it('scaffolds _skills/ on first init via empty-project boot', async () => {
    const dir = makeTempDir();
    const pool = new EnginePool(makeInstance([{ name: 'alpha', path: dir }]));

    await pool.get('alpha');
    expect(existsSync(path.join(dir, '_skills', 'architect-core.md'))).toBe(true);
    expect(existsSync(path.join(dir, '_registry', 'object_types.yaml'))).toBe(true);

    await pool.closeAll();
  });

  it('evict closes the engine and removes from cache', async () => {
    const dir = makeTempDir();
    const pool = new EnginePool(makeInstance([{ name: 'alpha', path: dir }]));

    await pool.get('alpha');
    expect(pool.has('alpha')).toBe(true);

    await pool.evict('alpha');
    expect(pool.has('alpha')).toBe(false);
    await pool.closeAll();
  });

  it('evict on a non-cached project is a no-op', async () => {
    const pool = new EnginePool(makeInstance([{ name: 'alpha', path: makeTempDir() }]));
    await expect(pool.evict('alpha')).resolves.toBeUndefined();
    await expect(pool.evict('ghost')).resolves.toBeUndefined();
  });

  it('concurrent gets for the same project share one init', async () => {
    const dir = makeTempDir();
    const pool = new EnginePool(makeInstance([{ name: 'alpha', path: dir }]));

    const [a, b, c] = await Promise.all([pool.get('alpha'), pool.get('alpha'), pool.get('alpha')]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (a.ok && b.ok && c.ok) {
      expect(a.value).toBe(b.value);
      expect(b.value).toBe(c.value);
    }
    await pool.closeAll();
  });

  it('listProjects returns a copy of the project list', () => {
    const dir = makeTempDir();
    const pool = new EnginePool(makeInstance([{ name: 'alpha', path: dir }]));
    const list1 = pool.listProjects();
    list1.push({ name: 'hack', path: '/x', role: 'admin' });
    expect(pool.listProjects()).toHaveLength(1);
  });
});

// ============================================================================
// 0.7.3 — Idle-timeout eviction (fup-2026-150)
// ============================================================================

describe('EnginePool — idle-timeout eviction (Stage 1)', () => {
  it('get() bumps lastTouchedAt; evictIdle removes engines past threshold', async () => {
    const dir = makeTempDir();
    const pool = new EnginePool(makeInstance([{ name: 'alpha', path: dir }]));
    let now = 1_000_000;
    pool.setNowFn(() => now);

    await pool.get('alpha');
    expect(pool.has('alpha')).toBe(true);
    expect(pool.lastTouchedFor('alpha')).toBe(1_000_000);

    // Just under threshold — no eviction
    now += 29 * 60 * 1000;
    let evicted = await pool.evictIdle(30 * 60 * 1000);
    expect(evicted).toEqual([]);
    expect(pool.has('alpha')).toBe(true);

    // Past threshold — evicted
    now += 2 * 60 * 1000; // total 31 min idle
    evicted = await pool.evictIdle(30 * 60 * 1000);
    expect(evicted).toEqual(['alpha']);
    expect(pool.has('alpha')).toBe(false);

    const stats = pool.evictionStatsSnapshot();
    expect(stats.evictionsTotal).toBe(1);
    expect(stats.lastEvictionProjects).toEqual(['alpha']);

    await pool.closeAll();
  });

  it('refcount > 0 blocks eviction even past threshold', async () => {
    const dir = makeTempDir();
    const pool = new EnginePool(makeInstance([{ name: 'alpha', path: dir }]));
    let now = 1_000_000;
    pool.setNowFn(() => now);

    await pool.get('alpha');
    pool.acquire('alpha');

    now += 60 * 60 * 1000; // 1 hour, well past 30-min threshold

    // Note: acquire() bumps lastTouchedAt to "now" — so to test the
    // refcount-blocks-eviction path specifically, freeze touch time to the
    // pre-acquire value by re-setting it.
    // Better: advance time AFTER acquiring without further activity.
    // Acquire bumped to now=1_000_000. Advance:
    now += 60 * 60 * 1000;

    const evicted = await pool.evictIdle(30 * 60 * 1000);
    expect(evicted).toEqual([]);
    expect(pool.has('alpha')).toBe(true);

    pool.release('alpha');
    // Release bumps lastTouchedAt to current `now`, so wait again for idle.
    now += 31 * 60 * 1000;
    const after = await pool.evictIdle(30 * 60 * 1000);
    expect(after).toEqual(['alpha']);

    await pool.closeAll();
  });

  it('idleTimeoutMs=0 disables eviction (sweep is a no-op)', async () => {
    const dir = makeTempDir();
    const pool = new EnginePool(makeInstance([{ name: 'alpha', path: dir }]));
    let now = 0;
    pool.setNowFn(() => now);

    await pool.get('alpha');
    now += 999_999_999; // far future

    const evicted = await pool.evictIdle(0);
    expect(evicted).toEqual([]);
    expect(pool.has('alpha')).toBe(true);

    await pool.closeAll();
  });

  it('evictIdle handles multiple projects independently', async () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    const pool = new EnginePool(makeInstance([
      { name: 'alpha', path: dirA },
      { name: 'beta', path: dirB },
    ]));
    let now = 0;
    pool.setNowFn(() => now);

    await pool.get('alpha');
    now += 20 * 60 * 1000; // 20 min later
    await pool.get('beta');
    now += 20 * 60 * 1000; // alpha now 40 min idle, beta 20 min idle

    const evicted = await pool.evictIdle(30 * 60 * 1000);
    expect(evicted).toEqual(['alpha']);
    expect(pool.has('alpha')).toBe(false);
    expect(pool.has('beta')).toBe(true);

    await pool.closeAll();
  });

  it('refcount tracks acquire/release pairs and clamps at zero', () => {
    const pool = new EnginePool(makeInstance([{ name: 'alpha', path: '/x' }]));
    expect(pool.refcountFor('alpha')).toBe(0);
    pool.acquire('alpha');
    pool.acquire('alpha');
    expect(pool.refcountFor('alpha')).toBe(2);
    pool.release('alpha');
    expect(pool.refcountFor('alpha')).toBe(1);
    pool.release('alpha');
    expect(pool.refcountFor('alpha')).toBe(0);
    // Extra release does not go negative
    pool.release('alpha');
    expect(pool.refcountFor('alpha')).toBe(0);
  });

  it('readIdleSweepEnv defaults match documented values', () => {
    const cfg = EnginePool.readIdleSweepEnv({});
    expect(cfg.idleTimeoutMs).toBe(30 * 60 * 1000);
    expect(cfg.sweepIntervalMs).toBe(60 * 1000);
  });

  it('readIdleSweepEnv honors explicit env overrides', () => {
    const cfg = EnginePool.readIdleSweepEnv({
      MAAD_PROJECT_IDLE_TIMEOUT_MS: '120000',
      MAAD_PROJECT_SWEEP_INTERVAL_MS: '10000',
    });
    expect(cfg.idleTimeoutMs).toBe(120000);
    expect(cfg.sweepIntervalMs).toBe(10000);
  });

  it('readIdleSweepEnv accepts MAAD_PROJECT_IDLE_TIMEOUT_MS=0 as disable', () => {
    const cfg = EnginePool.readIdleSweepEnv({ MAAD_PROJECT_IDLE_TIMEOUT_MS: '0' });
    expect(cfg.idleTimeoutMs).toBe(0);
  });

  it('startIdleSweeper is idempotent and stopIdleSweeper clears the timer', () => {
    const pool = new EnginePool(makeInstance([{ name: 'alpha', path: '/x' }]));
    pool.startIdleSweeper({ idleTimeoutMs: 1000, sweepIntervalMs: 100 });
    expect(pool.idleSweepConfig()).not.toBeNull();
    pool.startIdleSweeper({ idleTimeoutMs: 2000, sweepIntervalMs: 200 });
    expect(pool.idleSweepConfig()).toEqual({ idleTimeoutMs: 2000, sweepIntervalMs: 200 });
    pool.stopIdleSweeper();
    expect(pool.idleSweepConfig()).toBeNull();
  });

  it('startIdleSweeper with idleTimeoutMs=0 does not schedule a timer', () => {
    const pool = new EnginePool(makeInstance([{ name: 'alpha', path: '/x' }]));
    pool.startIdleSweeper({ idleTimeoutMs: 0, sweepIntervalMs: 100 });
    expect(pool.idleSweepConfig()).toEqual({ idleTimeoutMs: 0, sweepIntervalMs: 100 });
    // Sweep config is recorded but no actual interval was set; stop should be a no-op.
    pool.stopIdleSweeper();
  });
});
