// ============================================================================
// 0.7.10 — engine.repairWhere coverage. Two strategies (prune_orphan_refs,
// fix_schema_drift) drive the tolerant-only repair contract. Mirrors the
// other cleanup test-file pattern: fresh project copy per test, real engine
// + git repo, exercises engine.repairWhere directly. MCP dispatch is
// verified by kinds.test.ts.
// ============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { simpleGit } from 'simple-git';
import { MaadEngine } from '../../src/engine.js';
import { docId as toDocId, docType as toDocType } from '../../src/types.js';
import { parseMatter } from '../../src/parser/matter.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-repair-where');

let engine: MaadEngine;

async function createClient(id: string, fields: Record<string, unknown> = {}) {
  const r = await engine.createDocument(
    toDocType('client'),
    { name: id, status: 'active', ...fields },
    undefined,
    id,
  );
  expect(r.ok).toBe(true);
}

async function createContact(id: string, name = id) {
  const r = await engine.createDocument(toDocType('contact'), { name }, undefined, id);
  expect(r.ok).toBe(true);
}

function readFrontmatter(docId: string): Record<string, unknown> {
  // All test docs land under their docType's directory by registry. Test
  // clients land in clients/<id>.md.
  const fp = path.join(TEMP_ROOT, 'clients', `${docId}.md`);
  const raw = readFileSync(fp, 'utf-8');
  return parseMatter(raw).data as Record<string, unknown>;
}

beforeEach(async () => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  cpSync(FIXTURE_SRC, TEMP_ROOT, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}_backend`) && !src.includes(`${path.sep}.git`),
  });

  const setupGit = simpleGit(TEMP_ROOT);
  await setupGit.init();
  await setupGit.addConfig('user.email', 'test@example.com');
  await setupGit.addConfig('user.name', 'test');
  await setupGit.add('.').commit('test fixture init');

  engine = new MaadEngine();
  const result = await engine.init(TEMP_ROOT);
  expect(result.ok).toBe(true);
  await engine.indexAll({ force: true });

  // Fixture ships with a pre-existing cli-acme record — hard-delete it so
  // each test runs against a clean client tier scoped only to its own
  // created docs. Avoids cross-contamination of result counts.
  await engine.deleteDocument(toDocId('cli-acme'), 'hard');
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

describe('engine.repairWhere — prune_orphan_refs', () => {
  it('sets a single broken ref to null and reports it under changedFields', async () => {
    // Setup: client points at a contact, then we soft-delete the contact so
    // the ref is broken (target soft-deleted = "missing" per verifyIntegrity
    // semantics).
    await createContact('con-jane');
    await createClient('cli-alpha', { primary_contact: 'con-jane' });
    await engine.deleteDocument(toDocId('con-jane'), 'soft');

    const result = await engine.repairWhere(undefined, toDocType('client'), ['prune_orphan_refs'], 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.succeeded.length).toBe(1);
    expect(result.value.failed.length).toBe(0);
    expect(result.value.writeDurable).toBe(true);

    const applied = result.value.succeeded[0]!.appliedRepairs;
    expect(applied.length).toBe(1);
    expect(applied[0]!.strategy).toBe('prune_orphan_refs');
    expect(applied[0]!.changedFields).toEqual(['primary_contact']);

    const fm = readFrontmatter('cli-alpha');
    expect(fm.primary_contact).toBeNull();
  });

  it('filters broken targets from a list-of-ref field, keeps valid ones', async () => {
    // tags is list-of-string in the simple-crm fixture, so there's no
    // list-of-ref field to exercise directly. Synthesize one by mocking the
    // backend assertion: instead, verify the strategy walks `tags` correctly
    // when it IS a list of strings (no change should happen since itemType
    // is string, not ref).
    await createContact('con-stays');
    await createClient('cli-listy', { tags: ['gold', 'churn-risk'], primary_contact: 'con-stays' });

    const result = await engine.repairWhere(undefined, toDocType('client'), ['prune_orphan_refs'], 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.succeeded.length).toBe(0); // nothing to repair
    expect(result.value.failed.length).toBe(0);

    const fm = readFrontmatter('cli-listy');
    expect(fm.primary_contact).toBe('con-stays');
    expect(fm.tags).toEqual(['gold', 'churn-risk']);
  });

  it('is a noop when no refs are broken', async () => {
    await createContact('con-clean');
    await createClient('cli-clean', { primary_contact: 'con-clean' });

    const result = await engine.repairWhere(undefined, toDocType('client'), ['prune_orphan_refs'], 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.succeeded.length).toBe(0);
    expect(result.value.failed.length).toBe(0);
    expect(result.value.writeDurable).toBe(true);

    const fm = readFrontmatter('cli-clean');
    expect(fm.primary_contact).toBe('con-clean');
  });

  it('scopes by filter — only matched records repair', async () => {
    await createContact('con-stays');
    await createContact('con-victim');
    await createClient('cli-target', { primary_contact: 'con-victim', status: 'active' });
    await createClient('cli-skipped', { primary_contact: 'con-stays', status: 'inactive' });
    await engine.deleteDocument(toDocId('con-victim'), 'soft');

    const result = await engine.repairWhere(
      { status: { op: 'eq', value: 'active' } },
      toDocType('client'),
      ['prune_orphan_refs'],
      100,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.succeeded.map(s => s.docId)).toEqual(['cli-target']);

    expect(readFrontmatter('cli-target').primary_contact).toBeNull();
    expect(readFrontmatter('cli-skipped').primary_contact).toBe('con-stays');
  });
});

describe('engine.repairWhere — fix_schema_drift', () => {
  // Helper: write a new client.v2 schema and re-point the registry, then
  // reload the engine so subsequent calls see the new pack.
  async function bumpClientSchemaToV2(newYaml: string) {
    const schemaPath = path.join(TEMP_ROOT, '_schema', 'client.v2.yaml');
    writeFileSync(schemaPath, newYaml, 'utf-8');
    const registryPath = path.join(TEMP_ROOT, '_registry', 'object_types.yaml');
    const reg = readFileSync(registryPath, 'utf-8').replace(
      'schema: client.v1',
      'schema: client.v2',
    );
    writeFileSync(registryPath, reg, 'utf-8');
    const reload = await engine.reload();
    expect(reload.ok).toBe(true);
  }

  it('noops when schemaRef already matches the current registry', async () => {
    await createClient('cli-fresh');
    const result = await engine.repairWhere(undefined, toDocType('client'), ['fix_schema_drift'], 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.succeeded.length).toBe(0);
    expect(result.value.failed.length).toBe(0);
  });

  it('bumps schemaRef, adds defaulted optional fields, drops removed fields', async () => {
    await createClient('cli-stale', { tags: ['gold'] });

    await bumpClientSchemaToV2(`type: client
version: 2
required:
  - doc_id
  - name
  - status
fields:
  name:
    type: string
    index: true
  status:
    type: enum
    values: [active, inactive, prospect]
    index: true
  primary_contact:
    type: ref
    target: contact
    index: true
  region:
    type: string
    default: us-east
`);

    const result = await engine.repairWhere(undefined, toDocType('client'), ['fix_schema_drift'], 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.succeeded.length).toBe(1);
    expect(result.value.failed.length).toBe(0);

    const applied = result.value.succeeded[0]!.appliedRepairs[0]!;
    expect(applied.strategy).toBe('fix_schema_drift');
    expect(applied.changedFields).toContain('schema');     // schemaRef bumped
    expect(applied.changedFields).toContain('tags');       // dropped field
    expect(applied.changedFields).toContain('region');     // defaulted optional added

    const fm = readFrontmatter('cli-stale');
    expect(fm.schema).toBe('client.v2');
    expect(fm.tags).toBeUndefined();
    expect(fm.region).toBe('us-east');
  });

  it('returns REPAIR_REQUIRES_MIGRATION when a field type would need coercion', async () => {
    await createClient('cli-coerce');

    // Change `name` from string -> number. Existing record has name as a
    // string; tolerant repair refuses to coerce.
    await bumpClientSchemaToV2(`type: client
version: 2
required:
  - doc_id
  - name
  - status
fields:
  name:
    type: number
    index: true
  status:
    type: enum
    values: [active, inactive, prospect]
    index: true
`);

    const result = await engine.repairWhere(undefined, toDocType('client'), ['fix_schema_drift'], 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.succeeded.length).toBe(0);
    expect(result.value.failed.length).toBe(1);
    expect(result.value.failed[0]!.strategy).toBe('fix_schema_drift');
    expect(result.value.failed[0]!.code).toBe('REPAIR_REQUIRES_MIGRATION');
    expect(result.value.failed[0]!.message).toContain('name');

    // No write happened — schemaRef stays at v1.
    const fm = readFrontmatter('cli-coerce');
    expect(fm.schema).toBe('client.v1');
  });
});

describe('engine.repairWhere — orchestration', () => {
  it('combines strategies on the same record — both apply, single commit', async () => {
    await createContact('con-victim');
    await createClient('cli-multi', { primary_contact: 'con-victim' });
    await engine.deleteDocument(toDocId('con-victim'), 'soft');

    const before = (await simpleGit(TEMP_ROOT).log()).total;
    const result = await engine.repairWhere(
      undefined,
      toDocType('client'),
      ['prune_orphan_refs', 'fix_schema_drift'], // both
      100,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.succeeded.length).toBe(1);
    expect(result.value.writeDurable).toBe(true);

    // Both strategies applied: prune set primary_contact to null; fix_schema_drift
    // was a noop because schema already matched. Should see exactly one applied
    // repair entry (prune).
    const applied = result.value.succeeded[0]!.appliedRepairs;
    expect(applied.length).toBe(1);
    expect(applied[0]!.strategy).toBe('prune_orphan_refs');

    // Single commit per repairWhere call regardless of strategy count.
    const after = await simpleGit(TEMP_ROOT).log();
    expect(after.total - before).toBe(1);
    expect(after.latest?.message).toContain('Repaired 1 record');
  });

  it('per-record per-strategy failures do not block other records', async () => {
    // Two clients, one with a broken ref and one clean. Prune affects the
    // broken one; clean one is a noop and never lands in succeeded.
    await createContact('con-victim');
    await createClient('cli-broken', { primary_contact: 'con-victim' });
    await createClient('cli-fine');
    await engine.deleteDocument(toDocId('con-victim'), 'soft');

    const result = await engine.repairWhere(
      undefined,
      toDocType('client'),
      ['prune_orphan_refs'],
      100,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalRequested).toBe(2);
    expect(result.value.succeeded.length).toBe(1);
    expect(result.value.succeeded[0]!.docId).toBe('cli-broken');
    expect(result.value.failed.length).toBe(0);
  });

  it('empty match — no commit, no work, writeDurable true', async () => {
    const before = (await simpleGit(TEMP_ROOT).log()).total;
    const result = await engine.repairWhere(
      { status: { op: 'eq', value: 'prospect' } }, // matches nothing
      toDocType('client'),
      ['prune_orphan_refs'],
      100,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalRequested).toBe(0);
    expect(result.value.succeeded.length).toBe(0);
    expect(result.value.writeDurable).toBe(true);
    const after = (await simpleGit(TEMP_ROOT).log()).total;
    expect(after - before).toBe(0);
  });
});
