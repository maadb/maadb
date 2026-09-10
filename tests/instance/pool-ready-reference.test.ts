import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnginePool } from '../../src/instance/pool.js';
import { MaadEngine } from '../../src/engine/index.js';
import type { InstanceConfig } from '../../src/instance/config.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'receipt-pool-')); roots.push(root);
  const config: InstanceConfig = { name: 'example', source: 'file', projects: [{ name: 'one', path: root, role: 'reader' }] };
  const pool = new EnginePool(config);
  const engine = new MaadEngine();
  vi.spyOn(engine, 'isReceiptReady').mockReturnValue(true);
  const close = vi.spyOn(engine, 'close').mockResolvedValue();
  (pool as unknown as { engines: Map<string, MaadEngine> }).engines.set('one', engine);
  return { pool, engine, config, close };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const relative = path.relative(tmpdir(), root);
    expect(relative && !relative.startsWith('..') && !path.isAbsolute(relative)).toBeTruthy();
    rmSync(root, { recursive: true, force: true });
  }
});
describe('ready engine references', () => {
  it('does not initialize an unloaded project or accept an unready engine', () => {
    const { pool, engine } = fixture();
    const get = vi.spyOn(pool, 'get');
    vi.mocked(engine.isReceiptReady).mockReturnValue(false);
    expect(pool.acquireReadyReference('one')).toMatchObject({ ok: false, errors: [{ code: 'RECEIPT_ENGINE_NOT_READY' }] });
    (pool as unknown as { engines: Map<string, MaadEngine> }).engines.clear();
    expect(pool.acquireReadyReference('one')).toMatchObject({ ok: false, errors: [{ code: 'RECEIPT_ENGINE_NOT_READY' }] });
    expect(get).not.toHaveBeenCalled();
  });
  it('holds eviction until the last reference is released; release is idempotent', async () => {
    const { pool, close } = fixture();
    const a = pool.acquireReadyReference('one'); const b = pool.acquireReadyReference('one');
    expect(a.ok && b.ok).toBe(true); if (!a.ok || !b.ok) return;
    const eviction = pool.evict('one');
    expect(close).not.toHaveBeenCalled();
    expect(a.value.isCurrent()).toBe(false);
    expect(pool.acquireReadyReference('one').ok).toBe(false);
    a.value.release(); a.value.release();
    expect(pool.refcountFor('one')).toBe(1);
    expect(close).not.toHaveBeenCalled();
    b.value.release(); await eviction;
    expect(close).toHaveBeenCalledTimes(1);
    expect(pool.has('one')).toBe(false);
  });
  it('fences reloads before acquisition and drains retained references before removal', async () => {
    const { pool, config, close } = fixture();
    const ref = pool.acquireReadyReference('one'); if (!ref.ok) throw new Error('Fixture');
    expect(pool.tryBeginReload().ok).toBe(true);
    expect(pool.acquireReadyReference('one').ok).toBe(false);
    const pending = pool.applyDiff({ ...config, projects: [] });
    expect(close).not.toHaveBeenCalled();
    expect(ref.value.isCurrent()).toBe(false);
    ref.value.release();
    expect((await pending).ok).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it('protects references during shutdown', async () => {
    const { pool, close } = fixture();
    const ref = pool.acquireReadyReference('one'); if (!ref.ok) throw new Error('Fixture');
    const pending = pool.closeAll();
    expect(close).not.toHaveBeenCalled();
    ref.value.release(); await pending;
    expect(close).toHaveBeenCalledTimes(1);
  });
});
