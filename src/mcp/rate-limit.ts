// ============================================================================
// SessionRateLimiter — per-session token buckets + payload cap.
//
// Three independent buckets per session:
//   writes/sec   capacity=10, refill=10 tokens/sec  (mutating tools only)
//   writes/min   capacity=60, refill=60 tokens/60s  (mutating tools only)
//   concurrent   semaphore, cap=5                   (any tool in flight)
//
// Plus one per-request cap:
//   payload_too_large  ≥ 1 MiB serialized args
//
// Read-only tools are exempt from the write buckets but still count against
// `concurrent` and `payload`. Refill is lazy (computed on tryAcquire*), no
// background timers. All knobs env-tunable (MAAD_RL_*). Kill switch:
// MAAD_RL_DISABLE=1.
// ============================================================================

// ---- Token bucket ----------------------------------------------------------

interface TokenBucket {
  capacity: number;
  refillPerSec: number;
  tokens: number;
  lastRefillMs: number;
}

function newBucket(capacity: number, refillPerSec: number, nowMs: number): TokenBucket {
  return { capacity, refillPerSec, tokens: capacity, lastRefillMs: nowMs };
}

function refill(bucket: TokenBucket, nowMs: number): void {
  const elapsedSec = (nowMs - bucket.lastRefillMs) / 1000;
  if (elapsedSec <= 0) return;
  const added = elapsedSec * bucket.refillPerSec;
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + added);
  bucket.lastRefillMs = nowMs;
}

function msUntilOneToken(bucket: TokenBucket, nowMs: number): number {
  refill(bucket, nowMs);
  if (bucket.tokens >= 1) return 0;
  const deficit = 1 - bucket.tokens;
  return Math.ceil((deficit / bucket.refillPerSec) * 1000);
}

// ---- Config ----------------------------------------------------------------

export interface RateLimitConfig {
  writesPerSec: number;
  writesPerMin: number;
  concurrent: number;
  payloadBytes: number;
  disabled: boolean;
  now: () => number;  // injectable clock for tests
}

const DEFAULTS: Omit<RateLimitConfig, 'now'> = {
  writesPerSec: 10,
  writesPerMin: 60,
  concurrent: 5,
  payloadBytes: 1_048_576,
  disabled: false,
};

export function readRateLimitEnv(): Partial<RateLimitConfig> {
  const env = process.env;
  const out: Partial<RateLimitConfig> = {};
  const num = (s: string | undefined) => (s && !Number.isNaN(Number(s)) ? Number(s) : undefined);
  const wps = num(env.MAAD_RL_WRITES_PER_SEC); if (wps !== undefined) out.writesPerSec = wps;
  const wpm = num(env.MAAD_RL_WRITES_PER_MIN); if (wpm !== undefined) out.writesPerMin = wpm;
  const conc = num(env.MAAD_RL_CONCURRENT); if (conc !== undefined) out.concurrent = conc;
  const pb = num(env.MAAD_RL_PAYLOAD_BYTES); if (pb !== undefined) out.payloadBytes = pb;
  if (env.MAAD_RL_DISABLE === '1') out.disabled = true;
  return out;
}

// ---- Rejection shape -------------------------------------------------------

export type RateLimitReason = 'writes_per_sec' | 'writes_per_min' | 'concurrent' | 'payload_too_large';

export interface RateLimitRejection {
  reason: RateLimitReason;
  limit: number;
  retryAfterMs: number | null;  // null for payload (resend won't help) and concurrent (retry when slot frees)
}

// ---- Mutating tool registry ------------------------------------------------

const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'maad_create',
  'maad_update',
  'maad_bulk_create',
  'maad_bulk_update',
  // Note: maad_delete is an engine operation, not currently an MCP tool.
  // Indexing ops (reindex, indexAll) are admin tools; they ARE mutating but
  // are gated by role; we count them against the write bucket for consistency.
  'maad_reindex',
]);

export function isMutatingTool(toolName: string): boolean {
  return MUTATING_TOOLS.has(toolName);
}

// ---- Limiter class ---------------------------------------------------------

export class SessionRateLimiter {
  private config: RateLimitConfig;
  private writesSec = new Map<string, TokenBucket>();
  private writesMin = new Map<string, TokenBucket>();
  private inFlight = new Map<string, number>();

  constructor(opts: Partial<RateLimitConfig> = {}) {
    this.config = {
      ...DEFAULTS,
      now: () => Date.now(),
      ...opts,
    };
  }

  /**
   * Per-request payload size gate. Returns null on success or a rejection
   * describing the breach. Runs before anything else — oversize args waste
   * compute.
   */
  checkPayloadSize(bytes: number): RateLimitRejection | null {
    if (this.config.disabled) return null;
    if (bytes <= this.config.payloadBytes) return null;
    return {
      reason: 'payload_too_large',
      limit: this.config.payloadBytes,
      retryAfterMs: null,
    };
  }

  /**
   * Acquire a concurrent-in-flight slot. Returns { release } on success or
   * a rejection. ALL tool calls (reads and writes) use this cap.
   */
  tryAcquireConcurrent(sessionId: string): { ok: true; release: () => void } | { ok: false; rejection: RateLimitRejection } {
    if (this.config.disabled) return { ok: true, release: () => {} };

    const current = this.inFlight.get(sessionId) ?? 0;
    if (current >= this.config.concurrent) {
      return {
        ok: false,
        rejection: { reason: 'concurrent', limit: this.config.concurrent, retryAfterMs: null },
      };
    }
    this.inFlight.set(sessionId, current + 1);
    return {
      ok: true,
      release: () => {
        const c = this.inFlight.get(sessionId) ?? 0;
        if (c <= 1) this.inFlight.delete(sessionId);
        else this.inFlight.set(sessionId, c - 1);
      },
    };
  }

  /**
   * Consume one token each from writes/sec and writes/min. Only called for
   * mutating tools. Returns null on success or a rejection identifying which
   * bucket failed.
   */
  tryAcquireWrite(sessionId: string): RateLimitRejection | null {
    if (this.config.disabled) return null;
    const nowMs = this.config.now();

    let wps = this.writesSec.get(sessionId);
    if (!wps) {
      wps = newBucket(this.config.writesPerSec, this.config.writesPerSec, nowMs);
      this.writesSec.set(sessionId, wps);
    }
    refill(wps, nowMs);

    let wpm = this.writesMin.get(sessionId);
    if (!wpm) {
      wpm = newBucket(this.config.writesPerMin, this.config.writesPerMin / 60, nowMs);
      this.writesMin.set(sessionId, wpm);
    }
    refill(wpm, nowMs);

    if (wps.tokens < 1) {
      return {
        reason: 'writes_per_sec',
        limit: this.config.writesPerSec,
        retryAfterMs: msUntilOneToken(wps, nowMs),
      };
    }
    if (wpm.tokens < 1) {
      return {
        reason: 'writes_per_min',
        limit: this.config.writesPerMin,
        retryAfterMs: msUntilOneToken(wpm, nowMs),
      };
    }

    wps.tokens -= 1;
    wpm.tokens -= 1;
    return null;
  }

  /**
   * Total in-flight requests across all sessions. Used by the H7 graceful
   * shutdown drain loop.
   */
  totalInFlight(): number {
    let total = 0;
    for (const n of this.inFlight.values()) total += n;
    return total;
  }

  /** Discard all per-session state for `sessionId`. Called on disconnect. */
  disposeSession(sessionId: string): void {
    this.writesSec.delete(sessionId);
    this.writesMin.delete(sessionId);
    this.inFlight.delete(sessionId);
  }

  /** Test helper — peek at in-flight count for a single session. */
  inFlightFor(sessionId: string): number {
    return this.inFlight.get(sessionId) ?? 0;
  }

  /** Test helper — peek at current config (for assertions). */
  getConfig(): Readonly<RateLimitConfig> {
    return this.config;
  }
}

// ---- Module-level singleton -------------------------------------------------

let limiter: SessionRateLimiter = new SessionRateLimiter();

export function initRateLimiter(opts: Partial<RateLimitConfig>): void {
  limiter = new SessionRateLimiter(opts);
}

export function getRateLimiter(): SessionRateLimiter {
  return limiter;
}
