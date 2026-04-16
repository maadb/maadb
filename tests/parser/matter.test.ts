import { describe, it, expect } from 'vitest';
import { parseMatter } from '../../src/parser/matter.js';

describe('parseMatter — string-preserving YAML engine', () => {
  it('keeps a bare-date scalar as a string (not a Date object)', () => {
    const raw = `---\nopened_at: 2026-04-15\n---\nbody`;
    const result = parseMatter(raw);
    expect(typeof result.data['opened_at']).toBe('string');
    expect(result.data['opened_at']).toBe('2026-04-15');
    expect(result.data['opened_at']).not.toBeInstanceOf(Date);
  });

  it('keeps an ISO datetime scalar as a string (not a Date object)', () => {
    const raw = `---\nstarted_at: 2026-04-16T17:20:00Z\n---\nbody`;
    const result = parseMatter(raw);
    expect(typeof result.data['started_at']).toBe('string');
    expect(result.data['started_at']).toBe('2026-04-16T17:20:00Z');
    expect(result.data['started_at']).not.toBeInstanceOf(Date);
  });

  it('preserves millisecond precision with timezone as a literal string', () => {
    const raw = `---\ndecided_at: 2026-04-16T17:20:30.500+02:00\n---\n`;
    const result = parseMatter(raw);
    expect(result.data['decided_at']).toBe('2026-04-16T17:20:30.500+02:00');
  });

  it('preserves every precision level as a literal string — no Date coercion', () => {
    const samples = [
      '2026',                          // year
      '2026-04',                       // month
      '2026-04-16',                    // day
      '2026-04-16T17',                 // hour
      '2026-04-16T17:20',              // minute
      '2026-04-16T17:20:00',           // second (no tz)
      '2026-04-16T17:20:00Z',          // second utc
      '2026-04-16T17:20:00.000Z',      // millisecond utc
      '2026-04-16T17:20:00.500+09:30', // millisecond + positive offset
      '2026-04-16T17:20:00.500-05:00', // millisecond + negative offset
    ];
    for (const sample of samples) {
      const raw = `---\nts: "${sample}"\n---\n`;
      const result = parseMatter(raw);
      expect(result.data['ts']).toBe(sample);
      expect(result.data['ts']).not.toBeInstanceOf(Date);
    }
  });

  it('still parses other scalar types correctly — null, bool, int, float, string', () => {
    const raw = `---
name: "Acme"
count: 42
price: 3.14
active: true
missing: null
---
body`;
    const result = parseMatter(raw);
    expect(result.data['name']).toBe('Acme');
    expect(result.data['count']).toBe(42);
    expect(result.data['price']).toBe(3.14);
    expect(result.data['active']).toBe(true);
    expect(result.data['missing']).toBeNull();
  });

  it('still parses sequences and mappings correctly', () => {
    const raw = `---\ntags:\n  - alpha\n  - beta\nmeta:\n  owner: luis\n---\n`;
    const result = parseMatter(raw);
    expect(result.data['tags']).toEqual(['alpha', 'beta']);
    expect(result.data['meta']).toEqual({ owner: 'luis' });
  });

  it('exposes parsed.content for the body', () => {
    const raw = `---\ntitle: Test\n---\nThis is the body.\n`;
    const result = parseMatter(raw);
    expect(result.content.trim()).toBe('This is the body.');
  });

  it('handles bare YAML (no frontmatter delimiters) when wrapped by caller', () => {
    // Mirrors the pattern in registry/loader.ts and schema/loader.ts
    const bareYaml = `name: Luis\nrole: admin`;
    const result = parseMatter(`---\n${bareYaml}\n---`);
    expect(result.data['name']).toBe('Luis');
    expect(result.data['role']).toBe('admin');
  });
});
