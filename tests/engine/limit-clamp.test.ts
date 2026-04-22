// 0.7.1 R3 — engine-level hard caps on list-returning read tools.
// findDocuments clamps `limit` to MAX_QUERY_LIMIT (500).
// aggregate clamps `limit` to MAX_AGGREGATE_LIMIT (2000).
// Clamp is transparent: the clamped value is applied, and the result carries
// `limitClamped: { requested, applied }` so the MCP layer can surface it via
// `_meta.limit_clamped`. Callers that stay under the cap see no change.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docType } from '../../src/types.js';
import { MAX_QUERY_LIMIT, MAX_AGGREGATE_LIMIT } from '../../src/engine/reads.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-limit-clamp');

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

describe('findDocuments — 0.7.1 limit clamp', () => {
  it('exposes MAX_QUERY_LIMIT = 500', () => {
    expect(MAX_QUERY_LIMIT).toBe(500);
  });

  it('does not set limitClamped when limit is under cap', () => {
    const result = engine.findDocuments({ docType: docType('client'), limit: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.limitClamped).toBeUndefined();
  });

  it('does not set limitClamped when limit equals cap exactly', () => {
    const result = engine.findDocuments({ docType: docType('client'), limit: MAX_QUERY_LIMIT });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.limitClamped).toBeUndefined();
  });

  it('does not set limitClamped when limit is omitted', () => {
    const result = engine.findDocuments({ docType: docType('client') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.limitClamped).toBeUndefined();
  });

  it('clamps limit when over cap and reports in limitClamped', () => {
    const result = engine.findDocuments({ docType: docType('client'), limit: 10000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.limitClamped).toEqual({ requested: 10000, applied: MAX_QUERY_LIMIT });
  });

  it('does not fail when corpus has fewer records than the cap', () => {
    // Fixture has <500 clients; clamp still fires on request shape.
    const result = engine.findDocuments({ docType: docType('client'), limit: 10000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBeLessThanOrEqual(MAX_QUERY_LIMIT);
    expect(result.value.limitClamped).toBeDefined();
  });
});

describe('aggregate — 0.7.1 limit clamp', () => {
  it('exposes MAX_AGGREGATE_LIMIT = 2000', () => {
    expect(MAX_AGGREGATE_LIMIT).toBe(2000);
  });

  it('does not set limitClamped when limit is under cap', () => {
    const result = engine.aggregate({ docType: docType('client'), groupBy: 'status', limit: 100 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.limitClamped).toBeUndefined();
  });

  it('does not set limitClamped when limit is omitted', () => {
    const result = engine.aggregate({ docType: docType('client'), groupBy: 'status' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.limitClamped).toBeUndefined();
  });

  it('clamps limit when over cap and reports in limitClamped', () => {
    const result = engine.aggregate({ docType: docType('client'), groupBy: 'status', limit: 50000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.limitClamped).toEqual({ requested: 50000, applied: MAX_AGGREGATE_LIMIT });
  });
});
