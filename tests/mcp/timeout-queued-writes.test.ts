// A write that times out while it waits for the engine write lock must not
// run later. The client already got REQUEST_TIMEOUT, so a late run would be a
// write nobody is waiting for.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { EnginePool } from '../../src/instance/pool.js';
import { SessionRegistry, __resetStdioSessionId } from '../../src/instance/session.js';
import type { InstanceConfig } from '../../src/instance/config.js';
import type { InstanceCtx } from '../../src/mcp/ctx.js';
import { withEngine } from '../../src/mcp/with-session.js';
import { __resetShutdownState } from '../../src/mcp/shutdown.js';
import { initRateLimiter } from '../../src/mcp/rate-limit.js';

const dirs: string[] = [];
let ctx: InstanceCtx;

function okResponse() {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data: {} }) }] };
}
function body(resp: { content: Array<{ type: string; text: string }> }): any {
  return JSON.parse(resp.content[0]!.text);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

beforeEach(() => {
  __resetShutdownState();
  __resetStdioSessionId();
  initRateLimiter({ concurrent: 100, writesPerSec: 100, writesPerMin: 1000 });
  const dir = mkdtempSync(path.join(tmpdir(), 'maad-timeout-queue-'));
  dirs.push(dir);
  const instance: InstanceConfig = {
    name: 'tqtest', source: 'file', projects: [{ name: 'alpha', path: dir, role: 'admin' }],
  };
  ctx = { instance, pool: new EnginePool(instance), sessions: new SessionRegistry(instance) };
  ctx.sessions.create('sid-1');
  ctx.sessions.bindSingle('sid-1', 'alpha');
  process.env.MAAD_REQUEST_TIMEOUT_MS = '100';
});

afterEach(async () => {
  delete process.env.MAAD_REQUEST_TIMEOUT_MS;
  await ctx.pool.closeAll();
  __resetShutdownState();
  for (const dir of dirs.splice(0)) {
    try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* windows */ }
  }
});

describe('queued writes after a request timeout', () => {
  it('skips a write that timed out while waiting for the lock', async () => {
    const ran: string[] = [];
    const holder = withEngine(ctx, { sessionId: 'sid-1' }, 'maad_create', {}, async () => {
      ran.push('holder');
      await sleep(300);
      return okResponse();
    });
    // Let the holder take the lock before the second write queues behind it.
    while (!ran.includes('holder')) await sleep(1);
    const queued = withEngine(ctx, { sessionId: 'sid-1' }, 'maad_update', {}, async () => {
      ran.push('queued');
      return okResponse();
    });

    const [first, second] = await Promise.all([holder, queued]);
    expect(body(second).errors[0].code).toBe('REQUEST_TIMEOUT');
    expect(body(second).errors[0].details.started).toBe(false);
    // The holder was already running when it timed out, so it may finish.
    expect(body(first).errors[0].code).toBe('REQUEST_TIMEOUT');
    expect(body(first).errors[0].details.started).toBe(true);

    // Give the lock time to pass to the queued write: it must not run.
    await sleep(400);
    expect(ran).toEqual(['holder']);
  }, 10_000);

  it('runs a queued write that gets the lock in time', async () => {
    process.env.MAAD_REQUEST_TIMEOUT_MS = '1000';
    const ran: string[] = [];
    const holder = withEngine(ctx, { sessionId: 'sid-1' }, 'maad_create', {}, async () => {
      ran.push('holder');
      await sleep(50);
      return okResponse();
    });
    while (!ran.includes('holder')) await sleep(1);
    const queued = withEngine(ctx, { sessionId: 'sid-1' }, 'maad_update', {}, async () => {
      ran.push('queued');
      return okResponse();
    });
    const [first, second] = await Promise.all([holder, queued]);
    expect(body(first).ok).toBe(true);
    expect(body(second).ok).toBe(true);
    expect(ran).toEqual(['holder', 'queued']);
  }, 10_000);

  it('leaves heavy maintenance ops as before: queued runs still run, no started detail', async () => {
    const ran: string[] = [];
    const holder = withEngine(ctx, { sessionId: 'sid-1' }, 'maad_create', {}, async () => {
      ran.push('holder');
      await sleep(300);
      return okResponse();
    });
    while (!ran.includes('holder')) await sleep(1);
    const queued = withEngine(ctx, { sessionId: 'sid-1' }, 'maad_reindex', {}, async () => {
      ran.push('reindex');
      return okResponse();
    });
    const [, second] = await Promise.all([holder, queued]);
    expect(body(second).errors[0].code).toBe('REQUEST_TIMEOUT');
    expect(body(second).errors[0].details).not.toHaveProperty('started');
    await sleep(400);
    expect(ran).toEqual(['holder', 'reindex']);
  }, 10_000);
});
