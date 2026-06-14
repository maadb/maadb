// ============================================================================
// Memory Pressure Watcher — periodic V8 heap-usage sampler.
//
// Samples process.memoryUsage().heapUsed against v8.getHeapStatistics()
// heap_size_limit on an interval and emits a degraded-severity log event
// when the ratio passes a configured threshold. Pure observability — never
// mutates engine state, never throws, never blocks shutdown.
//
// Background: cgroup-capped deployments (e.g. 512 MiB container on Node 24)
// trip V8's auto-calibrated old-space cap at ~253 MB heap_size_limit. Without
// this surface, the only signal that a process is approaching the cap is
// post-mortem (exitCode=134 with "Reached heap limit"). The watcher gives
// operators a pre-OOM warning + a counter in maad_health.
//
// Disabled when intervalMs <= 0 (set MAAD_MEMORY_PRESSURE_INTERVAL_MS=0).
// Cooldown prevents log spam under sustained pressure — one fire per
// cooldown window while the ratio stays above threshold; the first sample
// below threshold re-arms the edge trigger.
// ============================================================================

import v8 from 'node:v8';
import { readFileSync } from 'node:fs';
import { logger } from '../engine/logger.js';

export interface MemoryPressureOptions {
  intervalMs: number;
  thresholdRatio: number;
  cooldownMs: number;
  sampler?: Sampler;
  now?: () => number;
}

export interface MemoryPressureSnapshot {
  enabled: boolean;
  intervalMs: number;
  thresholdRatio: number;
  lastSampleAt: string | null;
  heapUsedMb: number | null;
  heapCapMb: number | null;
  heapRatio: number | null;
  ratio: number | null;
  rssMb: number | null;
  externalMb: number | null;
  arrayBuffersMb: number | null;
  cgroupCurrentMb: number | null;
  cgroupMaxMb: number | null;
  cgroupRatio: number | null;
  inPressure: boolean;
  heapInPressure: boolean;
  cgroupInPressure: boolean;
  lastPressureAt: string | null;
  pressureFiresTotal: number;
}

export interface MemorySample {
  heapUsedBytes: number;
  heapCapBytes: number;
  rssBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  cgroupCurrentBytes: number | null;
  cgroupMaxBytes: number | null;
}

export type Sampler = () => MemorySample;

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_THRESHOLD_RATIO = 0.8;
const DEFAULT_COOLDOWN_MS = 5 * 60_000;

const defaultSampler: Sampler = () => {
  const stats = v8.getHeapStatistics();
  const usage = process.memoryUsage();
  const cgroup = readCgroupMemory();
  return {
    heapUsedBytes: stats.used_heap_size,
    heapCapBytes: stats.heap_size_limit,
    rssBytes: usage.rss,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
    cgroupCurrentBytes: cgroup.current,
    cgroupMaxBytes: cgroup.max,
  };
};

interface WatcherState {
  intervalMs: number;
  thresholdRatio: number;
  cooldownMs: number;
  sampler: Sampler;
  now: () => number;
  timer: NodeJS.Timeout | null;
  lastSampleAtMs: number | null;
  heapUsedBytes: number | null;
  heapCapBytes: number | null;
  rssBytes: number | null;
  externalBytes: number | null;
  arrayBuffersBytes: number | null;
  cgroupCurrentBytes: number | null;
  cgroupMaxBytes: number | null;
  inPressure: boolean;
  heapInPressure: boolean;
  cgroupInPressure: boolean;
  lastPressureAtMs: number | null;
  lastFireAtMs: number | null;
  pressureFiresTotal: number;
}

const state: WatcherState = {
  intervalMs: 0,
  thresholdRatio: DEFAULT_THRESHOLD_RATIO,
  cooldownMs: DEFAULT_COOLDOWN_MS,
  sampler: defaultSampler,
  now: () => Date.now(),
  timer: null,
  lastSampleAtMs: null,
  heapUsedBytes: null,
  heapCapBytes: null,
  rssBytes: null,
  externalBytes: null,
  arrayBuffersBytes: null,
  cgroupCurrentBytes: null,
  cgroupMaxBytes: null,
  inPressure: false,
  heapInPressure: false,
  cgroupInPressure: false,
  lastPressureAtMs: null,
  lastFireAtMs: null,
  pressureFiresTotal: 0,
};

export function readMemoryPressureEnv(): MemoryPressureOptions {
  const intervalMs = parseNumericEnv(process.env.MAAD_MEMORY_PRESSURE_INTERVAL_MS, DEFAULT_INTERVAL_MS);
  const rawThreshold = parseNumericEnv(process.env.MAAD_MEMORY_PRESSURE_RATIO, DEFAULT_THRESHOLD_RATIO);
  const cooldownMs = parseNumericEnv(process.env.MAAD_MEMORY_PRESSURE_COOLDOWN_MS, DEFAULT_COOLDOWN_MS);
  const thresholdRatio = clamp(rawThreshold, 0, 1);
  return { intervalMs, thresholdRatio, cooldownMs };
}

function parseNumericEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function initMemoryPressureWatcher(opts: MemoryPressureOptions): void {
  stopMemoryPressureWatcher();
  state.intervalMs = opts.intervalMs;
  state.thresholdRatio = clamp(opts.thresholdRatio, 0, 1);
  state.cooldownMs = Math.max(0, opts.cooldownMs);
  state.sampler = opts.sampler ?? defaultSampler;
  state.now = opts.now ?? (() => Date.now());
  state.lastSampleAtMs = null;
  state.heapUsedBytes = null;
  state.heapCapBytes = null;
  state.rssBytes = null;
  state.externalBytes = null;
  state.arrayBuffersBytes = null;
  state.cgroupCurrentBytes = null;
  state.cgroupMaxBytes = null;
  state.inPressure = false;
  state.heapInPressure = false;
  state.cgroupInPressure = false;
  state.lastPressureAtMs = null;
  state.lastFireAtMs = null;
  state.pressureFiresTotal = 0;
  if (opts.intervalMs <= 0) return;
  const timer = setInterval(sampleOnce, opts.intervalMs);
  timer.unref();
  state.timer = timer;
}

export function stopMemoryPressureWatcher(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

/**
 * Run one sample. Public so tests and shutdown paths can probe without
 * waiting for the interval to fire. Never throws.
 */
export function sampleOnce(): void {
  let sample: MemorySample;
  try {
    sample = state.sampler();
  } catch {
    return;
  }
  const nowMs = state.now();
  state.lastSampleAtMs = nowMs;
  state.heapUsedBytes = sample.heapUsedBytes;
  state.heapCapBytes = sample.heapCapBytes;
  state.rssBytes = sample.rssBytes;
  state.externalBytes = sample.externalBytes;
  state.arrayBuffersBytes = sample.arrayBuffersBytes;
  state.cgroupCurrentBytes = sample.cgroupCurrentBytes;
  state.cgroupMaxBytes = sample.cgroupMaxBytes;

  const heapRatio = sample.heapCapBytes > 0 ? sample.heapUsedBytes / sample.heapCapBytes : null;
  const cgroupRatio = sample.cgroupCurrentBytes !== null && sample.cgroupMaxBytes !== null && sample.cgroupMaxBytes > 0
    ? sample.cgroupCurrentBytes / sample.cgroupMaxBytes
    : null;
  const heapInPressure = heapRatio !== null && heapRatio >= state.thresholdRatio;
  const cgroupInPressure = cgroupRatio !== null && cgroupRatio >= state.thresholdRatio;
  const inPressure = heapInPressure || cgroupInPressure;

  if (inPressure) {
    const cooldownPassed = state.lastFireAtMs === null
      || (nowMs - state.lastFireAtMs) >= state.cooldownMs;
    const edgeTrigger = !state.inPressure;
    if (edgeTrigger || cooldownPassed) {
      const reason = cgroupInPressure && !heapInPressure ? 'cgroup' : heapInPressure && !cgroupInPressure ? 'heap' : 'heap+cgroup';
      logger.degraded(
        'engine',
        'memory_pressure',
        `memory pressure (${reason}): heap ${formatRatio(heapRatio)} of cap, cgroup ${formatRatio(cgroupRatio)} of max`,
        {
          reason,
          heap_used_mb: bytesToMb(sample.heapUsedBytes),
          heap_cap_mb: bytesToMb(sample.heapCapBytes),
          heap_ratio: heapRatio !== null ? round3(heapRatio) : null,
          ratio: heapRatio !== null ? round3(heapRatio) : null,
          rss_mb: bytesToMb(sample.rssBytes),
          external_mb: bytesToMb(sample.externalBytes),
          array_buffers_mb: bytesToMb(sample.arrayBuffersBytes),
          cgroup_current_mb: sample.cgroupCurrentBytes !== null ? bytesToMb(sample.cgroupCurrentBytes) : null,
          cgroup_max_mb: sample.cgroupMaxBytes !== null ? bytesToMb(sample.cgroupMaxBytes) : null,
          cgroup_ratio: cgroupRatio !== null ? round3(cgroupRatio) : null,
          threshold_ratio: state.thresholdRatio,
          edge: edgeTrigger,
        },
      );
      state.pressureFiresTotal++;
      state.lastFireAtMs = nowMs;
      state.lastPressureAtMs = nowMs;
    }
    state.inPressure = true;
    state.heapInPressure = heapInPressure;
    state.cgroupInPressure = cgroupInPressure;
  } else {
    state.inPressure = false;
    state.heapInPressure = false;
    state.cgroupInPressure = false;
  }
}

/**
 * Side-effect-free point sample of current memory. Runs the configured
 * sampler and returns the raw byte counts without mutating watcher state or
 * emitting logs. Returns null if the sampler throws. Used by the heavy-op
 * admission gate to decide free-headroom shedding on demand, independent of
 * the watcher's interval. Reuses the configured sampler so a test-injected
 * sampler (via initMemoryPressureWatcher) also drives the gate.
 */
export function sampleMemoryNow(): MemorySample | null {
  try {
    return state.sampler();
  } catch {
    return null;
  }
}

export function getMemoryPressureSnapshot(): MemoryPressureSnapshot {
  const heapUsed = state.heapUsedBytes;
  const heapCap = state.heapCapBytes;
  const heapRatio = heapUsed !== null && heapCap !== null && heapCap > 0
    ? round3(heapUsed / heapCap) : null;
  const cgroupRatio = state.cgroupCurrentBytes !== null && state.cgroupMaxBytes !== null && state.cgroupMaxBytes > 0
    ? round3(state.cgroupCurrentBytes / state.cgroupMaxBytes)
    : null;
  return {
    enabled: state.intervalMs > 0,
    intervalMs: state.intervalMs,
    thresholdRatio: state.thresholdRatio,
    lastSampleAt: state.lastSampleAtMs !== null ? new Date(state.lastSampleAtMs).toISOString() : null,
    heapUsedMb: heapUsed !== null ? bytesToMb(heapUsed) : null,
    heapCapMb: heapCap !== null ? bytesToMb(heapCap) : null,
    heapRatio,
    ratio: heapRatio,
    rssMb: state.rssBytes !== null ? bytesToMb(state.rssBytes) : null,
    externalMb: state.externalBytes !== null ? bytesToMb(state.externalBytes) : null,
    arrayBuffersMb: state.arrayBuffersBytes !== null ? bytesToMb(state.arrayBuffersBytes) : null,
    cgroupCurrentMb: state.cgroupCurrentBytes !== null ? bytesToMb(state.cgroupCurrentBytes) : null,
    cgroupMaxMb: state.cgroupMaxBytes !== null ? bytesToMb(state.cgroupMaxBytes) : null,
    cgroupRatio,
    inPressure: state.inPressure,
    heapInPressure: state.heapInPressure,
    cgroupInPressure: state.cgroupInPressure,
    lastPressureAt: state.lastPressureAtMs !== null ? new Date(state.lastPressureAtMs).toISOString() : null,
    pressureFiresTotal: state.pressureFiresTotal,
  };
}

/**
 * Test hook — resets module state. Never call from production code.
 */
export function __resetMemoryPressureForTests(): void {
  stopMemoryPressureWatcher();
  state.intervalMs = 0;
  state.thresholdRatio = DEFAULT_THRESHOLD_RATIO;
  state.cooldownMs = DEFAULT_COOLDOWN_MS;
  state.sampler = defaultSampler;
  state.now = () => Date.now();
  state.lastSampleAtMs = null;
  state.heapUsedBytes = null;
  state.heapCapBytes = null;
  state.rssBytes = null;
  state.externalBytes = null;
  state.arrayBuffersBytes = null;
  state.cgroupCurrentBytes = null;
  state.cgroupMaxBytes = null;
  state.inPressure = false;
  state.heapInPressure = false;
  state.cgroupInPressure = false;
  state.lastPressureAtMs = null;
  state.lastFireAtMs = null;
  state.pressureFiresTotal = 0;
}

function bytesToMb(b: number): number {
  return Math.round((b / 1024 / 1024) * 10) / 10;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function formatPct(ratio: number): string {
  return (ratio * 100).toFixed(1);
}

function formatRatio(ratio: number | null): string {
  return ratio === null ? 'n/a' : `${formatPct(ratio)}%`;
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function readCgroupMemory(): { current: number | null; max: number | null } {
  const current = readNumberFile('/sys/fs/cgroup/memory.current')
    ?? readNumberFile('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  const max = readCgroupMax('/sys/fs/cgroup/memory.max')
    ?? readCgroupMax('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  return { current, max };
}

function readCgroupMax(file: string): number | null {
  const raw = readTextFile(file);
  if (raw === null || raw === 'max') return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  // cgroup v1 may report a huge host-level sentinel when no limit is set.
  if (parsed > Number.MAX_SAFE_INTEGER / 2) return null;
  return parsed;
}

function readNumberFile(file: string): number | null {
  const raw = readTextFile(file);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readTextFile(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}
