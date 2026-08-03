import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import { loadRegistry } from '../../src/registry/loader.js';
import { loadSchemas } from '../../src/schema/loader.js';
import { extractRelationships } from '../../src/extractor/relationships.js';
import {
  docId,
  docType,
  schemaRef,
  filePath,
  blockId,
  type Registry,
  type SchemaDefinition,
  type BoundDocument,
  type InlineAnnotation,
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

function makeBound(fm: Record<string, unknown>, blocks: BoundDocument['parsed']['blocks'] = []): BoundDocument {
  return {
    parsed: {
      filePath: filePath('cases/cas-2026-001.md'),
      fileHash: 'abc123',
      frontmatter: fm,
      blocks,
      valueCalls: [],
      annotations: [],
    },
    docId: docId('cas-2026-001'),
    docType: docType('case'),
    schemaRef: schemaRef('case.v1'),
    validatedFields: {},
    validationResult: { valid: true, errors: [] },
  };
}

describe('extractRelationships', () => {
  it('creates ref relationships from frontmatter', () => {
    const bound = makeBound({
      doc_id: 'cas-2026-001',
      client: 'cli-acme',
      primary_contact: 'con-jane-smith',
      status: 'open',
      title: 'Test',
    });

    const rels = extractRelationships(bound, caseSchema, [], registry);
    const refRels = rels.filter(r => r.relationType === 'ref');

    expect(refRels).toHaveLength(2);
    expect(refRels.find(r => r.field === 'client')!.targetDocId).toBe('cli-acme');
    expect(refRels.find(r => r.field === 'primary_contact')!.targetDocId).toBe('con-jane-smith');
    expect(refRels.find(r => r.field === 'client')!.evidence).toEqual({
      sourceLine: null,
      sourceBlockId: null,
      origin: { kind: 'field', name: 'client' },
    });
  });

  it('creates mention relationships from inline annotations with doc_id patterns', () => {
    const bound = makeBound(
      { doc_id: 'cas-2026-001', client: 'cli-acme', status: 'open', title: 'Test' },
      [{ id: blockId('people'), heading: 'People', level: 2, startLine: 8, endLine: 12 }],
    );

    const annotations: InlineAnnotation[] = [
      {
        rawType: 'person',
        primitive: 'entity',
        value: 'con-jane-smith', // looks like a doc_id
        label: 'Jane',
        location: { file: filePath('test.md'), line: 10, col: 0 },
      },
      {
        rawType: 'person',
        primitive: 'entity',
        value: 'Officer Davis', // does NOT look like a doc_id
        label: 'Davis',
        location: { file: filePath('test.md'), line: 11, col: 0 },
      },
    ];

    const rels = extractRelationships(bound, caseSchema, annotations, registry);
    const mentions = rels.filter(r => r.relationType === 'mention');

    expect(mentions).toHaveLength(1);
    expect(mentions[0]!.targetDocId).toBe('con-jane-smith');
    expect(mentions[0]!.evidence).toEqual({
      sourceLine: 10,
      sourceBlockId: 'people',
      origin: { kind: 'annotation', name: 'person' },
    });
  });

  it('returns empty for no refs or mentions', () => {
    const bound = makeBound({ doc_id: 'cas-2026-001', title: 'Test', status: 'open' });
    const rels = extractRelationships(bound, caseSchema, [], registry);
    // Only ref fields with actual values create relationships
    expect(rels.filter(r => r.relationType === 'mention')).toHaveLength(0);
  });
});
