import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { initLogging } from '../../src/logging.js';
import {
  initMemoryPressureWatcher,
  stopMemoryPressureWatcher,
  sampleOnce,
  getMemoryPressureSnapshot,
  readMemoryPressureEnv,
  __resetMemoryPressureForTests,
  type Sampler,
} from '../../src/mcp/memory-pressure.js';

class CaptureStream extends Writable {
  public lines: Array<Record<string, unknown>> = [];
  _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    const raw = chunk.toString('utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.lines.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        // ignore
      }
    }
    cb();
  }
  clear(): void { this.lines = []; }
}

function mkSampler(values: Array<{
  used: number;
  cap: number;
  rss?: number;
  external?: number;
  arrayBuffers?: number;
  cgroupCurrent?: number | null;
  cgroupMax?: number | null;
}>): { sampler: Sampler; cursor: () => number } {
  let i = 0;
  const sampler: Sampler = () => {
    const v = values[Math.min(i, values.length - 1)]!;
    i++;
    return {
      heapUsedBytes: v.used,
      heapCapBytes: v.cap,
      rssBytes: v.rss ?? v.used,
      externalBytes: v.external ?? 0,
      arrayBuffersBytes: v.arrayBuffers ?? 0,
      cgroupCurrentBytes: v.cgroupCurrent ?? null,
      cgroupMaxBytes: v.cgroupMax ?? null,
    };
  };
  return { sampler, cursor: () => i };
}

const MB = 1024 * 1024;
const CAP = 512 * MB;

function pressureLines(ops: CaptureStream): Array<Record<string, unknown>> {
  return ops.lines.filter(l => l.operation === 'memory_pressure');
}

describe('memory-pressure watcher', () => {
  let ops: CaptureStream;
  let audit: CaptureStream;
  let nowMs = 1_700_000_000_000;
  const now = (): number => nowMs;

  beforeEach(() => {
    ops = new CaptureStream();
    audit = new CaptureStream();
    initLogging({ opsDestination: ops, auditDestination: audit, level: 'info' });
    __resetMemoryPressureForTests();
    nowMs = 1_700_000_000_000;
  });

  afterEach(() => {
    __resetMemoryPressureForTests();
  });

  it('MP1 — snapshot has null sample fields before first sample', () => {
    initMemoryPressureWatcher({ intervalMs: 0, thresholdRatio: 0.8, cooldownMs: 1000 });
    const snap = getMemoryPressureSnapshot();
    expect(snap.enabled).toBe(false);
    expect(snap.lastSampleAt).toBeNull();
    expect(snap.heapUsedMb).toBeNull();
    expect(snap.heapCapMb).toBeNull();
    expect(snap.rssMb).toBeNull();
    expect(snap.cgroupCurrentMb).toBeNull();
    expect(snap.ratio).toBeNull();
    expect(snap.heapRatio).toBeNull();
    expect(snap.cgroupRatio).toBeNull();
    expect(snap.inPressure).toBe(false);
    expect(snap.heapInPressure).toBe(false);
    expect(snap.cgroupInPressure).toBe(false);
    expect(snap.pressureFiresTotal).toBe(0);
  });

  it('MP2 — under threshold, no log + inPressure stays false', () => {
    const { sampler } = mkSampler([{ used: 100 * MB, cap: CAP }]);
    initMemoryPressureWatcher({ intervalMs: 0, thresholdRatio: 0.8, cooldownMs: 1000, sampler, now });
    sampleOnce();
    const snap = getMemoryPressureSnapshot();
    expect(snap.inPressure).toBe(false);
    expect(snap.pressureFiresTotal).toBe(0);
    expect(pressureLines(ops)).toHaveLength(0);
    // Snapshot still records the sample
    expect(snap.heapUsedMb).toBe(100);
    expect(snap.heapCapMb).toBe(512);
    expect(snap.ratio).toBeCloseTo(0.195, 2);
  });

  it('MP3 — crossing threshold fires one degraded log + flips inPressure', () => {
    const { sampler } = mkSampler([{ used: 450 * MB, cap: CAP }]);
    initMemoryPressureWatcher({ intervalMs: 0, thresholdRatio: 0.8, cooldownMs: 1000, sampler, now });
    sampleOnce();
    const lines = pressureLines(ops);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.level).toBe(40); // pino warn
    expect(line.event).toBe('engine');
    expect(line.category).toBe('engine');
    expect(line.operation).toBe('memory_pressure');
    expect(line.heap_used_mb).toBe(450);
    expect(line.heap_cap_mb).toBe(512);
    expect(line.reason).toBe('heap');
    expect(line.ratio).toBeCloseTo(0.879, 2);
    expect(line.heap_ratio).toBeCloseTo(0.879, 2);
    expect(line.threshold_ratio).toBe(0.8);
    expect(line.edge).toBe(true);
    const snap = getMemoryPressureSnapshot();
    expect(snap.inPressure).toBe(true);
    expect(snap.heapInPressure).toBe(true);
    expect(snap.cgroupInPressure).toBe(false);
    expect(snap.pressureFiresTotal).toBe(1);
    expect(snap.lastPressureAt).not.toBeNull();
  });

  it('MP3b — cgroup pressure fires even when V8 heap is under threshold', () => {
    const { sampler } = mkSampler([{
      used: 100 * MB,
      cap: CAP,
      rss: 900 * MB,
      external: 300 * MB,
      arrayBuffers: 25 * MB,
      cgroupCurrent: 930 * MB,
      cgroupMax: 1024 * MB,
    }]);
    initMemoryPressureWatcher({ intervalMs: 0, thresholdRatio: 0.8, cooldownMs: 1000, sampler, now });
    sampleOnce();
    const lines = pressureLines(ops);
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line.reason).toBe('cgroup');
    expect(line.heap_ratio).toBeCloseTo(0.195, 2);
    expect(line.cgroup_ratio).toBeCloseTo(0.908, 2);
    expect(line.rss_mb).toBe(900);
    expect(line.external_mb).toBe(300);
    expect(line.array_buffers_mb).toBe(25);
    const snap = getMemoryPressureSnapshot();
    expect(snap.inPressure).toBe(true);
    expect(snap.heapInPressure).toBe(false);
    expect(snap.cgroupInPressure).toBe(true);
    expect(snap.cgroupCurrentMb).toBe(930);
    expect(snap.cgroupMaxMb).toBe(1024);
    expect(snap.cgroupRatio).toBeCloseTo(0.908, 2);
  });

  it('MP4 — sustained pressure within cooldown does not re-fire', () => {
    const { sampler } = mkSampler([
      { used: 450 * MB, cap: CAP },
      { used: 460 * MB, cap: CAP },
      { used: 470 * MB, cap: CAP },
    ]);
    initMemoryPressureWatcher({ intervalMs: 0, thresholdRatio: 0.8, cooldownMs: 60_000, sampler, now });
    sampleOnce(); // edge fire
    nowMs += 10_000;
    sampleOnce(); // still in pressure, within cooldown → no fire
    nowMs += 10_000;
    sampleOnce();
    expect(pressureLines(ops)).toHaveLength(1);
    expect(getMemoryPressureSnapshot().pressureFiresTotal).toBe(1);
  });

  it('MP5 — sustained pressure past cooldown re-fires', () => {
    const { sampler } = mkSampler([
      { used: 450 * MB, cap: CAP },
      { used: 460 * MB, cap: CAP },
    ]);
    initMemoryPressureWatcher({ intervalMs: 0, thresholdRatio: 0.8, cooldownMs: 5_000, sampler, now });
    sampleOnce();
    nowMs += 6_000;
    sampleOnce();
    const lines = pressureLines(ops);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.edge).toBe(true);
    expect(lines[1]!.edge).toBe(false); // sustained, not an edge crossing
    expect(getMemoryPressureSnapshot().pressureFiresTotal).toBe(2);
  });

  it('MP6 — drop below threshold re-arms the edge trigger', () => {
    const { sampler } = mkSampler([
      { used: 450 * MB, cap: CAP }, // fire (edge)
      { used: 100 * MB, cap: CAP }, // exit pressure
      { used: 460 * MB, cap: CAP }, // fire (edge again, despite cooldown not elapsed)
    ]);
    initMemoryPressureWatcher({ intervalMs: 0, thresholdRatio: 0.8, cooldownMs: 60_000, sampler, now });
    sampleOnce();
    expect(getMemoryPressureSnapshot().inPressure).toBe(true);
    nowMs += 1_000;
    sampleOnce();
    expect(getMemoryPressureSnapshot().inPressure).toBe(false);
    nowMs += 1_000;
    sampleOnce();
    const lines = pressureLines(ops);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.edge).toBe(true);
    expect(lines[1]!.edge).toBe(true);
  });

  it('MP7 — intervalMs=0 disables the background timer', () => {
    initMemoryPressureWatcher({ intervalMs: 0, thresholdRatio: 0.8, cooldownMs: 1000 });
    const snap = getMemoryPressureSnapshot();
    expect(snap.enabled).toBe(false);
    // No timer; verify by not calling sampleOnce and waiting briefly produces nothing.
    // (We can't easily probe internal timer; the enabled flag is the contract.)
  });

  it('MP8 — sampler errors are swallowed and do not throw or mutate state', () => {
    const throwingSampler: Sampler = () => { throw new Error('boom'); };
    initMemoryPressureWatcher({ intervalMs: 0, thresholdRatio: 0.8, cooldownMs: 1000, sampler: throwingSampler, now });
    expect(() => sampleOnce()).not.toThrow();
    expect(getMemoryPressureSnapshot().lastSampleAt).toBeNull();
    expect(pressureLines(ops)).toHaveLength(0);
  });

  it('MP9 — heapCapBytes=0 returns silently without divide-by-zero', () => {
    const { sampler } = mkSampler([{ used: 100 * MB, cap: 0 }]);
    initMemoryPressureWatcher({ intervalMs: 0, thresholdRatio: 0.8, cooldownMs: 1000, sampler, now });
    expect(() => sampleOnce()).not.toThrow();
    const snap = getMemoryPressureSnapshot();
    // Sample is recorded but ratio is null (cap=0 short-circuit)
    expect(snap.heapUsedMb).toBe(100);
    expect(snap.heapCapMb).toBe(0);
    expect(snap.ratio).toBeNull();
    expect(pressureLines(ops)).toHaveLength(0);
  });

  describe('readMemoryPressureEnv', () => {
    const originals: Record<string, string | undefined> = {};
    const keys = ['MAAD_MEMORY_PRESSURE_INTERVAL_MS', 'MAAD_MEMORY_PRESSURE_RATIO', 'MAAD_MEMORY_PRESSURE_COOLDOWN_MS'];
    beforeEach(() => {
      for (const k of keys) originals[k] = process.env[k];
      for (const k of keys) delete process.env[k];
    });
    afterEach(() => {
      for (const k of keys) {
        if (originals[k] === undefined) delete process.env[k];
        else process.env[k] = originals[k]!;
      }
    });

    it('MP10 — defaults when env unset', () => {
      const env = readMemoryPressureEnv();
      expect(env.intervalMs).toBe(60_000);
      expect(env.thresholdRatio).toBe(0.8);
      expect(env.cooldownMs).toBe(300_000);
    });

    it('MP11 — honors env overrides', () => {
      process.env.MAAD_MEMORY_PRESSURE_INTERVAL_MS = '30000';
      process.env.MAAD_MEMORY_PRESSURE_RATIO = '0.7';
      process.env.MAAD_MEMORY_PRESSURE_COOLDOWN_MS = '120000';
      const env = readMemoryPressureEnv();
      expect(env.intervalMs).toBe(30_000);
      expect(env.thresholdRatio).toBe(0.7);
      expect(env.cooldownMs).toBe(120_000);
    });

    it('MP12 — clamps ratio to [0, 1]', () => {
      process.env.MAAD_MEMORY_PRESSURE_RATIO = '1.5';
      expect(readMemoryPressureEnv().thresholdRatio).toBe(1);
      process.env.MAAD_MEMORY_PRESSURE_RATIO = '-0.2';
      expect(readMemoryPressureEnv().thresholdRatio).toBe(0);
    });

    it('MP13 — ignores non-numeric env values', () => {
      process.env.MAAD_MEMORY_PRESSURE_INTERVAL_MS = 'not-a-number';
      const env = readMemoryPressureEnv();
      expect(env.intervalMs).toBe(60_000);
    });
  });

  it('MP14 — stopMemoryPressureWatcher is idempotent', () => {
    initMemoryPressureWatcher({ intervalMs: 100, thresholdRatio: 0.8, cooldownMs: 1000 });
    expect(() => stopMemoryPressureWatcher()).not.toThrow();
    expect(() => stopMemoryPressureWatcher()).not.toThrow();
  });
});
