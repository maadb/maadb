// ============================================================================
// 0.12.0 structural field constraints — loader parse/gate + validator
// enforcement + preflight audit.
//
// Contract (dec: field constraints, accepted 2026-07-13):
// - max_length hard / soft_max_length advisory / multiline:false, string
//   fields only, lengths in Unicode code points, no normalization
// - capability gate: unknown field-definition keys fail schema activation
// - write-mode only, update-neighbor safe, reads/index/audit never enforce
// - preflight: maad_validate includeConstraints reports historical violations
// ============================================================================

import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { loadRegistry } from '../../src/registry/loader.js';
import { loadSchemas } from '../../src/schema/loader.js';
import { validateFrontmatter, codePointLength } from '../../src/schema/index.js';
import type { Registry, SchemaDefinition } from '../../src/types.js';

const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-constraints');
let caseCounter = 0;

afterAll(() => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function loadSchemaYaml(schemaYaml: string): Promise<{ ok: boolean; errors: string[]; schema?: SchemaDefinition; registry?: Registry }> {
  const root = path.join(TEMP_ROOT, `case-${caseCounter++}`);
  mkdirSync(path.join(root, '_registry'), { recursive: true });
  mkdirSync(path.join(root, '_schema'), { recursive: true });
  writeFileSync(path.join(root, '_registry', 'object_types.yaml'),
    'types:\n  ticket:\n    path: tickets\n    id_prefix: tkt\n    schema: ticket.v1\n', 'utf-8');
  writeFileSync(path.join(root, '_schema', 'ticket.v1.yaml'), schemaYaml, 'utf-8');
  const reg = await loadRegistry(root);
  if (!reg.ok) return { ok: false, errors: reg.errors.map(e => e.message) };
  const schemas = await loadSchemas(root, reg.value);
  if (!schemas.ok) return { ok: false, errors: schemas.errors.map(e => e.message) };
  return { ok: true, errors: [], schema: schemas.value.getSchemaForType('ticket' as never)!, registry: reg.value };
}

const GOOD_SCHEMA = `
type: ticket
version: 1
fields:
  subject:
    type: string
    multiline: false
    max_length: 10
    soft_max_length: 5
  detail:
    type: string
`;

// ---- codePointLength ---------------------------------------------------------

describe('codePointLength — Unicode code points, not UTF-16 units', () => {
  it('counts astral-plane characters once', () => {
    expect(codePointLength('abc')).toBe(3);
    expect(codePointLength('café')).toBe(4);
    expect(codePointLength('𝄞')).toBe(1);        // U+1D11E, .length would be 2
    expect(codePointLength('a💯b')).toBe(3);      // .length would be 4
    expect(codePointLength('')).toBe(0);
  });
});

// ---- Loader: parse + config validation ----------------------------------------

describe('loader — constraint parsing and config validation', () => {
  it('parses constraints on string fields', async () => {
    const res = await loadSchemaYaml(GOOD_SCHEMA);
    expect(res.ok, res.errors.join('; ')).toBe(true);
    const f = res.schema!.fields.get('subject')!;
    expect(f.maxLength).toBe(10);
    expect(f.softMaxLength).toBe(5);
    expect(f.multiline).toBe(false);
    const d = res.schema!.fields.get('detail')!;
    expect(d.maxLength).toBeNull();
    expect(d.softMaxLength).toBeNull();
    expect(d.multiline).toBeNull();
  });

  it('rejects constraints on non-string fields', async () => {
    const res = await loadSchemaYaml('type: ticket\nversion: 1\nfields:\n  count:\n    type: number\n    max_length: 5\n');
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toContain('only valid on string fields');
  });

  it('rejects non-positive and non-integer limits', async () => {
    for (const bad of ['max_length: 0', 'max_length: -3', 'max_length: 2.5', 'max_length: "10"']) {
      const res = await loadSchemaYaml(`type: ticket\nversion: 1\nfields:\n  subject:\n    type: string\n    ${bad}\n`);
      expect(res.ok, bad).toBe(false);
    }
  });

  it('rejects soft_max_length greater than max_length', async () => {
    const res = await loadSchemaYaml('type: ticket\nversion: 1\nfields:\n  subject:\n    type: string\n    max_length: 5\n    soft_max_length: 9\n');
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toContain('must not exceed the hard limit');
  });

  it('rejects non-boolean multiline', async () => {
    const res = await loadSchemaYaml('type: ticket\nversion: 1\nfields:\n  subject:\n    type: string\n    multiline: "no"\n');
    expect(res.ok).toBe(false);
  });
});

// ---- Loader: capability gate ---------------------------------------------------

describe('loader — strict unknown-key capability gate', () => {
  it('fails schema activation on an unknown field-definition key, naming it', async () => {
    const res = await loadSchemaYaml('type: ticket\nversion: 1\nfields:\n  subject:\n    type: string\n    max_lenth: 10\n');
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toContain('unknown key "max_lenth"');
    expect(res.errors.join(' ')).toContain('upgrade this engine');
  });

  it('rejects future-vocabulary keys rather than silently ignoring them', async () => {
    const res = await loadSchemaYaml('type: ticket\nversion: 1\nfields:\n  subject:\n    type: string\n    presentation_role: title\n');
    expect(res.ok).toBe(false);
    expect(res.errors.join(' ')).toContain('unknown key "presentation_role"');
  });

  it('every documented key vocabulary still loads', async () => {
    const res = await loadSchemaYaml(`
type: ticket
version: 1
fields:
  subject:
    type: string
    index: true
    role: title
    format: plain
    default: untitled
    max_length: 10
    soft_max_length: 5
    multiline: false
  when:
    type: date
    store_precision: day
    on_coarser: warn
    display_precision: day
  tags:
    type: list
    item_type: string
`);
    expect(res.ok, res.errors.join('; ')).toBe(true);
  });
});

// ---- Validator: write-mode enforcement -----------------------------------------

describe('validator — write-mode enforcement', () => {
  async function goodSchema(): Promise<{ schema: SchemaDefinition; registry: Registry }> {
    const res = await loadSchemaYaml(GOOD_SCHEMA);
    expect(res.ok).toBe(true);
    return { schema: res.schema!, registry: res.registry! };
  }

  it('max_length violation fails the write with a stable code', async () => {
    const { schema, registry } = await goodSchema();
    const result = validateFrontmatter({ subject: 'x'.repeat(11) }, schema, registry, undefined, { mode: 'write' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.code).toBe('FIELD_MAX_LENGTH_EXCEEDED');
    expect(result.errors[0]!.message).toContain('11');
  });

  it('length is measured in code points — emoji do not double-count', async () => {
    const { schema, registry } = await goodSchema();
    // 10 emoji = 20 UTF-16 units but exactly 10 code points → passes hard limit.
    const result = validateFrontmatter({ subject: '💯'.repeat(10) }, schema, registry, undefined, { mode: 'write' });
    expect(result.errors).toEqual([]);
    // Advisory still fires (10 > 5) — hard and soft evaluated independently.
    expect(result.warnings.some(w => w.code === 'FIELD_SOFT_MAX_LENGTH_EXCEEDED')).toBe(true);
  });

  it('soft_max_length violation warns without blocking', async () => {
    const { schema, registry } = await goodSchema();
    const result = validateFrontmatter({ subject: 'seven77' }, schema, registry, undefined, { mode: 'write' });
    expect(result.valid).toBe(true);
    expect(result.warnings[0]!.code).toBe('FIELD_SOFT_MAX_LENGTH_EXCEEDED');
  });

  it('multiline: false rejects CR and LF', async () => {
    const { schema, registry } = await goodSchema();
    for (const value of ['a\nb', 'a\rb', 'a\r\nb']) {
      const result = validateFrontmatter({ subject: value }, schema, registry, undefined, { mode: 'write' });
      expect(result.valid, JSON.stringify(value)).toBe(false);
      expect(result.errors[0]!.code).toBe('FIELD_MULTILINE_NOT_ALLOWED');
    }
  });

  it('reads, index, and audit modes never enforce', async () => {
    const { schema, registry } = await goodSchema();
    const offending = { subject: 'x'.repeat(50) + '\n' };
    for (const mode of ['read', 'index', 'audit'] as const) {
      const result = validateFrontmatter(offending, schema, registry, undefined, { mode });
      expect(result.valid, mode).toBe(true);
      expect(result.warnings, mode).toEqual([]);
    }
  });

  it('update-neighbor safe: unrelated update not stranded by a pre-existing violation', async () => {
    const { schema, registry } = await goodSchema();
    const frontmatter = { subject: 'x'.repeat(50), detail: 'updated detail' };
    const result = validateFrontmatter(frontmatter, schema, registry, undefined, {
      mode: 'write',
      changedFields: new Set(['detail']),
    });
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('unconstrained string fields are unaffected', async () => {
    const { schema, registry } = await goodSchema();
    const result = validateFrontmatter({ detail: ('long text\n'.repeat(500)) }, schema, registry, undefined, { mode: 'write' });
    expect(result.valid).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
