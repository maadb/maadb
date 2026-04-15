// ============================================================================
// AsyncFifoMutex — FIFO-ordered async mutual exclusion
// Callers acquire, do work, call release(). Order is strictly first-in-first-out.
// Zero external dependencies. No timeout (deferred to 0.8.5).
// ============================================================================

export type Release = () => void;

export class AsyncFifoMutex {
  private queue: Array<(release: Release) => void> = [];
  private held = false;

  /**
   * Acquire the lock. Returns a release function. Callers MUST call release()
   * in a finally block to avoid leaks.
   *
   * Ordering is FIFO: the first caller to await acquire() is the first to be
   * granted the lock when it becomes available.
   */
  acquire(): Promise<Release> {
    return new Promise<Release>((resolve) => {
      const grant = (release: Release) => {
        this.held = true;
        resolve(release);
      };
      if (!this.held) {
        grant(() => this.release());
      } else {
        this.queue.push(grant);
      }
    });
  }

  private release(): void {
    this.held = false;
    const next = this.queue.shift();
    if (next) next(() => this.release());
  }

  /**
   * Current pressure on the lock: 1 if held and no waiters, >1 if waiters are
   * queued, 0 if idle. Used for health reporting and drain loops.
   */
  depth(): number {
    return this.queue.length + (this.held ? 1 : 0);
  }

  /**
   * True if the lock is currently held by a caller.
   */
  isHeld(): boolean {
    return this.held;
  }
}
