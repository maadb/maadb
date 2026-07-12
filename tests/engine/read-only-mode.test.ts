import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { MaadEngine } from '../../src/engine.js';
import { docType } from '../../src/types.js';

const SOURCE = path.resolve(__dirname, '../fixtures/simple-crm');
const ROOT = path.resolve(__dirname, '../fixtures/_temp-read-only-mode');

function snapshot(dir: string): Record<string, { size: number; mtimeMs: number }> {
  const out: Record<string, { size: number; mtimeMs: number }> = {};
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs);
      else {
        const st = statSync(abs);
        out[path.relative(dir, abs).replace(/\\/g, '/')] = { size: st.size, mtimeMs: st.mtimeMs };
      }
    }
  };
  walk(dir);
  return out;
}

beforeEach(async () => {
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  cpSync(SOURCE, ROOT, { recursive: true, filter: src => !src.includes(`${path.sep}_backend`) });
  const writer = new MaadEngine();
  expect((await writer.init(ROOT)).ok).toBe(true);
  await writer.indexAll({ force: true });
  writer.close();
});

afterEach(() => rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

describe('true read-only engine mode', () => {
  it('performs representative reads without modifying the project tree', async () => {
    const before = snapshot(ROOT);
    const engine = new MaadEngine();
    const init = await engine.init(ROOT, { readOnly: true });
    expect(init.ok, JSON.stringify(init)).toBe(true);
    expect(engine.summary().totalDocuments).toBeGreaterThan(0);
    expect((await engine.verifyIntegrity({ categories: ['broken_refs'] })).ok).toBe(true);
    expect((await engine.backupList()).ok).toBe(true);

    expect((await engine.indexAll()).ok).toBe(false);
    expect((await engine.createDocument(docType('client'), { name: 'No', status: 'active' })).ok).toBe(false);
    expect((await engine.backupCreate()).ok).toBe(false);
    expect((await engine.backupDelete('maad-snapshot-never')).ok).toBe(false);
    engine.close();

    expect(snapshot(ROOT)).toEqual(before);
  });
});
