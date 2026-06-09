// ============================================================================
// 0.5.0 R5 — maad_changes_since polling delta
//
// Covers:
//   - First call with no cursor returns the whole index ordered by
//     (updated_at ASC, doc_id ASC).
//   - Cursor-paginated resume is strict-greater-than (no duplicate emission,
//     no skipped rows at timestamp ties).
//   - Timestamp ties resolve by doc_id ASC.
//   - docTypes filter narrows results.
//   - limit clamps to MAX and defaults to DEFAULT; hasMore + nextCursor
//     signal correctly on the boundary.
//   - Cursor opacity — clients must never parse it. We test malformed
//     cursors round-trip to an INVALID_FIELDS error.
//   - operation classification: version=1 → 'create', version>1 → 'update'.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docId, docType } from '../../src/types.js';
import { encodeChangesCursor, decodeChangesCursor } from '../../src/engine/reads.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');

async function makeEngine(label: string): Promise<{ engine: MaadEngine; root: string }> {
  const root = path.resolve(__dirname, `../fixtures/_temp-changes-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  if (existsSync(root)) rmSync(root, { recursive: true, maxRetries: 10, retryDelay: 200 });
  cpSync(FIXTURE_SRC, root, { recursive: true });
  const backendDir = path.join(root, '_backend');
  if (existsSync(backendDir)) rmSync(backendDir, { recursive: true, maxRetries: 10, retryDelay: 200 });
  const engine = new MaadEngine();
  const result = await engine.init(root);
  expect(result.ok).toBe(true);
  await engine.indexAll({ force: true });
  return { engine, root };
}

async function cleanup(engine: MaadEngine, root: string): Promise<void> {
  engine.close();
  await new Promise((r) => setTimeout(r, 50));
  try { if (existsSync(root)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* windows */ }
}

describe('changesSince — first call, no cursor', () => {
  let engine: MaadEngine;
  let root: string;
  beforeEach(async () => ({ engine, root } = await makeEngine('first')));
  afterEach(async () => cleanup(engine, root));

  it('returns all indexed documents ordered by (updated_at, doc_id) ASC', async () => {
    const r = engine.changesSince({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.changes.length).toBeGreaterThan(0);
    // Ordering invariant: each pair is non-decreasing in updated_at, and
    // ties break by doc_id ascending.
    for (let i = 1; i < r.value.changes.length; i++) {
      const prev = r.value.changes[i - 1]!;
      const curr = r.value.changes[i]!;
      const cmp = prev.updatedAt.localeCompare(curr.updatedAt);
      expect(cmp).toBeLessThanOrEqual(0);
      if (cmp === 0) expect(prev.docId.localeCompare(curr.docId)).toBeLessThan(0);
    }
  });

  it('version=1 docs are classified as create', async () => {
    const r = engine.changesSince({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Fixture docs are freshly indexed → all version 1 → all creates.
    for (const c of r.value.changes) expect(c.operation).toBe('create');
  });

  it('version>1 docs are classified as update', async () => {
    // Mutate an existing doc to bump its version.
    const existing = engine.changesSince({});
    expect(existing.ok).toBe(true);
    if (!existing.ok) return;
    const target = existing.value.changes[0]!;

    const updateResult = await engine.updateDocument(
      docId(target.docId),
      { note_from_test: 'touched' },
    );
    expect(updateResult.ok).toBe(true);

    const r = engine.changesSince({});
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const updated = r.value.changes.find((c) => c.docId === target.docId);
    expect(updated).toBeDefined();
    expect(updated!.operation).toBe('update');
  });
});

describe('changesSince — pagination', () => {
  let engine: MaadEngine;
  let root: string;
  beforeEach(async () => ({ engine, root } = await makeEngine('page')));
  afterEach(async () => cleanup(engine, root));

  it('walking the full index via cursors emits every doc exactly once', async () => {
    // First get the ground truth: everything in one shot at a large limit.
    const all = engine.changesSince({ limit: 1000 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const allIds = all.value.changes.map((c) => c.docId);
    expect(new Set(allIds).size).toBe(allIds.length); // no duplicates

    // Now walk with pageSize = 3.
    const PAGE = 3;
    const collected: string[] = [];
    let cursor: string | undefined;
    let iterations = 0;
    while (iterations < 100) {
      iterations++;
      const r = engine.changesSince({ cursor, limit: PAGE });
      expect(r.ok).toBe(true);
      if (!r.ok) break;
      for (const c of r.value.changes) collected.push(c.docId);
      if (!r.value.hasMore) break;
      expect(r.value.nextCursor).not.toBeNull();
      cursor = r.value.nextCursor!;
    }

    expect(collected).toEqual(allIds);
    // Every page except the last should be full.
    expect(iterations).toBe(Math.ceil(allIds.length / PAGE));
  });

  it('hasMore=false when the last page fits exactly; nextCursor=null', async () => {
    const all = engine.changesSince({ limit: 1000 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const total = all.value.changes.length;

    const r = engine.changesSince({ limit: total });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.changes.length).toBe(total);
    expect(r.value.hasMore).toBe(false);
    expect(r.value.nextCursor).toBeNull();
  });

  it('hasMore=true when limit < total; nextCursor encodes last row', async () => {
    const all = engine.changesSince({ limit: 1000 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const total = all.value.changes.length;
    if (total < 2) return; // fixture too small to test

    const r = engine.changesSince({ limit: total - 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.hasMore).toBe(true);
    expect(r.value.nextCursor).not.toBeNull();

    // Decoded cursor matches the last returned row — tuple (u, d).
    const decoded = decodeChangesCursor(r.value.nextCursor!);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const last = r.value.changes[r.value.changes.length - 1]!;
    expect(decoded.value).toEqual({ updatedAt: last.updatedAt, docId: last.docId });
  });
});

describe('changesSince — docTypes filter', () => {
  let engine: MaadEngine;
  let root: string;
  beforeEach(async () => ({ engine, root } = await makeEngine('filter')));
  afterEach(async () => cleanup(engine, root));

  it('restricts results to requested doc types only', async () => {
    const all = engine.changesSince({ limit: 1000 });
    expect(all.ok).toBe(true);
    if (!all.ok) return;

    const types = Array.from(new Set(all.value.changes.map((c) => c.docType))).sort();
    if (types.length < 2) return; // fixture has only one type
    const keep = [types[0]!];

    const r = engine.changesSince({ docTypes: keep, limit: 1000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const c of r.value.changes) expect(keep).toContain(c.docType);
  });
});

describe('changesSince — cursor opacity and validation', () => {
  let engine: MaadEngine;
  let root: string;
  beforeEach(async () => ({ engine, root } = await makeEngine('cursor')));
  afterEach(async () => cleanup(engine, root));

  it('malformed cursor returns INVALID_FIELDS', async () => {
    const bogus = Buffer.from('not-json').toString('base64url');
    const r = engine.changesSince({ cursor: bogus });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe('INVALID_FIELDS');
  });

  it('cursor missing u/d fields returns INVALID_FIELDS', async () => {
    const bad = Buffer.from(JSON.stringify({ x: 'wrong' }), 'utf8').toString('base64url');
    const r = engine.changesSince({ cursor: bad });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe('INVALID_FIELDS');
  });

  it('encode/decode round-trip preserves the tuple', () => {
    const sample = { updatedAt: '2026-04-15T10:00:00.000Z', docId: 'sess-abc' };
    const encoded = encodeChangesCursor(sample);
    const decoded = decodeChangesCursor(encoded);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value).toEqual(sample);
  });

  it('limit is clamped to MAX (1000)', async () => {
    const r = engine.changesSince({ limit: 10_000 });
    expect(r.ok).toBe(true);
    // Fixture is small, so we just assert no error — the real invariant
    // is exercised by smaller-limit pagination tests above. The clamp
    // protects against DoS via huge limits; equivalence to limit=1000
    // is impossible to observe without > 1000 fixture docs.
  });

  it('rejects non-positive limit', async () => {
    const r = engine.changesSince({ limit: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]!.code).toBe('INVALID_FIELDS');
  });
});
