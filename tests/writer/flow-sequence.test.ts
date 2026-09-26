import { describe, expect, it } from 'vitest';
import { parseMatter } from '../../src/parser/matter.js';
import { generateDocument } from '../../src/writer/index.js';
import { serializeField } from '../../src/writer/serializer.js';
import { docType, type SchemaDefinition } from '../../src/types.js';

const schema: SchemaDefinition = {
  type: docType('note'),
  version: 1,
  required: ['doc_id'],
  fields: new Map(),
  template: null,
};

describe('flow-sequence string fidelity', () => {
  it.each([
    'src/routes/[itemId]/route.ts',
    'src/a,b.ts',
    'prefix[suffix', 'prefix]suffix',
    'prefix{suffix', 'prefix}suffix',
    '[leading', ']leading', '{leading', '}leading',
    'trailing[', 'trailing]', 'trailing{', 'trailing}',
    ',', ',leading', 'trailing,', 'a,,b',
    'key:value', 'key: value', 'value # comment',
    '?', '- punctuation', '!tag', '&anchor', '*alias',
    '%directive', '@name', '`code`',
    '', ' ', '  padded  ', '\t', 'a\tb',
    'a\nb', 'a\rb', 'a\r\nb',
    'src\\[item]\\file.ts', 'src\\a,b.ts',
    'says "hi", then \'bye\'', 'literal \\n,[x]\nnext',
  ])('preserves the exact item %j between neighboring items', value => {
    const items = ['before', value, 'after'];
    const emitted = serializeField('items', items);
    const parsed = parseMatter(`---\n${emitted}\n---\n`);
    expect(parsed.data.items).toStrictEqual(items);
  });

  it('quotes the reported paths without changing ordinary list formatting', () => {
    expect(serializeField('paths', ['src/routes/[itemId]/route.ts', 'src/a,b.ts', 'plain']))
      .toBe('paths: ["src/routes/[itemId]/route.ts", "src/a,b.ts", plain]');
  });

  it('preserves nested lists and scalar types through generated markdown', () => {
    const items = [
      'true', 'false', 'null', '~', '007', '-42', '3.5', '1e3', '0x10',
      true, false, null, 7, -42, 3.5,
      [], ['src/a,b.ts', ['src/routes/[itemId]/route.ts', '', false, 0, null]],
      '2026-04-16T17:20:30.500Z',
    ];
    const frontmatter = { doc_id: 'note-flow', doc_type: 'note', schema: 'note.v1', items };
    const first = generateDocument(frontmatter, schema, '# Body');
    const parsed = parseMatter(first);
    expect(parsed.data).toStrictEqual(frontmatter);
    const second = generateDocument(parsed.data, schema, '# Body');
    expect(second).toBe(first);
    expect(parseMatter(second).data.items).toStrictEqual(items);
  });

  it('retains Date normalization and object items in extra lists', () => {
    const date = new Date('2026-04-16T17:20:30.500Z');
    const items = [date, { path: 'src/a,b.ts', enabled: false }, ['x[y]', date]];
    const emitted = serializeField('items', items);
    expect(parseMatter(`---\n${emitted}\n---\n`).data.items).toStrictEqual([
      date.toISOString(), { path: 'src/a,b.ts', enabled: false }, ['x[y]', date.toISOString()],
    ]);
  });
});
