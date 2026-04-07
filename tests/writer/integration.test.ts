import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync, rmSync, cpSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docType } from '../../src/types.js';

const FIXTURE_SRC = path.resolve(__dirname, '../fixtures/simple-crm');
const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-writer');

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

describe('template body generation', () => {
  it('generates heading structure when no body provided', async () => {
    const result = await engine.createDocument(
      docType('case'),
      {
        title: 'IP Licensing Review',
        client: 'cli-acme',
        status: 'open',
        priority: 'medium',
        opened_at: '2026-04-06',
      },
      undefined, // no body — should use template
      'cas-template-test',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Read the generated file
    const fp = path.join(TEMP_ROOT, 'cases', 'cas-template-test.md');
    expect(existsSync(fp)).toBe(true);

    const content = await readFile(fp, 'utf-8');

    // Should have template headings with {{title}} resolved
    expect(content).toContain('# IP Licensing Review {#summary}');
    expect(content).toContain('## Details {#details}');
    expect(content).toContain('## Timeline {#timeline}');
    expect(content).toContain('## Notes {#notes}');
  });

  it('uses explicit body when provided (ignores template)', async () => {
    const result = await engine.createDocument(
      docType('case'),
      {
        title: 'Custom Body Case',
        client: 'cli-acme',
        status: 'pending',
        priority: 'low',
        opened_at: '2026-04-06',
      },
      '# My Custom Structure\n\nThis is a custom body.',
      'cas-custom-body',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fp = path.join(TEMP_ROOT, 'cases', 'cas-custom-body.md');
    const content = await readFile(fp, 'utf-8');

    expect(content).toContain('# My Custom Structure');
    expect(content).toContain('This is a custom body.');
    // Should NOT contain template headings
    expect(content).not.toContain('{#summary}');
    expect(content).not.toContain('{#details}');
  });

  it('generates deterministic frontmatter field order', async () => {
    const result = await engine.createDocument(
      docType('case'),
      {
        priority: 'high',
        title: 'Order Test',
        opened_at: '2026-04-06',
        status: 'open',
        client: 'cli-acme',
      },
      'Body.',
      'cas-order-test',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fp = path.join(TEMP_ROOT, 'cases', 'cas-order-test.md');
    const content = await readFile(fp, 'utf-8');
    const lines = content.split('\n');

    // Core keys first
    expect(lines[1]).toMatch(/^doc_id:/);
    expect(lines[2]).toMatch(/^doc_type:/);
    expect(lines[3]).toMatch(/^schema:/);
    // Then required fields: title, client, status
    expect(lines[4]).toMatch(/^title:/);
    expect(lines[5]).toMatch(/^client:/);
    expect(lines[6]).toMatch(/^status:/);
  });
});
