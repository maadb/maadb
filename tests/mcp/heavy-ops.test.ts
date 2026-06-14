import { describe, it, expect, afterEach } from 'vitest';
import {
  HeavyOpGuard,
  heavyOpKey,
  readHeavyOpGuardEnv,
  type HeavyOpGuardConfig,
} from '../../src/mcp/heavy-ops.js';

const MB = 1024 * 1024;

// A probe returning a fixed memory sample. cgroup fields null unless given.
function fixedProbe(opts: {
  heapUsedMb: number;
  heapCapMb: number;
  cgroupCurrentMb?: number;
  cgroupMaxMb?: number;
}): HeavyOpGuardConfig['probe'] {
  return () => ({
    heapUsedBytes: opts.heapUsedMb * MB,
    heapCapBytes: opts.heapCapMb * MB,
    cgroupCurrentBytes: opts.cgroupCurrentMb !== undefined ? opts.cgroupCurrentMb * MB : null,
    cgroupMaxBytes: opts.cgroupMaxMb !== undefined ? opts.cgroupMaxMb * MB : null,
  });
}

describe('HeavyOpGuard.isHeavy', () => {
  it('flags the maintenance ops and nothing else', () => {
    const g = new HeavyOpGuard();
    for (const t of ['maad_reindex', 'maad_reload', 'maad_schema', 'maad_summary']) {
      expect(g.isHeavy(t)).toBe(true);
    }
    expect(g.isHeavy('maad_get')).toBe(false);
    expect(g.isHeavy('maad_create')).toBe(false);
  });

  it('reports nothing heavy when disabled', () => {
    const g = new HeavyOpGuard({ disabled: true });
    expect(g.isHeavy('maad_reindex')).toBe(false);
  });
});

describe('HeavyOpGuard.checkAdmission — free-heap floor', () => {
  it('admits when free heap is above the floor', () => {
    const g = new HeavyOpGuard({
      minFreeHeapBytes: 96 * MB,
      probe: fixedProbe({ heapUsedMb: 100, heapCapMb: 253 }), // 153 MB free
    });
    expect(g.checkAdmission()).toBeNull();
  });

  it('sheds (retryable) when free heap is below the floor', () => {
    const g = new HeavyOpGuard({
      minFreeHeapBytes: 96 * MB,
      retryAfterMs: 1000,
      probe: fixedProbe({ heapUsedMb: 200, heapCapMb: 253 }), // 53 MB free
    });
    const r = g.checkAdmission();
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('free_heap');
    expect(r!.retryAfterMs).toBe(1000);
    expect(r!.minFreeMb).toBeCloseTo(96, 0);
    expect(g.snapshot().shedTotal).toBe(1);
  });

  it('does NOT false-trip a large resident working set that still has headroom', () => {
    // 1.9 GB used against a 2 GB cap = 148 MB free, ratio 0.95 — a ratio gate
    // would wrongly shed; an absolute byte floor admits because headroom > 96 MB.
    const g = new HeavyOpGuard({
      minFreeHeapBytes: 96 * MB,
      probe: fixedProbe({ heapUsedMb: 1900, heapCapMb: 2048 }),
    });
    expect(g.checkAdmission()).toBeNull();
  });

  it('sheds on tight cgroup budget even when heap looks fine', () => {
    const g = new HeavyOpGuard({
      minFreeHeapBytes: 96 * MB,
      probe: fixedProbe({ heapUsedMb: 100, heapCapMb: 253, cgroupCurrentMb: 990, cgroupMaxMb: 1024 }),
    });
    const r = g.checkAdmission();
    expect(r!.reason).toBe('free_cgroup');
  });

  it('fails open when the probe returns null', () => {
    const g = new HeavyOpGuard({ minFreeHeapBytes: 96 * MB, probe: () => null });
    expect(g.checkAdmission()).toBeNull();
  });

  it('never sheds when disabled', () => {
    const g = new HeavyOpGuard({
      disabled: true,
      minFreeHeapBytes: 96 * MB,
      probe: fixedProbe({ heapUsedMb: 250, heapCapMb: 253 }),
    });
    expect(g.checkAdmission()).toBeNull();
  });
});

describe('HeavyOpGuard.runCoalesced — single-flight', () => {
  it('collapses concurrent identical ops into one execution', async () => {
    const g = new HeavyOpGuard();
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = async () => { runs++; await gate; return runs; };

    const key = heavyOpKey('proj', 'maad_reindex', { force: true });
    const a = g.runCoalesced(key, run);
    const b = g.runCoalesced(key, run);
    const c = g.runCoalesced(key, run);
    release();
    const [ra, rb, rc] = await Promise.all([a, b, c]);

    expect(runs).toBe(1);
    expect([ra, rb, rc]).toEqual([1, 1, 1]);
    expect(g.snapshot().coalescedTotal).toBe(2); // two followers
  });

  it('does not coalesce different keys', async () => {
    const g = new HeavyOpGuard();
    let runs = 0;
    const run = async () => { runs++; return runs; };
    await Promise.all([
      g.runCoalesced(heavyOpKey('p', 'maad_schema', { docType: 'a' }), run),
      g.runCoalesced(heavyOpKey('p', 'maad_schema', { docType: 'b' }), run),
    ]);
    expect(runs).toBe(2);
  });

  it('clears the in-flight slot after settle so later calls re-run', async () => {
    const g = new HeavyOpGuard();
    let runs = 0;
    const run = async () => { runs++; return runs; };
    const key = heavyOpKey('p', 'maad_reload', undefined);
    await g.runCoalesced(key, run);
    await g.runCoalesced(key, run);
    expect(runs).toBe(2);
    expect(g.snapshot().inFlight).toBe(0);
  });

  it('propagates rejection to all followers and clears the slot', async () => {
    const g = new HeavyOpGuard();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = async () => { await gate; throw new Error('boom'); };
    const key = heavyOpKey('p', 'maad_reindex', undefined);
    const a = g.runCoalesced(key, run);
    const b = g.runCoalesced(key, run);
    release();
    await expect(a).rejects.toThrow('boom');
    await expect(b).rejects.toThrow('boom');
    expect(g.snapshot().inFlight).toBe(0);
  });
});

describe('HeavyOpGuard.tryAcquireConcurrencySlot — process-global cap', () => {
  const healthy = fixedProbe({ heapUsedMb: 50, heapCapMb: 253 });

  it('admits up to the cap, then fast-fails (retryable)', () => {
    const g = new HeavyOpGuard({ maxConcurrent: 2, retryAfterMs: 1000, probe: healthy });
    const s1 = g.tryAcquireConcurrencySlot();
    const s2 = g.tryAcquireConcurrencySlot();
    expect(s1.ok && s2.ok).toBe(true);
    const s3 = g.tryAcquireConcurrencySlot();
    expect(s3.ok).toBe(false);
    if (!s3.ok) {
      expect(s3.rejection.reason).toBe('concurrency');
      expect(s3.rejection.limit).toBe(2);
      expect(s3.rejection.retryAfterMs).toBe(1000);
    }
    expect(g.snapshot().inFlight).toBe(2);
    expect(g.snapshot().concurrencyRejectedTotal).toBe(1);
  });

  it('release frees a slot and is idempotent', () => {
    const g = new HeavyOpGuard({ maxConcurrent: 1, probe: healthy });
    const s1 = g.tryAcquireConcurrencySlot();
    expect(g.tryAcquireConcurrencySlot().ok).toBe(false);
    if (s1.ok) { s1.release(); s1.release(); } // double release must not under-count
    expect(g.snapshot().inFlight).toBe(0);
    expect(g.tryAcquireConcurrencySlot().ok).toBe(true);
  });

  it('maxConcurrent=0 disables the cap', () => {
    const g = new HeavyOpGuard({ maxConcurrent: 0, probe: healthy });
    for (let i = 0; i < 50; i++) expect(g.tryAcquireConcurrencySlot().ok).toBe(true);
  });

  it('never caps when the guard is disabled', () => {
    const g = new HeavyOpGuard({ disabled: true, maxConcurrent: 1, probe: healthy });
    expect(g.tryAcquireConcurrencySlot().ok).toBe(true);
    expect(g.tryAcquireConcurrencySlot().ok).toBe(true);
  });
});

describe('HeavyOpGuard — circuit breaker', () => {
  function shedGuard(now: () => number, overrides: Partial<HeavyOpGuardConfig> = {}) {
    return new HeavyOpGuard({
      minFreeHeapBytes: 96 * MB,
      breakerThreshold: 3,
      breakerCooldownMs: 5000,
      retryAfterMs: 1000,
      probe: fixedProbe({ heapUsedMb: 220, heapCapMb: 253 }), // 33 MB free → sheds
      ...overrides,
    }, now);
  }

  it('trips open after threshold consecutive sheds, then fast-fails without sampling', () => {
    let t = 0;
    const g = shedGuard(() => t);
    expect(g.checkAdmission()!.reason).toBe('free_heap');
    expect(g.checkAdmission()!.reason).toBe('free_heap');
    expect(g.checkAdmission()!.reason).toBe('free_heap'); // 3rd shed trips
    expect(g.snapshot().breakerTrippedTotal).toBe(1);
    expect(g.snapshot().breakerOpen).toBe(true);

    const r = g.checkAdmission();
    expect(r!.reason).toBe('breaker_open');
    expect(r!.retryAfterMs).toBe(5000);
    expect(g.snapshot().breakerRejectedTotal).toBe(1);
  });

  it('half-opens after cooldown and closes on a healthy sample', () => {
    let t = 0;
    const mem = { heapUsedMb: 220, heapCapMb: 253 };
    const g = new HeavyOpGuard({
      minFreeHeapBytes: 96 * MB,
      breakerThreshold: 2,
      breakerCooldownMs: 5000,
      probe: () => ({
        heapUsedBytes: mem.heapUsedMb * MB,
        heapCapBytes: mem.heapCapMb * MB,
        cgroupCurrentBytes: null,
        cgroupMaxBytes: null,
      }),
    }, () => t);

    g.checkAdmission();
    g.checkAdmission(); // trips (threshold 2)
    expect(g.snapshot().breakerOpen).toBe(true);

    t = 4999;
    expect(g.checkAdmission()!.reason).toBe('breaker_open'); // still in cooldown

    t = 5000;
    mem.heapUsedMb = 50; // recovered
    expect(g.checkAdmission()).toBeNull(); // half-open trial admits
    expect(g.snapshot().breakerOpen).toBe(false);
  });

  it('breakerThreshold=0 disables the breaker', () => {
    let t = 0;
    const g = shedGuard(() => t, { breakerThreshold: 0 });
    for (let i = 0; i < 10; i++) expect(g.checkAdmission()!.reason).toBe('free_heap');
    expect(g.snapshot().breakerOpen).toBe(false);
    expect(g.snapshot().breakerTrippedTotal).toBe(0);
  });

  it('a healthy sample resets the shed streak before it trips', () => {
    let t = 0;
    const mem = { heapUsedMb: 220, heapCapMb: 253 };
    const g = new HeavyOpGuard({
      minFreeHeapBytes: 96 * MB,
      breakerThreshold: 3,
      probe: () => ({
        heapUsedBytes: mem.heapUsedMb * MB,
        heapCapBytes: mem.heapCapMb * MB,
        cgroupCurrentBytes: null,
        cgroupMaxBytes: null,
      }),
    }, () => t);
    g.checkAdmission(); // shed 1
    g.checkAdmission(); // shed 2
    mem.heapUsedMb = 50;
    expect(g.checkAdmission()).toBeNull(); // resets streak
    mem.heapUsedMb = 220;
    g.checkAdmission(); // shed 1 again
    expect(g.snapshot().breakerOpen).toBe(false); // never reached 3 in a row
  });
});

describe('heavyOpKey', () => {
  it('is stable across arg key order', () => {
    expect(heavyOpKey('p', 'maad_reindex', { a: 1, b: 2 }))
      .toBe(heavyOpKey('p', 'maad_reindex', { b: 2, a: 1 }));
  });

  it('separates by project, tool, and args', () => {
    const base = heavyOpKey('p', 'maad_reindex', { force: true });
    expect(heavyOpKey('q', 'maad_reindex', { force: true })).not.toBe(base);
    expect(heavyOpKey('p', 'maad_reload', { force: true })).not.toBe(base);
    expect(heavyOpKey('p', 'maad_reindex', { force: false })).not.toBe(base);
  });
});

describe('readHeavyOpGuardEnv', () => {
  const snapshot = { ...process.env };
  afterEach(() => { process.env = { ...snapshot }; });

  it('parses every knob', () => {
    process.env.MAAD_HEAVY_OP_GUARD_DISABLE = '1';
    process.env.MAAD_HEAVY_OP_MIN_FREE_HEAP_MB = '64';
    process.env.MAAD_HEAVY_OP_RETRY_AFTER_MS = '500';
    process.env.MAAD_HEAVY_OP_MAX_CONCURRENT = '2';
    process.env.MAAD_HEAVY_OP_BREAKER_THRESHOLD = '5';
    process.env.MAAD_HEAVY_OP_BREAKER_COOLDOWN_MS = '8000';
    const cfg = readHeavyOpGuardEnv();
    expect(cfg.disabled).toBe(true);
    expect(cfg.minFreeHeapBytes).toBe(64 * MB);
    expect(cfg.retryAfterMs).toBe(500);
    expect(cfg.maxConcurrent).toBe(2);
    expect(cfg.breakerThreshold).toBe(5);
    expect(cfg.breakerCooldownMs).toBe(8000);
  });

  it('returns empty when no knobs set', () => {
    for (const k of [
      'MAAD_HEAVY_OP_GUARD_DISABLE', 'MAAD_HEAVY_OP_MIN_FREE_HEAP_MB', 'MAAD_HEAVY_OP_RETRY_AFTER_MS',
      'MAAD_HEAVY_OP_MAX_CONCURRENT', 'MAAD_HEAVY_OP_BREAKER_THRESHOLD', 'MAAD_HEAVY_OP_BREAKER_COOLDOWN_MS',
    ]) delete process.env[k];
    expect(readHeavyOpGuardEnv()).toEqual({});
  });
});
