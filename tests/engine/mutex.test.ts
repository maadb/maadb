import { describe, it, expect } from 'vitest';
import { AsyncFifoMutex } from '../../src/engine/mutex.js';

describe('AsyncFifoMutex', () => {
  it('grants immediately when idle', async () => {
    const m = new AsyncFifoMutex();
    expect(m.depth()).toBe(0);
    expect(m.isHeld()).toBe(false);

    const release = await m.acquire();
    expect(m.isHeld()).toBe(true);
    expect(m.depth()).toBe(1);

    release();
    expect(m.isHeld()).toBe(false);
    expect(m.depth()).toBe(0);
  });

  it('serializes concurrent acquires in FIFO order', async () => {
    const m = new AsyncFifoMutex();
    const order: number[] = [];

    // Hold the lock so the next 5 acquires all queue.
    const firstRelease = await m.acquire();

    const workers = [1, 2, 3, 4, 5].map((n) =>
      (async () => {
        const release = await m.acquire();
        order.push(n);
        release();
      })(),
    );

    // Let event loop register all 5 waiters.
    await new Promise((r) => setTimeout(r, 10));
    expect(m.depth()).toBe(6); // 1 held + 5 queued

    firstRelease();
    await Promise.all(workers);

    expect(order).toEqual([1, 2, 3, 4, 5]);
    expect(m.depth()).toBe(0);
  });

  it('reports depth correctly under contention', async () => {
    const m = new AsyncFifoMutex();
    const firstRelease = await m.acquire();
    expect(m.depth()).toBe(1);

    // Queue 3 waiters without awaiting them.
    const pending = [m.acquire(), m.acquire(), m.acquire()];
    await new Promise((r) => setTimeout(r, 10));
    expect(m.depth()).toBe(4);

    firstRelease();
    // Drain one-by-one.
    const r1 = await pending[0];
    expect(m.depth()).toBe(3);
    r1();

    const r2 = await pending[1];
    expect(m.depth()).toBe(2);
    r2();

    const r3 = await pending[2];
    expect(m.depth()).toBe(1);
    r3();

    expect(m.depth()).toBe(0);
  });

  it('releases the lock when the critical section throws (user responsibility)', async () => {
    const m = new AsyncFifoMutex();

    async function guarded(fn: () => Promise<void>): Promise<void> {
      const release = await m.acquire();
      try {
        await fn();
      } finally {
        release();
      }
    }

    // First call throws; its finally must release.
    await expect(
      guarded(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(m.depth()).toBe(0);
    expect(m.isHeld()).toBe(false);

    // Second call must proceed without hanging.
    let ran = false;
    await guarded(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(m.depth()).toBe(0);
  });

  it('handles rapid acquire/release bursts without losing ordering', async () => {
    const m = new AsyncFifoMutex();
    const order: number[] = [];

    // Launch 50 tasks that all queue behind a held lock.
    const firstRelease = await m.acquire();
    const tasks = Array.from({ length: 50 }, (_, i) =>
      (async () => {
        const release = await m.acquire();
        order.push(i);
        release();
      })(),
    );

    await new Promise((r) => setTimeout(r, 10));
    expect(m.depth()).toBe(51);

    firstRelease();
    await Promise.all(tasks);

    expect(order).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(m.depth()).toBe(0);
  });

  it('depth is 0 after the last release with no waiters', async () => {
    const m = new AsyncFifoMutex();
    const r1 = await m.acquire();
    r1();
    const r2 = await m.acquire();
    r2();
    expect(m.depth()).toBe(0);
    expect(m.isHeld()).toBe(false);
  });
});
