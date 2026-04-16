import { describe, it, expect } from 'vitest';
import { serializeFrontmatter, serializeField } from '../../src/writer/serializer.js';
import { docType, type SchemaDefinition, type FieldDefinition } from '../../src/types.js';

function makeSchema(required: string[], fieldNames: string[]): SchemaDefinition {
  const fields = new Map<string, FieldDefinition>();
  for (const name of fieldNames) {
    fields.set(name, {
      name,
      type: 'string',
      index: false,
      role: null,
      format: null,
      target: null,
      values: null,
      defaultValue: null,
      itemType: null,
    });
  }
  return {
    type: docType('test'),
    version: 1,
    required,
    fields,
    template: null,
  };
}

describe('serializeFrontmatter', () => {
  it('orders core keys first, then required, then rest', () => {
    const schema = makeSchema(['doc_id', 'title', 'status'], ['title', 'status', 'priority', 'tags']);
    const fm = {
      tags: ['a', 'b'],
      status: 'open',
      doc_id: 'test-001',
      doc_type: 'test',
      schema: 'test.v1',
      title: 'Test',
      priority: 'high',
    };

    const result = serializeFrontmatter(fm, schema);
    const lines = result.split('\n');

    // First three content lines after --- should be core keys
    expect(lines[1]).toMatch(/^doc_id:/);
    expect(lines[2]).toMatch(/^doc_type:/);
    expect(lines[3]).toMatch(/^schema:/);
    // Then required: title, status
    expect(lines[4]).toMatch(/^title:/);
    expect(lines[5]).toMatch(/^status:/);
  });

  it('wraps with --- delimiters', () => {
    const schema = makeSchema(['doc_id'], []);
    const fm = { doc_id: 'test' };
    const result = serializeFrontmatter(fm, schema);
    expect(result.startsWith('---\n')).toBe(true);
    expect(result.endsWith('\n---')).toBe(true);
  });
});

describe('serializeField', () => {
  it('serializes strings', () => {
    expect(serializeField('name', 'Acme Corp')).toBe('name: Acme Corp');
  });

  it('serializes numbers', () => {
    expect(serializeField('count', 42)).toBe('count: 42');
    expect(serializeField('rate', 3.14)).toBe('rate: 3.14');
  });

  it('serializes booleans', () => {
    expect(serializeField('active', true)).toBe('active: true');
    expect(serializeField('active', false)).toBe('active: false');
  });

  it('serializes null', () => {
    expect(serializeField('notes', null)).toBe('notes: null');
  });

  it('serializes arrays', () => {
    expect(serializeField('tags', ['a', 'b', 'c'])).toBe('tags: [a, b, c]');
  });

  it('quotes strings with special characters', () => {
    const result = serializeField('desc', 'value: with colon');
    expect(result).toBe('desc: "value: with colon"');
  });

  it('quotes strings that look like YAML keywords', () => {
    expect(serializeField('val', 'true')).toBe('val: "true"');
    expect(serializeField('val', 'false')).toBe('val: "false"');
    expect(serializeField('val', 'null')).toBe('val: "null"');
    expect(serializeField('val', 'yes')).toBe('val: "yes"');
    expect(serializeField('val', 'no')).toBe('val: "no"');
  });

  it('quotes empty strings', () => {
    expect(serializeField('val', '')).toBe('val: ""');
  });

  it('handles Date objects with full ISO precision (0.6.7 — never slice, always quote)', () => {
    // Pre-0.6.7 the serializer truncated Date objects to YYYY-MM-DD, which
    // silently destroyed any time component on round-trip. Under 0.6.7's
    // schema-precision contract, Dates must serialize at full millisecond
    // precision. Quoted so external YAML parsers don't coerce back to Date
    // via the !!timestamp resolver.
    const midnightDate = new Date('2026-04-01T00:00:00Z');
    expect(serializeField('opened_at', midnightDate)).toBe('opened_at: "2026-04-01T00:00:00.000Z"');

    const preciseDate = new Date('2026-04-16T17:20:30.500Z');
    expect(serializeField('started_at', preciseDate)).toBe('started_at: "2026-04-16T17:20:30.500Z"');
  });
});
