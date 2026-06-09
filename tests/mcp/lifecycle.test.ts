// ============================================================================
// 0.4.1 H7 — per-request timeout + graceful shutdown
//
// Tests the shutdown state machine directly (no real signals) and the
// withEngine request-timeout path. Avoids process.exit by passing an
// injectable `exit` function that captures the exit code.
// ============================================================================

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import path from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EnginePool } from '../../src/instance/pool.js';
import { SessionRegistry, __resetStdioSessionId } from '../../src/instance/session.js';
import type { InstanceConfig } from '../../src/instance/config.js';
import type { InstanceCtx } from '../../src/mcp/ctx.js';
import { withEngine } from '../../src/mcp/with-session.js';
import {
  beginShutdown,
  getShutdownState,
  isShuttingDown,
  __resetShutdownState,
} from '../../src/mcp/shutdown.js';
import { SessionRateLimiter, initRateLimiter } from '../../src/mcp/rate-limit.js';

const createdDirs: string[] = [];

function makeTempDir(label = 'proj'): string {
  const dir = mkdtempSync(path.join(tmpdir(), `maad-lifecycle-${label}-`));
  createdDirs.push(dir);
  return dir;
}

function makeCtx(projectPath: string): InstanceCtx {
  const instance: InstanceConfig = {
    name: 'lctest',
    source: 'file',
    projects: [{ name: 'alpha', path: projectPath, role: 'admin' }],
  };
  return { instance, pool: new EnginePool(instance), sessions: new SessionRegistry(instance) };
}

function parseResponse(resp: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(resp.content[0]!.text);
}

beforeEach(() => {
  __resetShutdownState();
  __resetStdioSessionId();
  // Restore generous defaults — some tests set tight limits.
  initRateLimiter({ concurrent: 100, writesPerSec: 100, writesPerMin: 1000 });
});

afterEach(async () => {
  delete process.env.MAAD_REQUEST_TIMEOUT_MS;
  __resetShutdownState();
  await new Promise((r) => setTimeout(r, 30));
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* windows */
    }
  }
});

// ---- S1 — request timeout fires --------------------------------------------

describe('S1 — request timeout fires', () => {
  it('returns REQUEST_TIMEOUT when handler exceeds MAAD_REQUEST_TIMEOUT_MS', async () => {
    const dir = makeTempDir('s1');
    const ctx = makeCtx(dir);
    ctx.sessions.create('sid-1');
    ctx.sessions.bindSingle('sid-1', 'alpha');

    process.env.MAAD_REQUEST_TIMEOUT_MS = '100';

    const resp = await withEngine(ctx, { sessionId: 'sid-1' }, 'maad_summary', {}, async () => {
      await new Promise((r) => setTimeout(r, 500));
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: {} }) }] };
    });

    const body = parseResponse(resp);
    expect(body.ok).toBe(false);
    expect(body.errors[0].code).toBe('REQUEST_TIMEOUT');
    expect(body.errors[0].details.limitMs).toBe(100);
    // Wait for slow handler to finish before next test (lets overrun log fire).
    await new Promise((r) => setTimeout(r, 450));
    await ctx.pool.closeAll();
  }, 10_000);

  it('fast handlers complete well under the timeout', async () => {
    const dir = makeTempDir('s1-fast');
    const ctx = makeCtx(dir);
    ctx.sessions.create('sid-1');
    ctx.sessions.bindSingle('sid-1', 'alpha');

    process.env.MAAD_REQUEST_TIMEOUT_MS = '500';

    const resp = await withEngine(ctx, { sessionId: 'sid-1' }, 'maad_summary', {}, async () => {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { fast: true } }) }] };
    });

    const body = parseResponse(resp);
    expect(body.ok).toBe(true);
    expect(body.data.fast).toBe(true);
    await ctx.pool.closeAll();
  });
});

// ---- S2 — graceful drain completes -----------------------------------------

describe('S2 — graceful drain completes', () => {
  it('drains in-flight requests, runs cleanup, exits with code 0', async () => {
    const dir = makeTempDir('s2');
    const ctx = makeCtx(dir);
    ctx.sessions.create('sid-1');
    ctx.sessions.bindSingle('sid-1', 'alpha');
    // Warm the pool so closeAll has something to close
    await ctx.pool.get('alpha');

    let exitCode: number | null = null;
    const rl = new SessionRateLimiter({ concurrent: 5 });
    // Force one in-flight slot, then release it shortly after shutdown begins
    // to simulate a request finishing cleanly.
    const slot = rl.tryAcquireConcurrent('sid-1');
    expect(slot.ok).toBe(true);

    const drainPromise = beginShutdown(
      { pool: ctx.pool, rateLimiter: rl },
      {
        shutdownTimeoutMs: 2_000,
        exit: (code) => { exitCode = code; },
      },
    );

    expect(isShuttingDown()).toBe(true);
    expect(getShutdownState()).toBe('draining');

    // Let drain loop poll once, then release slot → drain completes.
    setTimeout(() => { if (slot.ok) slot.release(); }, 80);

    await drainPromise;

    expect(exitCode).toBe(0);
    expect(getShutdownState()).toBe('exiting');
  });
});

// ---- S3 — drain timeout forces exit ----------------------------------------

describe('S3 — drain timeout forces exit', () => {
  it('exits with code 1 when drain exceeds grace window', async () => {
    const dir = makeTempDir('s3');
    const ctx = makeCtx(dir);

    let exitCode: number | null = null;
    const rl = new SessionRateLimiter({ concurrent: 5 });
    // Hold a slot for the entire drain window (never released).
    rl.tryAcquireConcurrent('sid-stuck');

    const started = Date.now();
    await beginShutdown(
      { pool: ctx.pool, rateLimiter: rl },
      {
        shutdownTimeoutMs: 200,
        exit: (code) => { exitCode = code; },
      },
    );
    const elapsed = Date.now() - started;

    expect(exitCode).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(800);
  });
});

// ---- S4 — new requests during drain are rejected ---------------------------

describe('S4 — new requests during drain are rejected', () => {
  it('withEngine returns SHUTTING_DOWN while state is draining', async () => {
    const dir = makeTempDir('s4');
    const ctx = makeCtx(dir);
    ctx.sessions.create('sid-1');
    ctx.sessions.bindSingle('sid-1', 'alpha');

    let exitCode: number | null = null;
    const rl = new SessionRateLimiter({ concurrent: 5 });
    // Hold a slot so drain doesn't finish before we issue the call.
    const slot = rl.tryAcquireConcurrent('sid-stuck');

    // Start shutdown — don't await. Use a generous window.
    const drainPromise = beginShutdown(
      { pool: ctx.pool, rateLimiter: rl },
      {
        shutdownTimeoutMs: 1_000,
        exit: (code) => { exitCode = code; },
      },
    );

    // Let the state flip take hold
    await new Promise((r) => setTimeout(r, 20));
    expect(getShutdownState()).toBe('draining');

    const resp = await withEngine(ctx, { sessionId: 'sid-1' }, 'maad_summary', {}, async () => {
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: {} }) }] };
    });

    const body = parseResponse(resp);
    expect(body.ok).toBe(false);
    expect(body.errors[0].code).toBe('SHUTTING_DOWN');

    // Release slot so drain can finish
    if (slot.ok) slot.release();
    await drainPromise;
    expect(exitCode).toBe(0);
  }, 5_000);
});

// ---- S5 — second signal accelerates ----------------------------------------

describe('S5 — second signal accelerates to exiting', () => {
  it('second beginShutdown call flips state to exiting', async () => {
    const dir = makeTempDir('s5');
    const ctx = makeCtx(dir);

    let exitCode: number | null = null;
    const rl = new SessionRateLimiter({ concurrent: 5 });
    // Permanent stuck slot — forces the drain to wait the full window
    rl.tryAcquireConcurrent('sid-stuck');

    // First signal — starts drain with a long window
    const drainPromise = beginShutdown(
      { pool: ctx.pool, rateLimiter: rl },
      {
        shutdownTimeoutMs: 60_000,
        exit: (code) => { exitCode = code; },
      },
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(getShutdownState()).toBe('draining');

    // Second signal — accelerate
    await beginShutdown(
      { pool: ctx.pool, rateLimiter: rl },
      { shutdownTimeoutMs: 60_000, exit: (code) => { exitCode = code; } },
    );

    await drainPromise;
    expect(getShutdownState()).toBe('exiting');
    // Clean exit code because drain wasn't flagged as timed out — it was
    // accelerated before the deadline.
    expect(exitCode).toBe(0);
  }, 10_000);
});

// ---- S8 — engine close is idempotent ---------------------------------------

describe('S8 — engine close + pool.closeAll are idempotent', () => {
  it('closeAll can be called twice without error', async () => {
    const dir = makeTempDir('s8');
    const ctx = makeCtx(dir);
    await ctx.pool.get('alpha');

    await ctx.pool.closeAll();
    // Second call: no engines cached, should be a no-op.
    await expect(ctx.pool.closeAll()).resolves.toBeUndefined();
  });
});

// ---- Direct state-machine sanity -------------------------------------------

describe('shutdown state machine sanity', () => {
  it('starts in running', () => {
    expect(getShutdownState()).toBe('running');
    expect(isShuttingDown()).toBe(false);
  });

  it('transitions running → draining → exiting', async () => {
    const dir = makeTempDir('sanity');
    const ctx = makeCtx(dir);
    let exitCode: number | null = null;
    const rl = new SessionRateLimiter({ concurrent: 5 });

    await beginShutdown(
      { pool: ctx.pool, rateLimiter: rl },
      { shutdownTimeoutMs: 500, exit: (code) => { exitCode = code; } },
    );

    expect(getShutdownState()).toBe('exiting');
    expect(exitCode).toBe(0);
  });
});
