import { describe, it, expect } from 'vitest';
import {
  SessionRateLimiter,
  isMutatingTool,
  readRateLimitEnv,
} from '../../src/mcp/rate-limit.js';

// ---- R1 — writes/sec burst -------------------------------------------------

describe('R1 — writes/sec burst', () => {
  it('10 rapid writes succeed; 11th within same second is rejected', () => {
    let fakeNow = 1_000_000;
    const rl = new SessionRateLimiter({
      writesPerSec: 10,
      writesPerMin: 600,  // keep min cap out of the way
      now: () => fakeNow,
    });

    for (let i = 0; i < 10; i++) {
      expect(rl.tryAcquireWrite('s1')).toBeNull();
    }

    const rejection = rl.tryAcquireWrite('s1');
    expect(rejection).not.toBeNull();
    expect(rejection!.reason).toBe('writes_per_sec');
    expect(rejection!.limit).toBe(10);
    expect(rejection!.retryAfterMs).toBeGreaterThan(0);

    // After enough time for one token to refill (at 10/sec, 100ms = 1 token)
    fakeNow += 150;
    expect(rl.tryAcquireWrite('s1')).toBeNull();
  });
});

// ---- R2 — writes/min cap ---------------------------------------------------

describe('R2 — writes/min cap', () => {
  it('60th write succeeds; 61st fails with writes_per_min; refills after 60s', () => {
    let fakeNow = 0;
    const rl = new SessionRateLimiter({
      writesPerSec: 1000,   // big enough that the per-sec bucket never fires
      writesPerMin: 60,
      now: () => fakeNow,
    });

    // Drain 60 tokens rapidly. 60 calls × 1ms = 60ms, too short for meaningful
    // refill at 60/min = 1/sec (60ms generates 0.06 tokens, rounds away).
    for (let i = 0; i < 60; i++) {
      expect(rl.tryAcquireWrite('s1')).toBeNull();
      fakeNow += 1;
    }

    const rejection = rl.tryAcquireWrite('s1');
    expect(rejection).not.toBeNull();
    expect(rejection!.reason).toBe('writes_per_min');
    expect(rejection!.retryAfterMs).toBeGreaterThan(0);

    // Advance mock clock 60s — the minute bucket fully refills.
    fakeNow += 60_000;
    expect(rl.tryAcquireWrite('s1')).toBeNull();
  });
});

// ---- R3 — concurrent cap ---------------------------------------------------

describe('R3 — concurrent cap', () => {
  it('5 concurrent in-flight; 6th rejects; 6th succeeds after one releases', () => {
    const rl = new SessionRateLimiter({ concurrent: 5 });

    const slots = [] as Array<{ release: () => void }>;
    for (let i = 0; i < 5; i++) {
      const r = rl.tryAcquireConcurrent('s1');
      expect(r.ok).toBe(true);
      if (r.ok) slots.push({ release: r.release });
    }

    const sixth = rl.tryAcquireConcurrent('s1');
    expect(sixth.ok).toBe(false);
    if (!sixth.ok) {
      expect(sixth.rejection.reason).toBe('concurrent');
      expect(sixth.rejection.retryAfterMs).toBeNull();
    }

    // Release one slot — sixth call now succeeds.
    slots[0]!.release();
    const retry = rl.tryAcquireConcurrent('s1');
    expect(retry.ok).toBe(true);
  });
});

// ---- R4 — payload cap ------------------------------------------------------

describe('R4 — payload cap', () => {
  it('rejects payloads over limit', () => {
    const rl = new SessionRateLimiter({ payloadBytes: 1024 });

    expect(rl.checkPayloadSize(512)).toBeNull();
    expect(rl.checkPayloadSize(1024)).toBeNull();

    const rejection = rl.checkPayloadSize(1025);
    expect(rejection).not.toBeNull();
    expect(rejection!.reason).toBe('payload_too_large');
    expect(rejection!.limit).toBe(1024);
    expect(rejection!.retryAfterMs).toBeNull();
  });
});

// ---- R5 — reads exempt from write bucket -----------------------------------

describe('R5 — reads exempt from write bucket', () => {
  it('isMutatingTool correctly classifies tools', () => {
    expect(isMutatingTool('maad_create')).toBe(true);
    expect(isMutatingTool('maad_update')).toBe(true);
    expect(isMutatingTool('maad_bulk_create')).toBe(true);
    expect(isMutatingTool('maad_bulk_update')).toBe(true);
    expect(isMutatingTool('maad_summary')).toBe(false);
    expect(isMutatingTool('maad_get')).toBe(false);
    expect(isMutatingTool('maad_query')).toBe(false);
  });

  it('exhausting the write bucket does not affect concurrent cap', () => {
    const rl = new SessionRateLimiter({ writesPerSec: 2, writesPerMin: 2, concurrent: 5 });

    // Drain writes
    expect(rl.tryAcquireWrite('s1')).toBeNull();
    expect(rl.tryAcquireWrite('s1')).toBeNull();
    expect(rl.tryAcquireWrite('s1')).not.toBeNull();  // both drained

    // Concurrent slots are separate and still available
    for (let i = 0; i < 5; i++) {
      expect(rl.tryAcquireConcurrent('s1').ok).toBe(true);
    }
  });
});

// ---- R6 — session isolation ------------------------------------------------

describe('R6 — session isolation', () => {
  it('two sessions have independent write buckets', () => {
    const rl = new SessionRateLimiter({ writesPerSec: 2, writesPerMin: 2 });

    // Session A drains
    expect(rl.tryAcquireWrite('sessionA')).toBeNull();
    expect(rl.tryAcquireWrite('sessionA')).toBeNull();
    expect(rl.tryAcquireWrite('sessionA')).not.toBeNull();

    // Session B still has full bucket
    expect(rl.tryAcquireWrite('sessionB')).toBeNull();
    expect(rl.tryAcquireWrite('sessionB')).toBeNull();
    expect(rl.tryAcquireWrite('sessionB')).not.toBeNull();
  });

  it('two sessions have independent concurrent caps', () => {
    const rl = new SessionRateLimiter({ concurrent: 3 });

    for (let i = 0; i < 3; i++) rl.tryAcquireConcurrent('sA');
    expect(rl.tryAcquireConcurrent('sA').ok).toBe(false);

    // sB is clean
    for (let i = 0; i < 3; i++) {
      expect(rl.tryAcquireConcurrent('sB').ok).toBe(true);
    }
  });
});

// ---- R7 — disable env ------------------------------------------------------

describe('R7 — disable env', () => {
  it('disabled limiter never rejects', () => {
    const rl = new SessionRateLimiter({
      writesPerSec: 1,
      writesPerMin: 1,
      concurrent: 1,
      payloadBytes: 100,
      disabled: true,
    });

    // All checks pass regardless of limits
    for (let i = 0; i < 50; i++) {
      expect(rl.tryAcquireWrite('s1')).toBeNull();
      expect(rl.tryAcquireConcurrent('s1').ok).toBe(true);
    }
    expect(rl.checkPayloadSize(1_000_000)).toBeNull();
  });

  it('MAAD_RL_DISABLE=1 is picked up by readRateLimitEnv', () => {
    const original = process.env.MAAD_RL_DISABLE;
    try {
      process.env.MAAD_RL_DISABLE = '1';
      expect(readRateLimitEnv().disabled).toBe(true);
    } finally {
      if (original === undefined) delete process.env.MAAD_RL_DISABLE;
      else process.env.MAAD_RL_DISABLE = original;
    }
  });
});

// ---- R8 — session disposal -------------------------------------------------

describe('R8 — session disposal', () => {
  it('disposeSession clears per-session state; new activity gets fresh buckets', () => {
    const rl = new SessionRateLimiter({ writesPerSec: 2, writesPerMin: 2 });

    // Drain sessionA
    expect(rl.tryAcquireWrite('sessionA')).toBeNull();
    expect(rl.tryAcquireWrite('sessionA')).toBeNull();
    expect(rl.tryAcquireWrite('sessionA')).not.toBeNull();

    // Dispose
    rl.disposeSession('sessionA');

    // A fresh "sessionA" has full bucket again
    expect(rl.tryAcquireWrite('sessionA')).toBeNull();
    expect(rl.tryAcquireWrite('sessionA')).toBeNull();
  });

  it('disposeSession releases in-flight counters', () => {
    const rl = new SessionRateLimiter({ concurrent: 3 });
    rl.tryAcquireConcurrent('s1');
    rl.tryAcquireConcurrent('s1');
    expect(rl.inFlightFor('s1')).toBe(2);

    rl.disposeSession('s1');
    expect(rl.inFlightFor('s1')).toBe(0);
  });
});

// ---- Additional: env parsing and totals ------------------------------------

describe('env parsing', () => {
  it('reads numeric values from env', () => {
    const original = {
      sec: process.env.MAAD_RL_WRITES_PER_SEC,
      min: process.env.MAAD_RL_WRITES_PER_MIN,
      conc: process.env.MAAD_RL_CONCURRENT,
      pb: process.env.MAAD_RL_PAYLOAD_BYTES,
    };
    try {
      process.env.MAAD_RL_WRITES_PER_SEC = '20';
      process.env.MAAD_RL_WRITES_PER_MIN = '120';
      process.env.MAAD_RL_CONCURRENT = '10';
      process.env.MAAD_RL_PAYLOAD_BYTES = '2048';

      const cfg = readRateLimitEnv();
      expect(cfg.writesPerSec).toBe(20);
      expect(cfg.writesPerMin).toBe(120);
      expect(cfg.concurrent).toBe(10);
      expect(cfg.payloadBytes).toBe(2048);
    } finally {
      process.env.MAAD_RL_WRITES_PER_SEC = original.sec;
      process.env.MAAD_RL_WRITES_PER_MIN = original.min;
      process.env.MAAD_RL_CONCURRENT = original.conc;
      process.env.MAAD_RL_PAYLOAD_BYTES = original.pb;
    }
  });

  it('ignores non-numeric env values', () => {
    const original = process.env.MAAD_RL_WRITES_PER_SEC;
    try {
      process.env.MAAD_RL_WRITES_PER_SEC = 'garbage';
      expect(readRateLimitEnv().writesPerSec).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.MAAD_RL_WRITES_PER_SEC;
      else process.env.MAAD_RL_WRITES_PER_SEC = original;
    }
  });
});

describe('totalInFlight', () => {
  it('aggregates across sessions', () => {
    const rl = new SessionRateLimiter({ concurrent: 10 });
    rl.tryAcquireConcurrent('s1');
    rl.tryAcquireConcurrent('s1');
    rl.tryAcquireConcurrent('s2');
    expect(rl.totalInFlight()).toBe(3);
  });
});
