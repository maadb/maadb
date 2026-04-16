// ============================================================================
// 0.6.7 Phase 2 acceptance — round-trip datetime preservation.
// T16: create with a precise timestamp, update unrelated field, re-read,
//      confirm timestamp is byte-for-byte identical. No truncation.
// T17: caller passes `new Date(...)` directly; serializer writes full
//      millisecond-precision ISO; re-read preserves the precision.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docType, docId } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-datetime-preservation');

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
    // Windows may hold handles briefly — non-fatal
  }
});

// Strings that contain `:` are quoted by the YAML serializer (safe default).
// So a datetime written as a string shows up on disk as `key: "value"`.
// Day-only and year-only forms have no colon and therefore stay unquoted.
describe('T16 — round-trip preserves literal datetime strings', () => {
  let roundtripFilePath = '';

  it('create → read file → timestamp is byte-for-byte identical (millisecond precision)', async () => {
    const preciseTs = '2026-04-16T17:20:30.500Z';
    const created = await engine.createDocument(
      docType('case'),
      {
        title: 'Precision test case',
        client: 'cli-acme',
        status: 'open',
        opened_at: preciseTs,
      },
      'Body content.',
      'cas-precision-roundtrip',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    roundtripFilePath = created.value.filePath;

    const absPath = path.join(TEMP_ROOT, roundtripFilePath);
    const raw = readFileSync(absPath, 'utf-8');
    expect(raw).toContain(`opened_at: "${preciseTs}"`);
    // Regression guard: must NOT be truncated to day form.
    expect(raw).not.toContain('opened_at: 2026-04-16\n');
    expect(raw).not.toContain('opened_at: "2026-04-16"\n');
  });

  it('update an unrelated field → timestamp stays byte-for-byte identical', async () => {
    const update = await engine.updateDocument(
      docId('cas-precision-roundtrip'),
      { status: 'pending' },
    );
    expect(update.ok).toBe(true);

    const absPath = path.join(TEMP_ROOT, roundtripFilePath);
    const raw = readFileSync(absPath, 'utf-8');
    expect(raw).toContain('opened_at: "2026-04-16T17:20:30.500Z"');
    expect(raw).toContain('status: pending');
    expect(raw).not.toContain('opened_at: 2026-04-16\n');
    expect(raw).not.toContain('opened_at: "2026-04-16"\n');
  });

  it('preserves second-precision timestamps (no Z) unchanged', async () => {
    const secondTs = '2026-04-16T17:20:30';
    const created = await engine.createDocument(
      docType('case'),
      {
        title: 'Second-precision case',
        client: 'cli-acme',
        status: 'open',
        opened_at: secondTs,
      },
      undefined,
      'cas-precision-second',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const absPath = path.join(TEMP_ROOT, created.value.filePath);
    const raw = readFileSync(absPath, 'utf-8');
    expect(raw).toContain(`opened_at: "${secondTs}"`);
  });

  it('preserves day-precision strings unchanged and unquoted (backward compat)', async () => {
    const dayOnly = '2026-04-15';
    const created = await engine.createDocument(
      docType('case'),
      {
        title: 'Day-precision case',
        client: 'cli-acme',
        status: 'open',
        opened_at: dayOnly,
      },
      undefined,
      'cas-precision-day',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const absPath = path.join(TEMP_ROOT, created.value.filePath);
    const raw = readFileSync(absPath, 'utf-8');
    expect(raw).toContain(`opened_at: ${dayOnly}`);
  });
});

describe('T17 — Date-object fallback: serializer writes full ms precision', () => {
  it('caller passes `new Date(...)` directly → full ISO on disk, no truncation', async () => {
    const jsDate = new Date('2026-04-17T10:30:45.250Z');
    const created = await engine.createDocument(
      docType('case'),
      {
        title: 'Date-object fallback case',
        client: 'cli-acme',
        status: 'open',
        opened_at: jsDate,
      },
      undefined,
      'cas-date-object',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const absPath = path.join(TEMP_ROOT, created.value.filePath);
    const raw = readFileSync(absPath, 'utf-8');
    // Full ISO (quoted by serializer for YAML-safe interop), not YYYY-MM-DD
    expect(raw).toContain('opened_at: "2026-04-17T10:30:45.250Z"');
    expect(raw).not.toContain('opened_at: 2026-04-17\n');
    expect(raw).not.toContain('opened_at: "2026-04-17"\n');
  });
});
