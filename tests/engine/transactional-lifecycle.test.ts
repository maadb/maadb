import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MaadEngine } from '../../src/engine.js';

const SOURCE = path.resolve(__dirname, '../fixtures/simple-crm');
const ROOT = path.resolve(__dirname, '../fixtures/_temp-transactional-lifecycle');
let engine: MaadEngine;

beforeEach(async () => {
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  cpSync(SOURCE, ROOT, { recursive: true, filter: src => !src.includes(`${path.sep}_backend`) });
  engine = new MaadEngine();
  expect((await engine.init(ROOT)).ok).toBe(true);
  await engine.indexAll({ force: true });
});

afterEach(async () => {
  await engine.close();
  rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('transactional lifecycle', () => {
  it('close is awaitable, idempotent, and rejects subsequent public reads', async () => {
    const first = engine.close();
    const second = engine.close();
    expect(second).toBe(first);
    await first;
    expect(() => engine.summary()).toThrow(/not initialized/i);
  });

  it('failed reload leaves the prior ready engine usable', async () => {
    const schemaPath = path.join(ROOT, '_schema', 'client.v1.yaml');
    const schema = readFileSync(schemaPath, 'utf-8');
    unlinkSync(schemaPath);

    const reloaded = await engine.reload();
    expect(reloaded.ok).toBe(false);
    expect(engine.summary().totalDocuments).toBeGreaterThan(0);

    writeFileSync(schemaPath, schema, 'utf-8');
  });
});
