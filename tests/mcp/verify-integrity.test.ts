// ============================================================================
// 0.7.10 — maad_verify mode: 'integrity' coverage. Builds a fresh copy of
// the simple-crm fixture per test, indexes it, then mutates state to trigger
// each finding category and asserts the expected sweep output.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync, writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docType, docId } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-integrity');

let engine: MaadEngine;

beforeEach(async () => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  // Skip _backend during copy — pipeline.test.ts runs in parallel against
  // the source fixture's live SQLite db; reading it mid-write races.
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

describe('verifyIntegrity — finding categories', () => {
  it('clean project — zero findings', async () => {
    const result = await engine.verifyIntegrity();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scanned).toBe(4);
    expect(result.value.healthy).toBe(4);
    expect(result.value.findings).toEqual({
      missing_in_index: 0,
      missing_on_disk: 0,
      hash_drift: 0,
      schema_drift: 0,
      broken_refs: 0,
    });
  });

  it('missing_in_index — file on disk but no index row', async () => {
    writeFileSync(
      path.join(TEMP_ROOT, 'clients', 'cli-orphan.md'),
      '---\ndoc_id: cli-orphan\ndoc_type: client\nschema: client.v1\nname: Orphan\nstatus: active\n---\n\n# Orphan\n',
    );
    const result = await engine.verifyIntegrity();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings.missing_in_index).toBe(1);
    expect(result.value.scanned).toBe(5);
    expect(result.value.healthy).toBe(4);
  });

  it('missing_on_disk — index row but no file', async () => {
    unlinkSync(path.join(TEMP_ROOT, 'clients', 'cli-acme.md'));
    const result = await engine.verifyIntegrity();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings.missing_on_disk).toBe(1);
    expect(result.value.scanned).toBe(3);
  });

  it('hash_drift — file edited externally without reindex', async () => {
    const fp = path.join(TEMP_ROOT, 'clients', 'cli-acme.md');
    writeFileSync(fp, readFileSync(fp, 'utf-8') + '\n\nExtra paragraph.\n');
    const result = await engine.verifyIntegrity();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings.hash_drift).toBe(1);
    expect(result.value.healthy).toBe(3);
  });

  it('schema_drift — registry advanced, record still on old schemaRef', async () => {
    // Bump client to v2 in the registry, copy the v1 schema file as v2.
    const v1Schema = readFileSync(path.join(TEMP_ROOT, '_schema', 'client.v1.yaml'), 'utf-8');
    writeFileSync(path.join(TEMP_ROOT, '_schema', 'client.v2.yaml'), v1Schema);
    const regPath = path.join(TEMP_ROOT, '_registry', 'object_types.yaml');
    const reg = readFileSync(regPath, 'utf-8').replace('schema: client.v1', 'schema: client.v2');
    writeFileSync(regPath, reg);
    const reloadResult = await engine.reload();
    expect(reloadResult.ok).toBe(true);

    const result = await engine.verifyIntegrity();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings.schema_drift).toBe(1);
  });

  it('broken_refs — frontmatter ref points at non-existent docId', async () => {
    // cli-acme.frontmatter.primary_contact === 'con-jane-smith'. Delete that
    // record's file and reindex so the index drops the row; the cli-acme
    // record's ref now dangles.
    unlinkSync(path.join(TEMP_ROOT, 'contacts', 'con-jane-smith.md'));
    await engine.reindex({ force: true });

    const result = await engine.verifyIntegrity();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings.broken_refs).toBeGreaterThanOrEqual(1);
  });
});

describe('verifyIntegrity — verbose mode', () => {
  it('omits details by default', async () => {
    const result = await engine.verifyIntegrity();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.details).toBeUndefined();
  });

  it('returns details[] when verbose: true', async () => {
    const fp = path.join(TEMP_ROOT, 'clients', 'cli-acme.md');
    writeFileSync(fp, readFileSync(fp, 'utf-8') + '\n\nExtra.\n');

    const result = await engine.verifyIntegrity({ verbose: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.details).toBeDefined();
    expect(result.value.details!.length).toBeGreaterThan(0);
    const drift = result.value.details!.find(d => d.finding === 'hash_drift');
    expect(drift).toBeDefined();
    expect(drift!.docId).toBe('cli-acme');
    expect(typeof drift!.expected).toBe('string');
    expect(typeof drift!.actual).toBe('string');
    expect((drift!.expected as string).startsWith('sha256:')).toBe(true);
    expect((drift!.actual as string).startsWith('sha256:')).toBe(true);
  });
});

describe('verifyIntegrity — scope filters', () => {
  it('docType filter constrains walk to one type', async () => {
    const result = await engine.verifyIntegrity({ docType: docType('client') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.scanned).toBe(1);
    expect(result.value.scopeFilters.docType).toBe('client');
  });

  it('categories filter — only hash_drift computed', async () => {
    // Set up TWO findings of different categories, then run with categories: ['hash_drift'].
    const fp = path.join(TEMP_ROOT, 'clients', 'cli-acme.md');
    writeFileSync(fp, readFileSync(fp, 'utf-8') + '\nextra\n');
    unlinkSync(path.join(TEMP_ROOT, 'cases', 'cas-2026-001.md'));

    const result = await engine.verifyIntegrity({ categories: ['hash_drift'] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings.hash_drift).toBe(1);
    expect(result.value.findings.missing_on_disk).toBe(0);
    expect(result.value.scopeFilters.categories).toEqual(['hash_drift']);
  });

  it('docId filter narrows hash check to a single record', async () => {
    // Edit two files; assert only the docId-matched one is counted.
    const clientPath = path.join(TEMP_ROOT, 'clients', 'cli-acme.md');
    writeFileSync(clientPath, readFileSync(clientPath, 'utf-8') + '\nextra\n');
    const casePath = path.join(TEMP_ROOT, 'cases', 'cas-2026-001.md');
    writeFileSync(casePath, readFileSync(casePath, 'utf-8') + '\nedit\n');

    const result = await engine.verifyIntegrity({ docId: docId('cli-acme') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.findings.hash_drift).toBe(1);
  });
});

describe('verifyIntegrity — read-only contract', () => {
  it('does not mutate the index — document count unchanged before/after sweep', async () => {
    const before = engine.describe().totalDocuments;
    await engine.verifyIntegrity({ verbose: true });
    const after = engine.describe().totalDocuments;
    expect(after).toBe(before);
  });

  it('repeated sweeps return consistent counts', async () => {
    const first = await engine.verifyIntegrity();
    const second = await engine.verifyIntegrity();
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.findings).toEqual(first.value.findings);
    expect(second.value.scanned).toBe(first.value.scanned);
  });
});
