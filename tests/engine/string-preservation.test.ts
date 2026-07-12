// ============================================================================
// 0.7.3 acceptance — round-trip string preservation (fup-2026-199).
//
// Mirrors T16/T17 in datetime-preservation.test.ts. The 0.6.7 Phase 2 fix
// closed datetime coercion via parser/matter.ts CORE_SCHEMA injection and
// writer/serializer.ts quoted ISO emission, but did not close the broader
// implicit-tag class — string fields whose unquoted YAML form parses back
// as int (`4962218`), float (`1e38892`), bool, or null still corrupted on
// round-trip.
//
// T18 — create with all-digit string, update unrelated field, re-read, verify
//        byte-for-byte identical AND typeof === 'string'.
// T19 — same flow with scientific-notation lookalike (1e38892) which would
//        otherwise parse as Infinity.
// T20 — leading-zero literal that would otherwise lose the zero on int-coerce.
// T21 — `true` / `null` literal strings.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { readFileSync, existsSync, rmSync, cpSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docType, docId } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-string-preservation');

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

describe('T18 — all-digit string preserves type and value on round-trip', () => {
  let filePath = '';

  it('create with title="4962218" → on-disk is quoted, re-read returns string', async () => {
    const created = await engine.createDocument(
      docType('case'),
      {
        title: '4962218',
        client: 'cli-acme',
        status: 'open',
      },
      'Body',
      'cas-string-digits',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    filePath = created.value.filePath;

    const absPath = path.join(TEMP_ROOT, filePath);
    const raw = readFileSync(absPath, 'utf-8');
    expect(raw).toContain('title: "4962218"');
    expect(raw).not.toMatch(/^title: 4962218$/m); // unquoted would coerce to int

    const fetched = await engine.getDocument(docId('cas-string-digits'));
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.frontmatter.title).toBe('4962218');
    expect(typeof fetched.value.frontmatter.title).toBe('string');
  });

  it('update unrelated field → title stays a string with same value', async () => {
    const update = await engine.updateDocument(
      docId('cas-string-digits'),
      { status: 'pending' },
    );
    expect(update.ok).toBe(true);

    const absPath = path.join(TEMP_ROOT, filePath);
    const raw = readFileSync(absPath, 'utf-8');
    expect(raw).toContain('title: "4962218"');

    const fetched = await engine.getDocument(docId('cas-string-digits'));
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.frontmatter.title).toBe('4962218');
    expect(typeof fetched.value.frontmatter.title).toBe('string');
  });
});

describe('T22 - list items preserve scalar type and obey item_type', () => {
  it('string lookalikes in list<string> round-trip byte-for-byte', async () => {
    const tags = ['true', '007', 'null', 'a: b'];
    const created = await engine.createDocument(
      docType('client'),
      { name: 'List fidelity', status: 'active', tags },
      undefined,
      'cli-list-fidelity',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const raw = readFileSync(path.join(TEMP_ROOT, created.value.filePath), 'utf-8');
    expect(raw).toContain('tags: ["true", "007", "null", "a: b"]');

    const fetched = await engine.getDocument(docId('cli-list-fidelity'));
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.frontmatter.tags).toEqual(tags);
    expect((fetched.value.frontmatter.tags as unknown[]).every(item => typeof item === 'string')).toBe(true);
  });

  it('rejects non-string items in list<string>', async () => {
    const created = await engine.createDocument(
      docType('client'),
      { name: 'Bad list', status: 'active', tags: ['valid', true] },
      undefined,
      'cli-bad-list-type',
    );
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.errors.some(error => error.message.includes('tags[1]'))).toBe(true);
  });
});

describe('T19 — scientific-notation lookalike does not coerce to Infinity', () => {
  it('create with title="1e38892" → re-read returns string, not Infinity', async () => {
    const created = await engine.createDocument(
      docType('case'),
      {
        title: '1e38892',
        client: 'cli-acme',
        status: 'open',
      },
      undefined,
      'cas-string-scinot',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const absPath = path.join(TEMP_ROOT, created.value.filePath);
    const raw = readFileSync(absPath, 'utf-8');
    expect(raw).toContain('title: "1e38892"');

    const fetched = await engine.getDocument(docId('cas-string-scinot'));
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.frontmatter.title).toBe('1e38892');
    expect(typeof fetched.value.frontmatter.title).toBe('string');
    expect(fetched.value.frontmatter.title).not.toBe(Infinity);
  });
});

describe('T20 — leading-zero string preserves zero', () => {
  it('create with title="007" → re-read returns "007", not 7', async () => {
    const created = await engine.createDocument(
      docType('case'),
      {
        title: '007',
        client: 'cli-acme',
        status: 'open',
      },
      undefined,
      'cas-string-leading-zero',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const fetched = await engine.getDocument(docId('cas-string-leading-zero'));
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.frontmatter.title).toBe('007');
    expect(typeof fetched.value.frontmatter.title).toBe('string');
  });
});

describe('T21 — keyword-shaped strings preserve type', () => {
  it('title="true" round-trips as string, not boolean', async () => {
    const created = await engine.createDocument(
      docType('case'),
      {
        title: 'true',
        client: 'cli-acme',
        status: 'open',
      },
      undefined,
      'cas-string-true',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const fetched = await engine.getDocument(docId('cas-string-true'));
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.frontmatter.title).toBe('true');
    expect(typeof fetched.value.frontmatter.title).toBe('string');
  });

  it('title="null" round-trips as string, not null', async () => {
    const created = await engine.createDocument(
      docType('case'),
      {
        title: 'null',
        client: 'cli-acme',
        status: 'open',
      },
      undefined,
      'cas-string-null',
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const fetched = await engine.getDocument(docId('cas-string-null'));
    expect(fetched.ok).toBe(true);
    if (!fetched.ok) return;
    expect(fetched.value.frontmatter.title).toBe('null');
    expect(typeof fetched.value.frontmatter.title).toBe('string');
  });
});
