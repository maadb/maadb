import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { loadRegistry } from '../../src/registry/loader.js';
import { loadSchemas } from '../../src/schema/loader.js';
import { validateFrontmatter } from '../../src/schema/validator.js';
import type { Registry, SchemaDefinition } from '../../src/types.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/simple-crm');

let registry: Registry;
let caseSchema: SchemaDefinition;
let clientSchema: SchemaDefinition;

beforeAll(async () => {
  const regResult = await loadRegistry(FIXTURE_ROOT);
  if (!regResult.ok) throw new Error('Failed to load registry');
  registry = regResult.value;

  const schemaResult = await loadSchemas(FIXTURE_ROOT, registry);
  if (!schemaResult.ok) throw new Error('Failed to load schemas');

  caseSchema = schemaResult.value.getSchemaForType('case' as any)!;
  clientSchema = schemaResult.value.getSchemaForType('client' as any)!;
});

describe('validateFrontmatter', () => {
  it('validates a correct case document', () => {
    const fm = {
      doc_id: 'cas-2026-001',
      doc_type: 'case',
      schema: 'case.v1',
      title: 'Contract Review',
      client: 'cli-acme',
      status: 'open',
      opened_at: '2026-04-01',
      priority: 'high',
    };
    const result = validateFrontmatter(fm, caseSchema, registry);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    // Phase 3: warnings channel always present, empty until Phase 4 wires precision enforcement.
    expect(result.warnings).toEqual([]);
  });

  it('ValidationResult always includes warnings array (0.6.7 Phase 3 channel)', () => {
    const valid = validateFrontmatter(
      { doc_id: 'cas-1', doc_type: 'case', schema: 'case.v1', title: 'T', client: 'cli-acme', status: 'open' },
      caseSchema,
      registry,
    );
    expect(Array.isArray(valid.warnings)).toBe(true);

    const invalid = validateFrontmatter({ doc_id: 'cas-2', doc_type: 'case', schema: 'case.v1' }, caseSchema, registry);
    expect(Array.isArray(invalid.warnings)).toBe(true);
  });

  it('rejects missing required fields', () => {
    const fm = {
      doc_id: 'cas-2026-001',
      doc_type: 'case',
      schema: 'case.v1',
      // missing: title, client, status
    };
    const result = validateFrontmatter(fm, caseSchema, registry);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
    const missingFields = result.errors.map(e => e.field);
    expect(missingFields).toContain('title');
    expect(missingFields).toContain('client');
    expect(missingFields).toContain('status');
  });

  it('rejects invalid enum value', () => {
    const fm = {
      doc_id: 'cas-2026-001',
      doc_type: 'case',
      schema: 'case.v1',
      title: 'Test',
      client: 'cli-acme',
      status: 'invalid_status',
    };
    const result = validateFrontmatter(fm, caseSchema, registry);
    expect(result.valid).toBe(false);
    const statusError = result.errors.find(e => e.field === 'status');
    expect(statusError).toBeDefined();
    expect(statusError!.message).toContain('not in enum');
  });

  it('rejects ref with wrong prefix', () => {
    const fm = {
      doc_id: 'cas-2026-001',
      doc_type: 'case',
      schema: 'case.v1',
      title: 'Test',
      client: 'wrong-prefix',
      status: 'open',
    };
    const result = validateFrontmatter(fm, caseSchema, registry);
    expect(result.valid).toBe(false);
    const clientError = result.errors.find(e => e.field === 'client');
    expect(clientError).toBeDefined();
    expect(clientError!.message).toContain('prefix');
  });

  it('rejects wrong field type', () => {
    const fm = {
      doc_id: 'cli-test',
      doc_type: 'client',
      schema: 'client.v1',
      name: 42, // should be string
      status: 'active',
    };
    const result = validateFrontmatter(fm, clientSchema, registry);
    expect(result.valid).toBe(false);
    const nameError = result.errors.find(e => e.field === 'name');
    expect(nameError).toBeDefined();
  });

  it('validates list fields', () => {
    const fm = {
      doc_id: 'cli-test',
      doc_type: 'client',
      schema: 'client.v1',
      name: 'Test Corp',
      status: 'active',
      tags: ['enterprise', 'priority'],
    };
    const result = validateFrontmatter(fm, clientSchema, registry);
    expect(result.valid).toBe(true);
  });

  it('rejects non-array for list field', () => {
    const fm = {
      doc_id: 'cli-test',
      doc_type: 'client',
      schema: 'client.v1',
      name: 'Test Corp',
      status: 'active',
      tags: 'not-an-array',
    };
    const result = validateFrontmatter(fm, clientSchema, registry);
    expect(result.valid).toBe(false);
    const tagsError = result.errors.find(e => e.field === 'tags');
    expect(tagsError).toBeDefined();
  });

  it('rejects bad date format', () => {
    const fm = {
      doc_id: 'cas-2026-001',
      doc_type: 'case',
      schema: 'case.v1',
      title: 'Test',
      client: 'cli-acme',
      status: 'open',
      opened_at: 'March 28, 2026', // not YYYY-MM-DD
    };
    const result = validateFrontmatter(fm, caseSchema, registry);
    expect(result.valid).toBe(false);
    const dateError = result.errors.find(e => e.field === 'opened_at');
    expect(dateError).toBeDefined();
  });
});
