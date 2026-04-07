import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { loadRegistry } from '../../src/registry/loader.js';
import { loadSchemas } from '../../src/schema/loader.js';
import { validateFrontmatter } from '../../src/schema/validator.js';
import { extractRelationships } from '../../src/extractor/relationships.js';
import {
  docId,
  docType,
  schemaRef,
  filePath,
  type Registry,
  type SchemaDefinition,
  type BoundDocument,
} from '../../src/types.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/simple-crm');

let registry: Registry;
let caseSchema: SchemaDefinition;

beforeAll(async () => {
  const regResult = await loadRegistry(FIXTURE_ROOT);
  if (!regResult.ok) throw new Error('Failed to load registry');
  registry = regResult.value;

  const schemaResult = await loadSchemas(FIXTURE_ROOT, registry);
  if (!schemaResult.ok) throw new Error('Failed to load schemas');
  caseSchema = schemaResult.value.getSchemaForType('case' as any)!;
});

function makeBound(fm: Record<string, unknown>): BoundDocument {
  return {
    parsed: {
      filePath: filePath('cases/cas-test.md'),
      fileHash: 'abc',
      frontmatter: fm,
      blocks: [],
      valueCalls: [],
      annotations: [],
    },
    docId: docId('cas-test'),
    docType: docType('case'),
    schemaRef: schemaRef('case.v1'),
    validatedFields: {},
    validationResult: { valid: true, errors: [] },
  };
}

describe('list-of-ref validation', () => {
  it('validates array of valid refs', () => {
    const fm = {
      doc_id: 'cas-test',
      title: 'Test',
      client: 'cli-acme',
      status: 'open',
      related_contacts: ['con-jane-smith', 'con-bob'],
    };
    const result = validateFrontmatter(fm, caseSchema, registry);
    expect(result.valid).toBe(true);
  });

  it('rejects ref with wrong prefix in list', () => {
    const fm = {
      doc_id: 'cas-test',
      title: 'Test',
      client: 'cli-acme',
      status: 'open',
      related_contacts: ['con-jane-smith', 'wrong-prefix'],
    };
    const result = validateFrontmatter(fm, caseSchema, registry);
    expect(result.valid).toBe(false);
    const err = result.errors.find(e => e.field.includes('[1]'));
    expect(err).toBeDefined();
    expect(err!.message).toContain('prefix');
  });

  it('rejects non-string items in ref list', () => {
    const fm = {
      doc_id: 'cas-test',
      title: 'Test',
      client: 'cli-acme',
      status: 'open',
      related_contacts: ['con-jane-smith', 42],
    };
    const result = validateFrontmatter(fm, caseSchema, registry);
    expect(result.valid).toBe(false);
  });
});

describe('list-of-ref relationship extraction', () => {
  it('creates one edge per array element', () => {
    const bound = makeBound({
      doc_id: 'cas-test',
      client: 'cli-acme',
      related_contacts: ['con-jane-smith', 'con-bob'],
      status: 'open',
      title: 'Test',
    });

    const rels = extractRelationships(bound, caseSchema, [], registry);

    // Should have: client (scalar ref) + 2 from related_contacts (list-of-ref)
    const clientRels = rels.filter(r => r.field === 'client');
    const listRels = rels.filter(r => r.field === 'related_contacts');

    expect(clientRels).toHaveLength(1);
    expect(listRels).toHaveLength(2);
    expect(listRels.map(r => r.targetDocId as string).sort()).toEqual(['con-bob', 'con-jane-smith']);
    expect(listRels.every(r => r.relationType === 'ref')).toBe(true);
  });

  it('handles empty array', () => {
    const bound = makeBound({
      doc_id: 'cas-test',
      client: 'cli-acme',
      related_contacts: [],
      status: 'open',
      title: 'Test',
    });

    const rels = extractRelationships(bound, caseSchema, [], registry);
    const listRels = rels.filter(r => r.field === 'related_contacts');
    expect(listRels).toHaveLength(0);
  });
});
