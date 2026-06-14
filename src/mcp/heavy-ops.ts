// ============================================================================
// HeavyOpGuard — engine self-defense against maintenance-op load storms.
//
// A small set of maintenance ops (reindex / reload / schema / summary) are
// disproportionately expensive: each can allocate tens of MB of transient V8
// heap. A misbehaving background caller that hammers these in a tight loop can
// drive heap past the cap and OOM-crash-loop the engine — the process dies
// rather than shedding the excess work. This guard makes the engine refuse or
// coalesce instead of die. Two independent, false-positive-cheap defenses:
//
//   1. Free-headroom admission gate. Before a heavy op runs, sample current
//      memory and refuse (retryable OVERLOADED) when free heap — or free
//      cgroup budget, whichever is tighter — is below a floor. Keyed on
//      ABSOLUTE free bytes, not a ratio: the op cost is roughly absolute
//      (~tens of MB) regardless of total dataset size, so a byte floor
//      protects a 256 MB engine without false-tripping a legitimately large
//      resident working set that simply needs its own headroom. Refusal is
//      retryable, so a false positive only adds latency — never data loss.
//
//   2. Single-flight coalescing. Identical heavy ops already in flight for the
//      same engine fold into the leader's result instead of each running their
//      own rebuild. These ops are idempotent, so sharing one result is safe
//      and collapses a concurrent duplicate storm to a single execution.
//
//   3. Process-global concurrency cap. The pool runs one engine PER PROJECT in
//      a single process, so heavy ops on different projects run on different
//      write mutexes and allocate heap concurrently in the SAME process. A
//      global semaphore bounds the number of heavy ops executing at once
//      across all engines, capping concurrent heavy-memory allocation; calls
//      over the cap fast-fail (retryable) instead of piling on.
//
//   4. Circuit breaker. After repeated memory sheds the breaker opens and
//      fast-fails ALL heavy ops for a cooldown, regardless of the instant
//      memory reading. This adds temporal hysteresis: it breaks the OOM→retry
//      self-reinforcement even when a caller ignores retryAfterMs and hot-
//      retries, and gives GC an uninterrupted window to recover. Process-wide,
//      because the heap it protects is process-wide.
//
// The gate handles back-to-back sequential repetition (heap climbs → ops shed
// before the cap); single-flight handles concurrent duplicates; the cap bounds
// concurrent allocation across projects; the breaker dampens hot-retry loops.
// Together they make a heavy-op storm survivable on the existing heap with no
// memory increase. Disabled wholesale via MAAD_HEAVY_OP_GUARD_DISABLE=1.
// ============================================================================

import { sampleMemoryNow } from './memory-pressure.js';

// The maintenance ops subject to the guard. Kept explicit (not derived from
// kinds.ts) because "heavy" is a memory-cost property, orthogonal to read/write
// classification: schema/summary are reads, reindex/reload are writes.
export const HEAVY_OPS: ReadonlySet<string> = new Set([
  'maad_reindex',
  'maad_reload',
  'maad_schema',
  'maad_summary',
]);

const DEFAULT_MIN_FREE_HEAP_BYTES = 96 * 1024 * 1024; // ~1.7x a measured worst-case op
const DEFAULT_RETRY_AFTER_MS = 1_000;
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_BREAKER_THRESHOLD = 3;
const DEFAULT_BREAKER_COOLDOWN_MS = 5_000;

export interface HeavyOpGuardConfig {
  disabled: boolean;
  minFreeHeapBytes: number;
  retryAfterMs: number;
  /** Max heavy ops executing at once across the whole process; 0 disables. */
  maxConcurrent: number;
  /** Consecutive memory sheds that trip the breaker open; 0 disables. */
  breakerThreshold: number;
  /** How long the breaker stays open once tripped. */
  breakerCooldownMs: number;
  /** Injectable point sampler; defaults to the live memory-pressure sampler. */
  probe: () => { heapUsedBytes: number; heapCapBytes: number; cgroupCurrentBytes: number | null; cgroupMaxBytes: number | null } | null;
}

const DEFAULTS: Omit<HeavyOpGuardConfig, 'probe'> = {
  disabled: false,
  minFreeHeapBytes: DEFAULT_MIN_FREE_HEAP_BYTES,
  retryAfterMs: DEFAULT_RETRY_AFTER_MS,
  maxConcurrent: DEFAULT_MAX_CONCURRENT,
  breakerThreshold: DEFAULT_BREAKER_THRESHOLD,
  breakerCooldownMs: DEFAULT_BREAKER_COOLDOWN_MS,
};

export function readHeavyOpGuardEnv(): Partial<HeavyOpGuardConfig> {
  const env = process.env;
  const out: Partial<HeavyOpGuardConfig> = {};
  if (env.MAAD_HEAVY_OP_GUARD_DISABLE === '1') out.disabled = true;
  const mb = Number(env.MAAD_HEAVY_OP_MIN_FREE_HEAP_MB);
  if (Number.isFinite(mb) && mb >= 0) out.minFreeHeapBytes = mb * 1024 * 1024;
  const retry = Number(env.MAAD_HEAVY_OP_RETRY_AFTER_MS);
  if (Number.isFinite(retry) && retry >= 0) out.retryAfterMs = retry;
  const maxc = Number(env.MAAD_HEAVY_OP_MAX_CONCURRENT);
  if (Number.isFinite(maxc) && maxc >= 0) out.maxConcurrent = maxc;
  const bt = Number(env.MAAD_HEAVY_OP_BREAKER_THRESHOLD);
  if (Number.isFinite(bt) && bt >= 0) out.breakerThreshold = bt;
  const bc = Number(env.MAAD_HEAVY_OP_BREAKER_COOLDOWN_MS);
  if (Number.isFinite(bc) && bc >= 0) out.breakerCooldownMs = bc;
  return out;
}

export type HeavyOpShedReason = 'free_heap' | 'free_cgroup' | 'concurrency' | 'breaker_open';

export interface HeavyOpRejection {
  reason: HeavyOpShedReason;
  retryAfterMs: number;
  freeMb?: number;
  minFreeMb?: number;
  limit?: number;
}

export interface HeavyOpGuardSnapshot {
  enabled: boolean;
  minFreeHeapMb: number;
  maxConcurrent: number;
  inFlight: number;
  breakerOpen: boolean;
  shedTotal: number;
  coalescedTotal: number;
  concurrencyRejectedTotal: number;
  breakerTrippedTotal: number;
  breakerRejectedTotal: number;
  lastShedAt: string | null;
}

/** Stable key for single-flight: identical (project, tool, args) coalesce. */
export function heavyOpKey(project: string, tool: string, args: Record<string, unknown> | undefined): string {
  return `${project} ${tool} ${stableStringify(args ?? {})}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export class HeavyOpGuard {
  private config: HeavyOpGuardConfig;
  private inFlightKeys = new Map<string, Promise<unknown>>();
  private executing = 0;
  private consecutiveSheds = 0;
  private breakerOpenUntilMs: number | null = null;
  private shedTotal = 0;
  private coalescedTotal = 0;
  private concurrencyRejectedTotal = 0;
  private breakerTrippedTotal = 0;
  private breakerRejectedTotal = 0;
  private lastShedAtMs: number | null = null;
  private now: () => number;

  constructor(opts: Partial<HeavyOpGuardConfig> = {}, now: () => number = () => Date.now()) {
    this.config = { ...DEFAULTS, probe: () => sampleMemoryNow(), ...opts };
    this.now = now;
  }

  isHeavy(tool: string): boolean {
    return !this.config.disabled && HEAVY_OPS.has(tool);
  }

  /**
   * Admission check, in order: (1) circuit breaker — if open, fast-fail
   * without sampling; (2) free-headroom gate — shed when the tighter of free
   * heap / free cgroup budget is below the floor. Returns a rejection or null
   * to admit. Repeated sheds trip the breaker open for a cooldown; the first
   * admit resets the shed streak. Never throws — an unreadable sample admits
   * (fail-open: the guard is a backstop, not a correctness boundary).
   */
  checkAdmission(): HeavyOpRejection | null {
    if (this.config.disabled) return null;
    const nowMs = this.now();

    if (this.breakerOpenUntilMs !== null) {
      if (nowMs < this.breakerOpenUntilMs) {
        this.breakerRejectedTotal++;
        return { reason: 'breaker_open', retryAfterMs: Math.max(0, this.breakerOpenUntilMs - nowMs) };
      }
      // Cooldown elapsed — half-open: let this call through to a fresh sample.
      this.breakerOpenUntilMs = null;
    }

    const sample = this.config.probe();
    if (!sample) return null;

    const heapFree = sample.heapCapBytes > 0 ? sample.heapCapBytes - sample.heapUsedBytes : null;
    const cgroupFree = sample.cgroupMaxBytes !== null && sample.cgroupCurrentBytes !== null && sample.cgroupMaxBytes > 0
      ? sample.cgroupMaxBytes - sample.cgroupCurrentBytes
      : null;

    if (heapFree !== null && heapFree < this.config.minFreeHeapBytes) {
      return this.shed('free_heap', heapFree, nowMs);
    }
    if (cgroupFree !== null && cgroupFree < this.config.minFreeHeapBytes) {
      return this.shed('free_cgroup', cgroupFree, nowMs);
    }
    this.consecutiveSheds = 0;
    return null;
  }

  private shed(reason: 'free_heap' | 'free_cgroup', freeBytes: number, nowMs: number): HeavyOpRejection {
    this.shedTotal++;
    this.lastShedAtMs = nowMs;
    this.consecutiveSheds++;
    if (this.config.breakerThreshold > 0 && this.consecutiveSheds >= this.config.breakerThreshold) {
      this.breakerOpenUntilMs = nowMs + this.config.breakerCooldownMs;
      this.breakerTrippedTotal++;
      this.consecutiveSheds = 0;
    }
    return {
      reason,
      freeMb: bytesToMb(freeBytes),
      minFreeMb: bytesToMb(this.config.minFreeHeapBytes),
      retryAfterMs: this.config.retryAfterMs,
    };
  }

  /**
   * Acquire a process-global concurrency slot for an executing heavy op.
   * Returns a release handle, or a rejection when the cap is reached. Only the
   * single-flight LEADER should acquire — followers share the leader's result
   * and never execute, so they consume no slot. `maxConcurrent: 0` disables.
   */
  tryAcquireConcurrencySlot(): { ok: true; release: () => void } | { ok: false; rejection: HeavyOpRejection } {
    if (this.config.disabled || this.config.maxConcurrent <= 0) {
      return { ok: true, release: () => {} };
    }
    if (this.executing >= this.config.maxConcurrent) {
      this.concurrencyRejectedTotal++;
      return {
        ok: false,
        rejection: { reason: 'concurrency', limit: this.config.maxConcurrent, retryAfterMs: this.config.retryAfterMs },
      };
    }
    this.executing++;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.executing = Math.max(0, this.executing - 1);
      },
    };
  }

  /**
   * Single-flight: if an identical op is already running, await and share its
   * result instead of starting a second. The leader runs `run`; followers
   * resolve/reject with the leader's outcome. The in-flight slot clears when
   * the leader settles.
   */
  async runCoalesced<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (this.config.disabled) return run();
    const existing = this.inFlightKeys.get(key) as Promise<T> | undefined;
    if (existing) {
      this.coalescedTotal++;
      return existing;
    }
    const p = (async () => run())();
    this.inFlightKeys.set(key, p);
    try {
      return await p;
    } finally {
      this.inFlightKeys.delete(key);
    }
  }

  snapshot(): HeavyOpGuardSnapshot {
    return {
      enabled: !this.config.disabled,
      minFreeHeapMb: bytesToMb(this.config.minFreeHeapBytes),
      maxConcurrent: this.config.maxConcurrent,
      inFlight: this.executing,
      breakerOpen: this.breakerOpenUntilMs !== null && this.now() < this.breakerOpenUntilMs,
      shedTotal: this.shedTotal,
      coalescedTotal: this.coalescedTotal,
      concurrencyRejectedTotal: this.concurrencyRejectedTotal,
      breakerTrippedTotal: this.breakerTrippedTotal,
      breakerRejectedTotal: this.breakerRejectedTotal,
      lastShedAt: this.lastShedAtMs !== null ? new Date(this.lastShedAtMs).toISOString() : null,
    };
  }
}

function bytesToMb(b: number): number {
  return Math.round((b / 1024 / 1024) * 10) / 10;
}

// ---- Module-level singleton (mirrors the rate limiter) ----------------------

let guard = new HeavyOpGuard();

export function initHeavyOpGuard(opts: Partial<HeavyOpGuardConfig> = {}): void {
  guard = new HeavyOpGuard(opts);
}

export function getHeavyOpGuard(): HeavyOpGuard {
  return guard;
}
