import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { extractBody, appendToBody } from '../../src/writer/index.js';
import { MaadEngine } from '../../src/engine.js';
import { docId } from '../../src/types.js';

const LF_DOC = '---\ntitle: Test\nstatus: active\n---\n\nBody line one.\n\nBody line two.\n';
const CRLF_DOC = LF_DOC.replace(/\n/g, '\r\n');
const BOM = String.fromCharCode(0xfeff);

describe('extractBody line-ending tolerance', () => {
  it('extracts body from an LF document', () => {
    expect(extractBody(LF_DOC)).toBe('Body line one.\n\nBody line two.');
  });

  it('extracts body from a CRLF document without leaking frontmatter', () => {
    const body = extractBody(CRLF_DOC);
    expect(body).not.toContain('---');
    expect(body).not.toContain('title:');
    expect(body).toBe('Body line one.\n\nBody line two.');
  });

  it('extracts body from a BOM-prefixed document', () => {
    const body = extractBody(BOM + LF_DOC);
    expect(body).not.toContain('---');
    expect(body).toBe('Body line one.\n\nBody line two.');
  });

  it('extracts body from a BOM-prefixed CRLF document', () => {
    const body = extractBody(BOM + CRLF_DOC);
    expect(body).not.toContain('---');
    expect(body).toBe('Body line one.\n\nBody line two.');
  });

  it('handles a frontmatter-only CRLF document', () => {
    const fmOnly = '---\r\ntitle: Test\r\n---\r\n';
    expect(extractBody(fmOnly)).toBe('');
  });

  it('normalizes CRLF inside the extracted body', () => {
    expect(extractBody(CRLF_DOC)).not.toContain('\r');
  });
});

describe('appendToBody line-ending tolerance', () => {
  it('appends after the body on an LF document', () => {
    const out = appendToBody(LF_DOC, 'Appended.');
    expect(out).toContain('Body line two.\n\nAppended.\n');
    expect(out.indexOf('---')).toBe(0);
  });

  it('appends after the body on a CRLF document without duplicating frontmatter', () => {
    const out = appendToBody(CRLF_DOC, 'Appended.');
    // Exactly one frontmatter block: opening + closing delimiters only
    const delimiters = out.match(/^---\r?$/gm) ?? [];
    expect(delimiters.length).toBe(2);
    expect(out).toContain('Appended.');
  });
});

// End-to-end regression: updating a CRLF file on disk must not wrap new
// frontmatter around the old one.
const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-crlf-update');

describe('updateDocument on a CRLF file', () => {
  let engine: MaadEngine;

  beforeAll(async () => {
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, maxRetries: 10, retryDelay: 200 });
    cpSync(FIXTURE_SRC, TEMP_ROOT, { recursive: true });
    const backendDir = path.join(TEMP_ROOT, '_backend');
    if (existsSync(backendDir)) rmSync(backendDir, { recursive: true, maxRetries: 10, retryDelay: 200 });

    // Rewrite one fixture record with CRLF line endings, as a Windows editor would
    const target = path.join(TEMP_ROOT, 'clients', 'cli-acme.md');
    const raw = readFileSync(target, 'utf-8');
    writeFileSync(target, raw.replace(/\r?\n/g, '\r\n'), 'utf-8');

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
      // Windows may hold handles briefly — non-fatal
    }
  });

  it('does not duplicate frontmatter into the body', async () => {
    const result = await engine.updateDocument(docId('cli-acme'), { status: 'inactive' });
    expect(result.ok).toBe(true);

    const written = readFileSync(path.join(TEMP_ROOT, 'clients', 'cli-acme.md'), 'utf-8');
    const delimiters = written.match(/^---$/gm) ?? [];
    expect(delimiters.length).toBe(2);

    const body = extractBody(written);
    expect(body).not.toContain('doc_id:');
    expect(body).not.toContain('doc_type:');
  });

  it('append on a CRLF file keeps a single frontmatter block', async () => {
    const result = await engine.updateDocument(docId('cli-acme'), undefined, undefined, 'Appended note.');
    expect(result.ok).toBe(true);

    const written = readFileSync(path.join(TEMP_ROOT, 'clients', 'cli-acme.md'), 'utf-8');
    const delimiters = written.match(/^---$/gm) ?? [];
    expect(delimiters.length).toBe(2);
    expect(written).toContain('Appended note.');
  });
});
