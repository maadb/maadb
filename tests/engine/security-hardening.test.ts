// ============================================================================
// 0.7.6 — Parser / write-path fuzz & security tests.
//
// Acceptance from the followup:
//   1. Engine rejects unsafe doc IDs/paths consistently
//   2. Malformed records return structured errors without corrupting
//      repo/index state
//   3. Size limits are enforced below parser exhaustion (not in scope for
//      this slice — body/frontmatter caps tracked in follow-on)
//   4. Extraction/indexing failures are contained
//   5. Test fixtures cover create/update/reindex flows
//
// This suite focuses on the highest-ROI surface: docId boundary validation
// (path traversal, control chars, Windows-reserved, oversize), defense-in-
// depth path containment, and graceful handling of malformed YAML in the
// reindex path. Body/frontmatter size caps are a follow-on.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync, readdirSync, writeFileSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docType } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-security-hardening');
const CASES_DIR = path.join(TEMP_ROOT, 'cases');

let engine: MaadEngine;

beforeAll(async () => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, maxRetries: 10, retryDelay: 200 });
  cpSync(FIXTURE_SRC, TEMP_ROOT, { recursive: true });
  const backendDir = path.join(TEMP_ROOT, '_backend');
  if (existsSync(backendDir)) rmSync(backendDir, { recursive: true, maxRetries: 10, retryDelay: 200 });

  engine = new MaadEngine();
  const result = await engine.init(TEMP_ROOT);
  expect(result.ok).toBe(true);
  await engine.indexAll({ force: true });
});

afterAll(async () => {
  engine.close();
  await new Promise(r => setTimeout(r, 100));
  try {
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Windows handle release race — non-fatal
  }
});

function countCaseFiles(): number {
  return readdirSync(CASES_DIR).filter((f) => f.endsWith('.md')).length;
}

// Snapshot the cases dir so we can confirm hostile creates don't leave files behind.
function caseFiles(): string[] {
  return readdirSync(CASES_DIR).filter((f) => f.endsWith('.md')).sort();
}

const VALID_FIELDS = { title: 'Test', client: 'cli-acme', status: 'open' as const };

describe('createDocument — hostile docId rejected with INVALID_DOC_ID; no on-disk artifact', () => {
  const HOSTILE_IDS = [
    '../escape',
    '..\\escape',
    'foo/bar',
    'foo\\bar',
    '/etc/passwd',
    'C:\\Windows\\System32',
    'foo..bar',
    '.hidden',
    'foo\x00null',
    'foo\nbar',
    'CON',
    'NUL',
    'aux',
    'lpt1',
    'café',
    '$(whoami)',
    '<script>alert(1)</script>',
    '',
    'a' + 'b'.repeat(200), // oversize
  ];

  it.each(HOSTILE_IDS)('rejects docId %j with INVALID_DOC_ID', async (badId) => {
    const before = caseFiles();
    const result = await engine.createDocument(
      docType('case'),
      VALID_FIELDS,
      'body',
      badId,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]!.code).toBe('INVALID_DOC_ID');
    // No file was created in the cases dir as a side effect.
    expect(caseFiles()).toEqual(before);
  });
});

describe('bulkCreate — hostile docIds rejected per-record without aborting batch', () => {
  it('mixes safe + hostile records; only safe records succeed', async () => {
    const before = countCaseFiles();
    const result = await engine.bulkCreate([
      { docType: 'case', fields: { ...VALID_FIELDS, title: 'good-1' }, docId: 'cas-bulk-good-1' },
      { docType: 'case', fields: VALID_FIELDS, docId: '../bulk-escape' },
      { docType: 'case', fields: VALID_FIELDS, docId: 'foo/bar' },
      { docType: 'case', fields: { ...VALID_FIELDS, title: 'good-2' }, docId: 'cas-bulk-good-2' },
      { docType: 'case', fields: VALID_FIELDS, docId: 'CON' },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bulk = result.value;
    expect(bulk.succeeded).toHaveLength(2);
    expect(bulk.failed).toHaveLength(3);
    for (const f of bulk.failed) {
      expect(f.error).toMatch(/INVALID_DOC_ID/);
    }
    // Only +2 files in the cases dir (the two valid ones).
    expect(countCaseFiles()).toBe(before + 2);
  });
});

describe('reindex — malformed YAML in a placed file produces structured error, not a crash', () => {
  it('a hand-placed file with broken YAML surfaces in indexAll errors[]; other files still indexed', async () => {
    const broken = path.join(CASES_DIR, 'broken-yaml.md');
    // Unclosed flow mapping → js-yaml throws with a structured error.
    writeFileSync(
      broken,
      '---\ndoc_id: broken\ndoc_type: case\nfoo: { unclosed\n---\nbody\n',
      'utf-8',
    );

    try {
      const r = await engine.indexAll({ force: true });
      expect(r.errors.length).toBeGreaterThan(0);
      const codes = r.errors.map((e) => e.code);
      // Acceptable codes: PARSE_ERROR for yaml-broken, or YAML_PROFILE_VIOLATION.
      // What matters is the error is structured (not a thrown exception).
      expect(codes.some((c) => c === 'PARSE_ERROR' || c === 'YAML_PROFILE_VIOLATION' || c === 'VALIDATION_FAILED')).toBe(true);
      // Non-broken files still indexed.
      expect(r.indexed).toBeGreaterThan(0);
    } finally {
      // Clean up so subsequent tests don't see the broken file.
      if (existsSync(broken)) rmSync(broken);
      await engine.indexAll({ force: true });
    }
  });

  it('a file with frontmatter referencing a non-existent doc_type returns UNKNOWN_TYPE', async () => {
    const stranger = path.join(CASES_DIR, 'unknown-type.md');
    writeFileSync(
      stranger,
      '---\ndoc_id: cas-stranger\ndoc_type: martian\ntitle: x\nclient: cli-acme\nstatus: open\n---\n',
      'utf-8',
    );
    try {
      const r = await engine.indexAll({ force: true });
      const codes = r.errors.map((e) => e.code);
      expect(codes).toContain('UNKNOWN_TYPE');
    } finally {
      if (existsSync(stranger)) rmSync(stranger);
      await engine.indexAll({ force: true });
    }
  });
});

describe('createDocument — body and frontmatter content survive HTML/script/control-char content', () => {
  it('body containing HTML/script tags is stored verbatim (engine does not render)', async () => {
    const body = '<script>alert("xss")</script>\n<img src=x onerror=alert(1)>\nplain text';
    const r = await engine.createDocument(
      docType('case'),
      { ...VALID_FIELDS, title: 'html-body' },
      body,
      'cas-html-body',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const fetched = await engine.getDocument(r.value.docId, 'cold');
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.body).toContain('<script>');
    expect(fetched.value.body).toContain('alert');
  });

  it('frontmatter string field with quotes/backslashes round-trips correctly', async () => {
    const tricky = 'has "quotes" and \\ backslash and # hash';
    const r = await engine.createDocument(
      docType('case'),
      { ...VALID_FIELDS, title: tricky },
      undefined,
      'cas-tricky-title',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const fetched = await engine.getDocument(r.value.docId);
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.frontmatter.title).toBe(tricky);
  });
});
