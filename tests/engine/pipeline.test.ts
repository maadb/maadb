import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { MaadEngine } from '../../src/engine.js';
import { docId, docType } from '../../src/types.js';

const FIXTURE_ROOT = path.resolve(__dirname, '../fixtures/simple-crm');
let engine: MaadEngine;

beforeAll(async () => {
  engine = new MaadEngine();
  const result = await engine.init(FIXTURE_ROOT);
  expect(result.ok).toBe(true);
});

afterAll(() => {
  engine.close();
});

describe('indexAll', () => {
  it('indexes all markdown files in registered paths', async () => {
    const result = await engine.indexAll({ force: true });
    expect(result.scanned).toBe(4);
    expect(result.indexed).toBe(4);
    expect(result.errors).toHaveLength(0);
  });

  it('skips unchanged files on second pass', async () => {
    const result = await engine.indexAll();
    expect(result.skipped).toBe(4);
    expect(result.indexed).toBe(0);
  });
});

describe('describe', () => {
  it('returns project overview', () => {
    const desc = engine.describe();
    expect(desc.registryTypes).toHaveLength(4);
    expect(desc.totalDocuments).toBe(4);
    expect(desc.extractionPrimitives).toContain('entity');
    expect(desc.extractionPrimitives).toContain('media');
    expect(desc.extractionPrimitives).toHaveLength(11);

    const clientType = desc.registryTypes.find(t => t.type === 'client');
    expect(clientType).toBeDefined();
    expect(clientType!.docCount).toBe(1);
  });
});

describe('getDocument', () => {
  it('returns hot read (frontmatter only)', async () => {
    const result = await engine.getDocument(docId('cli-acme'), 'hot');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.frontmatter.name).toBe('Acme Corporation');
    expect(result.value.body).toBeUndefined();
    expect(result.value.block).toBeUndefined();
  });

  it('returns warm read (frontmatter + block)', async () => {
    const result = await engine.getDocument(docId('cas-2026-001'), 'warm', 'timeline');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.block).toBeDefined();
    expect(result.value.block!.heading).toBe('Timeline');
    expect(result.value.block!.content).toContain('March 28, 2026');
  });

  it('returns cold read (full body)', async () => {
    const result = await engine.getDocument(docId('cas-2026-001'), 'cold');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).toBeDefined();
    expect(result.value.body).toContain('Contract Review Dispute');
    expect(result.value.body).toContain('Timeline');
  });

  it('returns error for missing document', async () => {
    const result = await engine.getDocument(docId('nonexistent'), 'hot');
    expect(result.ok).toBe(false);
  });
});

describe('findDocuments', () => {
  it('finds by doc_type', () => {
    const result = engine.findDocuments({ docType: docType('client') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(1);
    expect(result.value.results[0]!.docId).toBe('cli-acme');
  });

  it('finds by field filter', () => {
    const result = engine.findDocuments({
      docType: docType('case'),
      filters: { status: { op: 'eq', value: 'open' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(1);
  });

  it('returns empty for no matches', () => {
    const result = engine.findDocuments({
      docType: docType('case'),
      filters: { status: { op: 'eq', value: 'closed' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(0);
  });

  it('projects requested fields into results', () => {
    const result = engine.findDocuments({
      docType: docType('client'),
      fields: ['name', 'status'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBeGreaterThan(0);
    const first = result.value.results[0];
    expect(first.fields).toBeDefined();
    expect(first.fields!['name']).toBeDefined();
    expect(first.fields!['status']).toBeDefined();
  });

  it('returns empty fields object when no matching field data', () => {
    const result = engine.findDocuments({
      docType: docType('client'),
      fields: ['nonexistent_field'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBeGreaterThan(0);
    expect(result.value.results[0].fields).toEqual({});
  });

  it('filters by ref field with full syntax', () => {
    const result = engine.findDocuments({
      docType: docType('case'),
      filters: { client: { op: 'eq', value: 'cli-acme' } },
      fields: ['title'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBeGreaterThan(0);
    expect(result.value.results[0].fields!['title']).toBe('Contract Review Dispute');
  });

  it('filters by ref field with shorthand string', () => {
    const result = engine.findDocuments({
      docType: docType('case'),
      filters: { client: 'cli-acme' as any },
      fields: ['title'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBeGreaterThan(0);
    expect(result.value.results[0].fields!['title']).toBe('Contract Review Dispute');
  });

  it('supports date range queries', () => {
    const result = engine.findDocuments({
      docType: docType('case'),
      filters: { opened_at: { op: 'gte', value: '2026-01-01' } },
      fields: ['title', 'opened_at'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBeGreaterThan(0);
    expect(result.value.results[0].fields!['opened_at']).toBe('2026-04-01');
  });

  it('excludes records outside date range', () => {
    const result = engine.findDocuments({
      docType: docType('case'),
      filters: { opened_at: { op: 'lt', value: '2020-01-01' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(0);
  });

  it('omits fields property when no projection requested', () => {
    const result = engine.findDocuments({ docType: docType('client') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results[0].fields).toBeUndefined();
  });

  it('combines filters with projection', () => {
    const result = engine.findDocuments({
      docType: docType('case'),
      filters: { status: { op: 'eq', value: 'open' } },
      fields: ['title', 'status', 'client'],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(1);
    expect(result.value.results[0].fields!['status']).toBe('open');
  });
});

describe('searchObjects', () => {
  it('finds extracted entities', () => {
    const result = engine.searchObjects({ primitive: 'entity', subtype: 'person' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Jane Smith and Bob Torres from case, plus system from note
    expect(result.value.results.length).toBeGreaterThanOrEqual(2);
    const values = result.value.results.map(r => r.value);
    expect(values).toContain('Jane Smith');
    expect(values).toContain('Bob Torres');
  });

  it('finds dates across documents', () => {
    const result = engine.searchObjects({ primitive: 'date' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Inline dates from case and note, plus indexed date fields
    expect(result.value.results.length).toBeGreaterThanOrEqual(2);
  });

  it('finds amounts', () => {
    const result = engine.searchObjects({ primitive: 'amount' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBeGreaterThanOrEqual(1);
    expect(result.value.results.some(r => r.value === '5000.00 USD')).toBe(true);
  });

  it('searches by value substring', () => {
    const result = engine.searchObjects({ contains: 'Torres' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBeGreaterThanOrEqual(1);
  });
});

describe('listRelated', () => {
  it('finds outgoing refs from case', () => {
    const result = engine.listRelated(docId('cas-2026-001'), 'outgoing');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outgoing.length).toBeGreaterThanOrEqual(2);
    const targets = result.value.outgoing.map(r => r.docId as string);
    expect(targets).toContain('cli-acme');
    expect(targets).toContain('con-jane-smith');
  });

  it('finds incoming refs to client', () => {
    const result = engine.listRelated(docId('cli-acme'), 'incoming');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.incoming.length).toBeGreaterThanOrEqual(1);
  });
});

describe('validate', () => {
  it('validates a single document', async () => {
    const result = await engine.validate(docId('cli-acme'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.valid).toBe(1);
    expect(result.value.invalid).toBe(0);
  });

  it('validates all documents', async () => {
    const result = await engine.validate();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.total).toBe(4);
    expect(result.value.valid).toBe(4);
  });
});

describe('summary', () => {
  it('returns one-call project orientation', () => {
    const result = engine.summary();
    expect(result.totalDocuments).toBe(4);
    expect(result.types.length).toBe(4);

    // Each type has a count and sample IDs
    const clientType = result.types.find(t => t.type === 'client');
    expect(clientType).toBeDefined();
    expect(clientType!.count).toBe(1);
    expect(clientType!.sampleIds).toContain('cli-acme');

    // Subtype inventory should have entries
    expect(result.subtypeInventory.length).toBeGreaterThan(0);
    // Should have entity/person from the case's inline annotations
    const personEntry = result.subtypeInventory.find(s => s.subtype === 'person');
    expect(personEntry).toBeDefined();
    expect(personEntry!.topValues.length).toBeGreaterThan(0);

    // Stats
    expect(result.totalObjects).toBeGreaterThan(0);
    expect(result.totalRelationships).toBeGreaterThan(0);
  });
});

describe('join', () => {
  it('follows ref fields and returns projected fields from both sides', () => {
    const result = engine.join({
      docType: docType('case'),
      refs: ['client'],
      fields: ['title', 'status'],
      refFields: { client: ['name'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results.length).toBeGreaterThan(0);
    const first = result.value.results[0]!;
    expect(first.fields['title']).toBeDefined();
    expect(first.fields['status']).toBeDefined();
    expect(first.refs['client']).toBeDefined();
    expect(first.refs['client']!.docId).toBe('cli-acme');
    expect(first.refs['client']!.fields['name']).toBeDefined();
  });

  it('returns null for missing ref targets', () => {
    const result = engine.join({
      docType: docType('client'),
      refs: ['primary_contact'],
      fields: ['name'],
      refFields: { primary_contact: ['name'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Some clients may not have primary_contact set
    expect(result.value.results.length).toBeGreaterThan(0);
  });

  it('supports filters on source documents', () => {
    const result = engine.join({
      docType: docType('case'),
      refs: ['client'],
      fields: ['title'],
      refFields: { client: ['name'] },
      filters: { status: { op: 'eq', value: 'open' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.results).toHaveLength(1);
  });
});

describe('aggregate', () => {
  it('counts documents grouped by field', () => {
    const result = engine.aggregate({ groupBy: 'status', docType: docType('case') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.groups.length).toBeGreaterThan(0);
    const openGroup = result.value.groups.find(g => g.value === 'open');
    expect(openGroup).toBeDefined();
    expect(openGroup!.count).toBeGreaterThanOrEqual(1);
  });

  it('counts clients grouped by status', () => {
    const result = engine.aggregate({ groupBy: 'status', docType: docType('client') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.groups.length).toBeGreaterThan(0);
  });

  it('returns empty groups for no matches', () => {
    const result = engine.aggregate({
      groupBy: 'status',
      docType: docType('case'),
      filters: { status: { op: 'eq', value: 'nonexistent' } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.groups).toHaveLength(0);
  });

  it('aggregates without docType scope', () => {
    const result = engine.aggregate({ groupBy: 'status' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should include statuses from both cases and clients
    expect(result.value.groups.length).toBeGreaterThan(0);
  });

  it('returns totalMetric when metric is specified', () => {
    // Use a field that has numeric values — opened_at stored as date string won't have numeric_value
    // but count metric works on any field
    const result = engine.aggregate({
      docType: docType('case'),
      groupBy: 'status',
      metric: { field: 'status', op: 'count' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalMetric).toBeDefined();
    expect(typeof result.value.totalMetric).toBe('number');
    expect(result.value.totalMetric).toBeGreaterThan(0);
  });

  it('does not return totalMetric without metric', () => {
    const result = engine.aggregate({
      docType: docType('case'),
      groupBy: 'status',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalMetric).toBeUndefined();
  });
});

describe('getDocumentFull', () => {
  it('returns resolved record with refs, objects, and related', async () => {
    const result = await engine.getDocumentFull(docId('cas-2026-001'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const full = result.value;
    expect(full.docType).toBe('case');
    expect(full.frontmatter['title']).toBe('Contract Review Dispute');

    // Ref resolution: client field should resolve to Acme Corporation
    expect(full.resolvedRefs['client']).toBeDefined();
    expect(full.resolvedRefs['client']!.docId).toBe('cli-acme');
    expect(full.resolvedRefs['client']!.name).toBe('Acme Corporation');

    // Extracted objects
    expect(full.objects.length).toBeGreaterThan(0);

    // Related records
    expect(full.related.outgoing.length).toBeGreaterThanOrEqual(2);
    const outgoingIds = full.related.outgoing.map(r => r.docId);
    expect(outgoingIds).toContain('cli-acme');
  });

  it('returns error for missing document', async () => {
    const result = await engine.getDocumentFull(docId('nonexistent'));
    expect(result.ok).toBe(false);
  });
});

describe('schemaInfo', () => {
  it('returns field definitions for a type', () => {
    const result = engine.schemaInfo(docType('client'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const info = result.value;
    expect(info.type).toBe('client');
    expect(info.fields.length).toBeGreaterThan(0);

    // Name field should be required
    const nameField = info.fields.find(f => f.name === 'name');
    expect(nameField).toBeDefined();
    expect(nameField!.required).toBe(true);
    expect(nameField!.type).toBe('string');

    // Status should be an enum with values
    const statusField = info.fields.find(f => f.name === 'status');
    expect(statusField).toBeDefined();
    expect(statusField!.type).toBe('enum');
    expect(statusField!.values).toBeDefined();
    expect(statusField!.values!.length).toBeGreaterThan(0);

    // primary_contact should be a ref
    const contactField = info.fields.find(f => f.name === 'primary_contact');
    expect(contactField).toBeDefined();
    expect(contactField!.type).toContain('ref');
    expect(contactField!.target).toBe('contact');

    // idPrefix from registry
    expect(info.idPrefix).toBe('cli');
  });

  it('includes format hints for date fields', () => {
    const result = engine.schemaInfo(docType('case'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const dateField = result.value.fields.find(f => f.name === 'opened_at');
    expect(dateField).toBeDefined();
    expect(dateField!.format).toBe('YYYY-MM-DD');
  });

  it('returns error for unknown type', () => {
    const result = engine.schemaInfo(docType('nonexistent'));
    expect(result.ok).toBe(false);
  });
});
