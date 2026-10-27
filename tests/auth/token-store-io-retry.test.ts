// ============================================================================
// TokenStore.reloadIfChanged — transient I/O failures are retried.
//
// On Windows an antivirus scan or sharing lock can fail the read (EBUSY/EPERM)
// right after another process rewrites tokens.yaml. The store must not record
// the new signature in that case, or every later check sees "no change" and a
// revoked token stays live until the file is edited again.
// ============================================================================

import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeTokenFixture, type TokenFixture } from '../support/token-fixture.js';
import { TokenStore } from '../../src/auth/token-store.js';

const failRead = vi.hoisted(() => ({ on: false }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = async (...args: Parameters<typeof actual.readFile>): Promise<unknown> => {
    if (failRead.on) {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    return actual.readFile(...args);
  };
  return { ...actual, readFile };
});

describe('TokenStore.reloadIfChanged — read failures', () => {
  let fixture: TokenFixture | null = null;
  afterEach(async () => {
    failRead.on = false;
    if (fixture) { await fixture.cleanup(); fixture = null; }
  });

  it('retries a failed read on the next check instead of treating the file as seen', async () => {
    fixture = await makeTokenFixture();
    const writer = await TokenStore.load(fixture.tmpRoot);
    if (!writer.ok) throw new Error('writer load failed');
    expect((await writer.value.revoke(fixture.record.id)).ok).toBe(true);

    failRead.on = true;
    const first = await fixture.store.reloadIfChanged();
    expect(first.changed).toBe(true);
    if (!first.changed) return;
    expect(first.result.ok).toBe(false);
    // Previous registry stays in place on failure.
    expect(fixture.store.lookupById(fixture.record.id)?.revokedAt).toBeUndefined();

    // Still reported as changed: the read is retried, not skipped.
    const second = await fixture.store.reloadIfChanged();
    expect(second.changed).toBe(true);

    failRead.on = false;
    const recovered = await fixture.store.reloadIfChanged();
    expect(recovered.changed).toBe(true);
    if (!recovered.changed) return;
    expect(recovered.result.ok).toBe(true);
    expect(fixture.store.lookupById(fixture.record.id)?.revokedAt).toBeDefined();
    expect(await fixture.store.reloadIfChanged()).toEqual({ changed: false });
  });
});
