// ============================================================================
// 0.5.0 R4 — concurrent reads, serialized writes
//
// The per-engine write mutex is now acquired at the MCP entry point
// (withEngine's write branch) instead of inside each engine mutation
// method. This file proves the invariant end-to-end:
//
//   1. N concurrent reads execute in parallel while a slow write holds
//      the mutex — reads must NOT block on the write.
//   2. N concurrent writes serialize through the mutex — total wall-clock
//      is at least N × per-write cost.
//   3. An unclassified tool name that reaches withEngine returns
//      MISSING_OPERATION_KIND rather than silently running without the lock.
// ============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import path from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EnginePool } from '../../src/instance/pool.js';
import { SessionRegistry, __resetStdioSessionId } from '../../src/instance/session.js';
import type { InstanceConfig } from '../../src/instance/config.js';
import type { InstanceCtx } from '../../src/mcp/ctx.js';
import { withEngine } from '../../src/mcp/with-session.js';

const createdDirs: string[] = [];

function makeTempDir(label = 'proj'): string {
  const dir = mkdtempSync(path.join(tmpdir(), `maad-concurrent-${label}-`));
  createdDirs.push(dir);
  return dir;
}

function makeCtx(projectPath: string): InstanceCtx {
  const instance: InstanceConfig = {
    name: 'ctest',
    source: 'synthetic',
    projects: [{ name: 'default', path: projectPath, role: 'admin' }],
  };
  return { instance, pool: new EnginePool(instance), sessions: new SessionRegistry(instance) };
}

interface ToolResponse { content: Array<{ type: string; text: string }> }
function parse<T = unknown>(resp: ToolResponse): T {
  return JSON.parse(resp.content[0].text) as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

afterEach(async () => {
  __resetStdioSessionId();
  await sleep(50);
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()!;
    try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* windows */ }
  }
});

describe('concurrent reads do not block on a held write mutex', () => {
  it('N reads complete in parallel while a slow write holds the lock', async () => {
    const dir = makeTempDir('rw');
    const ctx = makeCtx(dir);
    ctx.sessions.create('sid-r');

    // Warm the engine via a first synchronous read so init is paid before
    // we measure. Auto-binds to 'default' under synthetic mode.
    const warm = await withEngine(ctx, { sessionId: 'sid-r' }, 'maad_summary', {}, ({ engine }) => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, data: engine.summary() }) }],
    }));
    expect(parse<{ ok: boolean }>(warm).ok).toBe(true);

    // Grab the engine and hold the write mutex for HOLD_MS on a background
    // task. Anything wrapped in runExclusive (i.e. any 'write' kind) queues
    // behind it; reads route around it.
    const poolResult = await ctx.pool.get('default');
    expect(poolResult.ok).toBe(true);
    const engine = poolResult.ok ? poolResult.value : null;
    if (!engine) throw new Error('engine unavailable');

    const HOLD_MS = 400;
    const N_READS = 10;
    const PER_READ_BUDGET_MS = 100; // generous — reads are trivial summary() calls

    // Start the slow write holder but don't await yet.
    const slowWrite = engine.runExclusive('test-slow-write', async () => {
      await sleep(HOLD_MS);
    });

    // Fire N reads while the write is still holding the lock.
    const readStarted = Date.now();
    const reads = Array.from({ length: N_READS }, (_, i) =>
      withEngine(ctx, { sessionId: `sid-r-${i}` }, 'maad_summary', {}, ({ engine: e }) => ({
        content: [{ type: 'text', text: JSON.stringify({ ok: true, data: e.summary() }) }],
      })),
    );

    // Seed sessions for the fan-out reads; synthetic auto-binds, so each sid
    // just needs to exist.
    for (let i = 0; i < N_READS; i++) ctx.sessions.create(`sid-r-${i}`);

    const responses = await Promise.all(reads);
    const readElapsed = Date.now() - readStarted;

    // All reads must succeed.
    for (const r of responses) {
      expect(parse<{ ok: boolean }>(r).ok).toBe(true);
    }

    // Wall-clock for all N reads must be well below the write hold — if the
    // reads were serialized behind the mutex, elapsed would be >= HOLD_MS.
    // Generous ceiling: 10 reads should comfortably finish in < HOLD_MS / 2.
    expect(readElapsed,
      `expected concurrent reads to finish well before the ${HOLD_MS}ms write hold, got ${readElapsed}ms`,
    ).toBeLessThan(HOLD_MS / 2);
    // And also shouldn't be pathologically slow.
    expect(readElapsed).toBeLessThan(N_READS * PER_READ_BUDGET_MS);

    await slowWrite;
    await ctx.pool.closeAll();
  });

  it('N concurrent writes serialize through the mutex', async () => {
    const dir = makeTempDir('ww');
    const ctx = makeCtx(dir);
    ctx.sessions.create('sid-w');

    // Warm.
    await withEngine(ctx, { sessionId: 'sid-w' }, 'maad_summary', {}, ({ engine }) => ({
      content: [{ type: 'text', text: JSON.stringify({ ok: true, data: engine.summary() }) }],
    }));

    const PER_WRITE_MS = 80;
    const N_WRITES = 4;

    // maad_reindex is classified 'write' and therefore routes through
    // runExclusive. We don't care about the engine result here — we
    // replace the handler with a controlled sleep to measure serialization.
    // NOTE: each call carries a distinct arg (`shard`) so the heavy-op guard's
    // single-flight does NOT coalesce them — identical concurrent reindexes
    // intentionally collapse to one run (covered in tests/mcp/heavy-ops.test.ts);
    // here we want distinct ops to prove the write mutex serializes them.
    const started = Date.now();
    const writes = Array.from({ length: N_WRITES }, (_, i) =>
      withEngine(ctx, { sessionId: `sid-w-${i}` }, 'maad_reindex', { shard: i }, async () => {
        await sleep(PER_WRITE_MS);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { n: i } }) }] };
      }),
    );
    for (let i = 0; i < N_WRITES; i++) ctx.sessions.create(`sid-w-${i}`);

    const responses = await Promise.all(writes);
    const elapsed = Date.now() - started;

    for (const r of responses) expect(parse<{ ok: boolean }>(r).ok).toBe(true);

    // Serialized: elapsed >= N × PER_WRITE_MS (minus a small jitter tolerance).
    // If writes leaked past the mutex, elapsed would be ~PER_WRITE_MS.
    const minExpected = N_WRITES * PER_WRITE_MS * 0.85;
    expect(elapsed,
      `expected serialized writes to take >= ${minExpected}ms, got ${elapsed}ms`,
    ).toBeGreaterThanOrEqual(minExpected);

    await ctx.pool.closeAll();
  });

  it('unclassified tool name returns MISSING_OPERATION_KIND', async () => {
    const dir = makeTempDir('missing');
    const ctx = makeCtx(dir);
    ctx.sessions.create('sid-x');

    const resp = await withEngine(ctx, { sessionId: 'sid-x' }, 'maad_not_a_real_tool', {}, () => {
      throw new Error('handler should never run');
    });
    const parsed = parse<{ ok: boolean; errors: Array<{ code: string }> }>(resp);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0].code).toBe('MISSING_OPERATION_KIND');

    await ctx.pool.closeAll();
  });
});
