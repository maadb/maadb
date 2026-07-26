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

  it('emits newline-safe frontmatter that gray-matter can re-parse', async () => {
    const { parseMatter } = await import('../../src/parser/matter.js');
    const schema = makeSchema(['doc_id', 'summary'], ['summary', 'details']);
    const fm = {
      doc_id: 'test-001',
      doc_type: 'test',
      schema: 'test.v1',
      summary: 'First paragraph.\n\nSecond paragraph.',
      details: 'Windows path C:\\tmp\\out and a "quote"',
    };
    const serialized = serializeFrontmatter(fm, schema);
    const doc = `${serialized}\n\n# Body\n`;
    const parsed = parseMatter(doc);
    expect(parsed.data.summary).toBe(fm.summary);
    expect(parsed.data.details).toBe(fm.details);
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

  it('preserves scalar types inside arrays', async () => {
    const original = ['true', '007', 'null', 'a: b', true, 7, null, 3.5];
    const emitted = serializeField('items', original);
    const yaml = (await import('js-yaml')).default;
    const parsed = yaml.load(emitted, { schema: yaml.CORE_SCHEMA }) as { items: unknown[] };

    expect(parsed.items).toEqual(original);
    expect(emitted).toBe('items: ["true", "007", "null", "a: b", true, 7, null, 3.5]');
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

  it('escapes newlines and CRs inside double-quoted scalars', () => {
    expect(serializeField('summary', 'line1\nline2')).toBe('summary: "line1\\nline2"');
    expect(serializeField('summary', 'para1\n\npara2')).toBe('summary: "para1\\n\\npara2"');
    expect(serializeField('summary', 'a\rb')).toBe('summary: "a\\rb"');
    expect(serializeField('summary', 'a\r\nb')).toBe('summary: "a\\r\\nb"');
  });

  it('preserves backslash and quote escapes alongside newlines', () => {
    expect(serializeField('path', 'C:\\users\\x\\file')).toBe('path: "C:\\\\users\\\\x\\\\file"');
    expect(serializeField('note', 'says "hi"\nnext')).toBe('note: "says \\"hi\\"\\nnext"');
  });

  it('round-trips newline-bearing strings through CORE_SCHEMA parse', async () => {
    const yaml = (await import('js-yaml')).default;
    const cases = [
      'line1\nline2',
      'para1\n\npara2',
      'a\rb',
      'a\r\nb',
      'C:\\users\\x\\OneDrive - Org\\ops',
      'inner "quoted" phrase\nwith break',
    ];
    for (const original of cases) {
      const emitted = serializeField('summary', original);
      expect(emitted.includes('\n')).toBe(false);
      expect(emitted.includes('\r')).toBe(false);
      const parsed = yaml.load(emitted, { schema: yaml.CORE_SCHEMA }) as { summary: unknown };
      expect(parsed.summary).toBe(original);
    }
  });

  it('round-trips newline-bearing array items', async () => {
    const yaml = (await import('js-yaml')).default;
    const original = ['plain', 'has\nbreak', 'C:\\tmp', 'says "hi"'];
    const emitted = serializeField('tags', original);
    const parsed = yaml.load(emitted, { schema: yaml.CORE_SCHEMA }) as { tags: unknown[] };
    expect(parsed.tags).toEqual(original);
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

  // 0.7.3 — coercion-roundtrip guard. Any string whose
  // unquoted YAML form parses back as a non-string corrupts on read. Earlier
  // static checks (keywords, leading-digit-with-non-digit) miss all-digit and
  // sci-notation literals. The guard parses the candidate back through the
  // CORE_SCHEMA loader and forces quotes if `parsed !== originalString`.
  describe('coercion-roundtrip guard', () => {
    it('quotes all-digit string (would parse as int)', () => {
      // Real-world hit: git_ref="4962218" emitted unquoted,
      // re-read as the integer 4962218.
      expect(serializeField('git_ref', '4962218')).toBe('git_ref: "4962218"');
    });

    it('quotes scientific-notation lookalike (would parse as float Infinity)', () => {
      // Real-world hit: git_ref="1e38892" → Infinity on read.
      expect(serializeField('git_ref', '1e38892')).toBe('git_ref: "1e38892"');
    });

    it('quotes leading-zero digit string (would parse as int, losing zero)', () => {
      expect(serializeField('code', '007')).toBe('code: "007"');
    });

    it('quotes float-shaped string', () => {
      expect(serializeField('val', '3.14')).toBe('val: "3.14"');
    });

    it('quotes negative-int-shaped string', () => {
      expect(serializeField('val', '-42')).toBe('val: "-42"');
    });

    it('leaves non-coercing strings unquoted (regression guard — guard must not over-quote)', () => {
      // Plain identifiers should pass through unquoted. Short SHAs that
      // start with a digit are already caught by the existing digit-prefix
      // heuristic (e.g. `76a859c` → quoted) — that's a separate code path.
      expect(serializeField('name', 'patchnet-internal')).toBe('name: patchnet-internal');
      expect(serializeField('slug', 'agt-claude-dev')).toBe('slug: agt-claude-dev');
      expect(serializeField('val', 'hello-world')).toBe('val: hello-world');
    });

    it('round-trips emitted output through CORE_SCHEMA as the same string', async () => {
      const yaml = (await import('js-yaml')).default;
      const cases = ['4962218', '1e38892', '007', '3.14', '-42', 'true', 'null', '76a859c'];
      for (const original of cases) {
        const emitted = serializeField('field', original);
        const scalar = emitted.slice('field: '.length);
        const parsed = yaml.load(`field: ${scalar}`, { schema: yaml.CORE_SCHEMA }) as { field: unknown };
        expect(parsed.field).toBe(original);
        expect(typeof parsed.field).toBe('string');
      }
    });
  });
});
