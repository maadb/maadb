import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync, rmSync, cpSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docId, docType } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-roundtrip');

let engine: MaadEngine;

beforeAll(async () => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true });
  cpSync(FIXTURE_SRC, TEMP_ROOT, { recursive: true });
  const backendDir = path.join(TEMP_ROOT, '_backend');
  if (existsSync(backendDir)) rmSync(backendDir, { recursive: true });

  engine = new MaadEngine();
  const result = await engine.init(TEMP_ROOT);
  expect(result.ok).toBe(true);
  await engine.indexAll({ force: true });
});

afterAll(async () => {
  engine.close();
  await new Promise(r => setTimeout(r, 100));
  try {
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch {
    // non-fatal
  }
});

describe('round-trip stability', () => {
  it('create -> update -> reindex -> update produces stable output', async () => {
    // Step 1: Create
    const createResult = await engine.createDocument(
      docType('case'),
      {
        title: 'Roundtrip Test Case',
        client: 'cli-acme',
        status: 'open',
        priority: 'medium',
        opened_at: '2026-04-06',
      },
      undefined, // use template
      'cas-roundtrip',
    );
    expect(createResult.ok).toBe(true);

    const fp = path.join(TEMP_ROOT, 'cases', 'cas-roundtrip.md');
    const afterCreate = await readFile(fp, 'utf-8');

    // Verify template headings present
    expect(afterCreate).toContain('# Roundtrip Test Case {#summary}');
    expect(afterCreate).toContain('## Details {#details}');
    expect(afterCreate).toContain('## Timeline {#timeline}');

    // Step 2: Update a field
    const update1 = await engine.updateDocument(
      docId('cas-roundtrip'),
      { status: 'pending' },
    );
    expect(update1.ok).toBe(true);
    const afterUpdate1 = await readFile(fp, 'utf-8');

    // Step 3: Reindex
    await engine.reindex({ docId: docId('cas-roundtrip'), force: true });

    // Step 4: Update again
    const update2 = await engine.updateDocument(
      docId('cas-roundtrip'),
      { priority: 'high' },
    );
    expect(update2.ok).toBe(true);
    const afterUpdate2 = await readFile(fp, 'utf-8');

    // --- Stability checks ---

    // Frontmatter field order should be consistent across updates
    const getFieldOrder = (content: string): string[] => {
      const fmMatch = /^---\n([\s\S]*?)\n---/.exec(content);
      if (!fmMatch) return [];
      return fmMatch[1]!.split('\n').map(line => line.split(':')[0]!.trim()).filter(Boolean);
    };

    const order1 = getFieldOrder(afterUpdate1);
    const order2 = getFieldOrder(afterUpdate2);
    expect(order1).toEqual(order2);

    // Core keys should always be first
    expect(order2[0]).toBe('doc_id');
    expect(order2[1]).toBe('doc_type');
    expect(order2[2]).toBe('schema');

    // Template headings should survive updates
    expect(afterUpdate2).toContain('# Roundtrip Test Case {#summary}');
    expect(afterUpdate2).toContain('## Details {#details}');
    expect(afterUpdate2).toContain('## Timeline {#timeline}');

    // Updated values should be present
    expect(afterUpdate2).toContain('status: pending');
    expect(afterUpdate2).toContain('priority: high');
  });

  it('reindex does not alter file content', async () => {
    const fp = path.join(TEMP_ROOT, 'cases', 'cas-roundtrip.md');
    const before = await readFile(fp, 'utf-8');

    await engine.reindex({ docId: docId('cas-roundtrip'), force: true });

    const after = await readFile(fp, 'utf-8');

    // Reindex reads only — it should never write to the file
    expect(after).toBe(before);
  });
});
