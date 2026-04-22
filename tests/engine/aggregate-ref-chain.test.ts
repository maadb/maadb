// 0.7.1 R1 — multi-hop ref traversal in aggregate.groupBy
//
// Grammar: "ref_field->ref_field->leaf_field" — arbitrary depth N.
// Validation at query time: each non-leaf segment must be a ref on its parent type.
// Runtime: aggregate at first hop, resolve remaining hops per group, merge groups
// with the same resolved key. Broken refs bin under '__unresolved__' as a visible
// group; never fail the query.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docType } from '../../src/types.js';
import { UNRESOLVED_GROUP_KEY } from '../../src/engine/reads.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-aggregate-ref-chain');

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

  // Seed two additional clients, three more cases across them, and six case_notes
  // so we have enough data to exercise merge behavior after chain resolution.
  const cli2 = await engine.createDocument(docType('client'), { name: 'Beta Inc', status: 'active' }, 'Beta');
  const cli3 = await engine.createDocument(docType('client'), { name: 'Gamma LLC', status: 'prospect' }, 'Gamma');
  expect(cli2.ok).toBe(true);
  expect(cli3.ok).toBe(true);
  if (!cli2.ok || !cli3.ok) return;

  // cas-2026-001 already exists against cli-acme (from fixture; status=open per fixture content).
  // Add two more against Beta and one more against Gamma.
  const cas2 = await engine.createDocument(docType('case'), {
    title: 'Beta case A', client: cli2.value.docId, status: 'open',
  }, 'Beta case A');
  const cas3 = await engine.createDocument(docType('case'), {
    title: 'Beta case B', client: cli2.value.docId, status: 'closed',
  }, 'Beta case B');
  const cas4 = await engine.createDocument(docType('case'), {
    title: 'Gamma case', client: cli3.value.docId, status: 'open',
  }, 'Gamma case');
  expect(cas2.ok).toBe(true);
  expect(cas3.ok).toBe(true);
  expect(cas4.ok).toBe(true);
  if (!cas2.ok || !cas3.ok || !cas4.ok) return;

  // case_notes: distribute across the cases. noted_at fixed for determinism.
  await engine.createDocument(docType('case_note'), { case: cas2.value.docId, author: 'a', noted_at: '2026-04-01' }, 'n1');
  await engine.createDocument(docType('case_note'), { case: cas2.value.docId, author: 'a', noted_at: '2026-04-02' }, 'n2');
  await engine.createDocument(docType('case_note'), { case: cas3.value.docId, author: 'b', noted_at: '2026-04-01' }, 'n3');
  await engine.createDocument(docType('case_note'), { case: cas4.value.docId, author: 'a', noted_at: '2026-04-02' }, 'n4');
  await engine.createDocument(docType('case_note'), { case: cas4.value.docId, author: 'b', noted_at: '2026-04-03' }, 'n5');
  // Existing note-2026-04-06-001 references cas-2026-001 (fixture → cli-acme, status open)

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

describe('aggregate ref chain — validation', () => {
  it('rejects chain without docType', () => {
    const result = engine.aggregate({ groupBy: 'case->status' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('SCHEMA_REF_CHAIN_INVALID');
  });

  it('rejects unknown field in chain', () => {
    const result = engine.aggregate({ docType: docType('case_note'), groupBy: 'not_a_field->status' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('SCHEMA_REF_CHAIN_INVALID');
    expect(result.errors[0]!.message).toContain('not_a_field');
  });

  it('rejects non-ref middle segment', () => {
    // author is a string field on case_note, not a ref. Using it as a non-leaf fails.
    const result = engine.aggregate({ docType: docType('case_note'), groupBy: 'author->name' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('SCHEMA_REF_CHAIN_INVALID');
    expect(result.errors[0]!.message).toContain('must be a ref');
  });

  it('rejects empty middle segment', () => {
    const result = engine.aggregate({ docType: docType('case_note'), groupBy: 'case->->status' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('SCHEMA_REF_CHAIN_INVALID');
  });

  it('rejects single-segment groupBy containing -> (malformed)', () => {
    const result = engine.aggregate({ docType: docType('case_note'), groupBy: 'case->' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('SCHEMA_REF_CHAIN_INVALID');
  });
});

describe('aggregate ref chain — one-hop resolution', () => {
  it('groups case_notes by their case\'s status', () => {
    const result = engine.aggregate({
      docType: docType('case_note'),
      groupBy: 'case->status',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Expected: 6 total case_notes. Status distribution:
    //   cas-2026-001 (open): 1 note (fixture)
    //   Beta case A (open):  2 notes
    //   Beta case B (closed): 1 note
    //   Gamma case (open):   2 notes
    // → open=5, closed=1
    const byKey = new Map(result.value.groups.map(g => [g.value, g.count]));
    expect(byKey.get('open')).toBe(5);
    expect(byKey.get('closed')).toBe(1);
    expect(result.value.total).toBe(6);
  });
});

describe('aggregate ref chain — two-hop resolution', () => {
  it('groups case_notes by their case\'s client\'s name (canonical jrn-2026-093 shape)', () => {
    const result = engine.aggregate({
      docType: docType('case_note'),
      groupBy: 'case->client->name',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Expected: 6 notes distributed across 3 clients.
    //   Acme Corporation: 1 (via cas-2026-001 + note-2026-04-06-001)
    //   Beta Inc:          3 (via Beta case A + Beta case B)
    //   Gamma LLC:         2 (via Gamma case)
    const byKey = new Map(result.value.groups.map(g => [g.value, g.count]));
    expect(byKey.get('Beta Inc')).toBe(3);
    expect(byKey.get('Gamma LLC')).toBe(2);
    // Acme Corporation fixture name may vary; check a third group exists.
    expect(result.value.groups.length).toBeGreaterThanOrEqual(3);
    expect(result.value.total).toBe(6);
  });

  it('groups case_notes by their case\'s client\'s status — merges same-status clients', () => {
    const result = engine.aggregate({
      docType: docType('case_note'),
      groupBy: 'case->client->status',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Expected status distribution via client:
    //   Acme (active):    1 note
    //   Beta (active):    3 notes
    //   Gamma (prospect): 2 notes
    // → active=4, prospect=2
    const byKey = new Map(result.value.groups.map(g => [g.value, g.count]));
    expect(byKey.get('active')).toBe(4);
    expect(byKey.get('prospect')).toBe(2);
    expect(result.value.total).toBe(6);
  });
});

describe('aggregate ref chain — broken ref handling', () => {
  it('bins records with broken refs under __unresolved__ (soft signal, not failure)', async () => {
    // Create a case_note that points to a nonexistent case (soft-broken ref).
    // Engine writes validate-against-schema but ref target existence isn't a hard gate at write time.
    const badNote = await engine.createDocument(docType('case_note'), {
      case: 'cas-does-not-exist', author: 'x', noted_at: '2026-04-04',
    }, 'broken ref note');
    // If the engine rejects broken refs outright, this test is moot — skip.
    if (!badNote.ok) return;

    await engine.indexAll({ force: true });

    const result = engine.aggregate({
      docType: docType('case_note'),
      groupBy: 'case->status',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hasUnresolved = result.value.groups.some(g => g.value === UNRESOLVED_GROUP_KEY);
    expect(hasUnresolved).toBe(true);

    // Cleanup so subsequent tests see the original corpus.
    await engine.deleteDocument(badNote.value.docId);
    await engine.indexAll({ force: true });
  });
});
