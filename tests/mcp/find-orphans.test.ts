// ============================================================================
// 0.7.10 — maad_find_orphans coverage. The wrapper delegates to
// engine.verifyIntegrity({ categories: ['broken_refs'], verbose: true,
// ...scope }). Tests exercise that engine call directly and assert the
// shape the wrapper hands back to the MCP client.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync, unlinkSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docType } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-find-orphans');

let engine: MaadEngine;

beforeEach(async () => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  cpSync(FIXTURE_SRC, TEMP_ROOT, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}_backend`),
  });

  engine = new MaadEngine();
  const result = await engine.init(TEMP_ROOT);
  expect(result.ok).toBe(true);
  await engine.indexAll({ force: true });
});

afterEach(async () => {
  engine.close();
  await new Promise(r => setTimeout(r, 100));
  try {
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Windows may briefly hold a db handle — non-fatal.
  }
});

// What the wrapper produces:
const WRAPPER_QUERY = { categories: ['broken_refs'] as ('broken_refs')[], verbose: true };

describe('maad_find_orphans (wrapper) — parity with integrity-mode call', () => {
  it('clean project returns broken_refs: 0 and an empty details array', async () => {
    const result = await engine.verifyIntegrity(WRAPPER_QUERY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings.broken_refs).toBe(0);
    expect(result.value.details).toEqual([]);
    expect(result.value.scopeFilters.categories).toEqual(['broken_refs']);
  });

  it('surfaces broken refs with per-record details when refs dangle', async () => {
    // cli-acme.primary_contact === 'con-jane-smith' — delete the target.
    unlinkSync(path.join(TEMP_ROOT, 'contacts', 'con-jane-smith.md'));
    await engine.reindex({ force: true });

    const result = await engine.verifyIntegrity(WRAPPER_QUERY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings.broken_refs).toBeGreaterThanOrEqual(1);

    const detail = result.value.details!.find(d => d.docId === 'cli-acme' && d.finding === 'broken_refs');
    expect(detail).toBeDefined();
    expect(detail!.actual).toEqual({ primary_contact: ['con-jane-smith'] });
  });

  it('scope filter docType narrows the walk to one type', async () => {
    unlinkSync(path.join(TEMP_ROOT, 'contacts', 'con-jane-smith.md'));
    await engine.reindex({ force: true });

    const clientsOnly = await engine.verifyIntegrity({
      ...WRAPPER_QUERY,
      docType: docType('client'),
    });
    expect(clientsOnly.ok).toBe(true);
    if (!clientsOnly.ok) return;
    expect(clientsOnly.value.scanned).toBe(1);
    expect(clientsOnly.value.findings.broken_refs).toBeGreaterThanOrEqual(1);

    // case_note records only ref `case`, never the deleted contact — should be clean.
    const notesOnly = await engine.verifyIntegrity({
      ...WRAPPER_QUERY,
      docType: docType('case_note'),
    });
    expect(notesOnly.ok).toBe(true);
    if (!notesOnly.ok) return;
    expect(notesOnly.value.findings.broken_refs).toBe(0);
  });

  it('does NOT compute other finding categories — broken_refs is the only delta', async () => {
    // Set up state that would trigger hash_drift if the sweep were running
    // every category. The wrapper's fixed categories: ['broken_refs'] must
    // leave hash_drift at zero.
    const fp = path.join(TEMP_ROOT, 'clients', 'cli-acme.md');
    const { readFileSync, writeFileSync } = await import('node:fs');
    writeFileSync(fp, readFileSync(fp, 'utf-8') + '\nextra\n');

    const result = await engine.verifyIntegrity(WRAPPER_QUERY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings.hash_drift).toBe(0);
    expect(result.value.findings.missing_in_index).toBe(0);
    expect(result.value.findings.missing_on_disk).toBe(0);
    expect(result.value.findings.schema_drift).toBe(0);
  });
});
