import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteBackend } from '../../src/backend/sqlite/index.js';
import {
  docId,
  docType,
  schemaRef,
  filePath,
  blockId,
  type DocumentRecord,
  type ExtractedObject,
  type Relationship,
  type ParsedBlock,
} from '../../src/types.js';

let backend: SqliteBackend;

beforeEach(() => {
  backend = new SqliteBackend(':memory:');
  backend.init();
});

afterEach(() => {
  backend.close();
});

function makeDoc(id: string, type: string, path: string): DocumentRecord {
  return {
    docId: docId(id),
    docType: docType(type),
    schemaRef: schemaRef(`${type}.v1`),
    filePath: filePath(path),
    fileHash: 'hash_' + id,
    version: 1,
    frontmatter: { doc_id: id, doc_type: type, name: 'Test' },
    deleted: false,
    indexedAt: new Date().toISOString(),
  };
}

function makeObject(id: string, primitive: string, subtype: string, value: string): ExtractedObject {
  return {
    primitive: primitive as ExtractedObject['primitive'],
    subtype,
    value,
    normalizedValue: value,
    label: value,
    role: null,
    docId: docId(id),
    location: { file: filePath('test.md'), line: 10, col: 0 },
    blockId: null,
  };
}

describe('SqliteBackend', () => {
  describe('documents', () => {
    it('puts and gets a document', () => {
      const doc = makeDoc('cli-acme', 'client', 'clients/cli-acme.md');
      backend.putDocument(doc);

      const result = backend.getDocument(docId('cli-acme'));
      expect(result).not.toBeNull();
      expect(result!.docId).toBe('cli-acme');
      expect(result!.docType).toBe('client');
      expect(result!.frontmatter.name).toBe('Test');
    });

    it('gets document by path', () => {
      backend.putDocument(makeDoc('cli-acme', 'client', 'clients/cli-acme.md'));

      const result = backend.getDocumentByPath(filePath('clients/cli-acme.md'));
      expect(result).not.toBeNull();
      expect(result!.docId).toBe('cli-acme');
    });

    it('returns null for missing document', () => {
      expect(backend.getDocument(docId('nonexistent'))).toBeNull();
    });

    it('removes a document with cascade', () => {
      const doc = makeDoc('cli-acme', 'client', 'clients/cli-acme.md');
      backend.putDocument(doc);
      backend.putObjects(docId('cli-acme'), [makeObject('cli-acme', 'entity', 'name', 'Acme')]);
      backend.putBlocks(docId('cli-acme'), [{ id: blockId('main'), heading: 'Acme', level: 1, startLine: 5, endLine: 10, content: 'Content' }]);

      backend.removeDocument(docId('cli-acme'));

      expect(backend.getDocument(docId('cli-acme'))).toBeNull();
      expect(backend.findObjects({ docId: docId('cli-acme') })).toHaveLength(0);
      expect(backend.getBlocks(docId('cli-acme'))).toHaveLength(0);
    });
  });

  describe('findDocuments', () => {
    beforeEach(() => {
      backend.putDocument(makeDoc('cli-acme', 'client', 'clients/cli-acme.md'));
      backend.putDocument(makeDoc('cli-beta', 'client', 'clients/cli-beta.md'));
      backend.putDocument(makeDoc('cas-001', 'case', 'cases/cas-001.md'));

      backend.putFieldIndex(docId('cli-acme'), [
        { name: 'status', value: 'active', numericValue: null, type: 'enum' },
        { name: 'name', value: 'Acme Corporation', numericValue: null, type: 'string' },
      ]);
      backend.putFieldIndex(docId('cli-beta'), [
        { name: 'status', value: 'inactive', numericValue: null, type: 'enum' },
        { name: 'name', value: 'Beta Inc', numericValue: null, type: 'string' },
      ]);
      backend.putFieldIndex(docId('cas-001'), [
        { name: 'status', value: 'open', numericValue: null, type: 'enum' },
      ]);
    });

    it('finds by doc_type', () => {
      const results = backend.findDocuments({ docType: docType('client') });
      expect(results).toHaveLength(2);
    });

    it('finds with eq filter', () => {
      const results = backend.findDocuments({
        docType: docType('client'),
        filters: { status: { op: 'eq', value: 'active' } },
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.docId).toBe('cli-acme');
    });

    it('finds with contains filter', () => {
      const results = backend.findDocuments({
        filters: { name: { op: 'contains', value: 'Acme' } },
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.docId).toBe('cli-acme');
    });

    it('includes frontmatter when requested', () => {
      const results = backend.findDocuments({
        docType: docType('client'),
        includeFrontmatter: true,
      });
      expect(results[0]!.frontmatter).toBeDefined();
      expect(results[0]!.frontmatter!.name).toBe('Test');
    });

    it('handles numeric range queries correctly', () => {
      // Add docs with numeric fields where lexicographic ordering would fail
      backend.putDocument(makeDoc('item-2', 'item', 'items/item-2.md'));
      backend.putDocument(makeDoc('item-10', 'item', 'items/item-10.md'));
      backend.putDocument(makeDoc('item-100', 'item', 'items/item-100.md'));

      backend.putFieldIndex(docId('item-2'), [
        { name: 'count', value: '2', numericValue: 2, type: 'number' },
      ]);
      backend.putFieldIndex(docId('item-10'), [
        { name: 'count', value: '10', numericValue: 10, type: 'number' },
      ]);
      backend.putFieldIndex(docId('item-100'), [
        { name: 'count', value: '100', numericValue: 100, type: 'number' },
      ]);

      // Numeric gt: 2 > should return 10 and 100 (lexicographic would return 100 only since "2" > "10")
      const results = backend.findDocuments({
        filters: { count: { op: 'gt', value: 2 } },
      });
      expect(results).toHaveLength(2);
      const ids = results.map(r => r.docId as string).sort();
      expect(ids).toEqual(['item-10', 'item-100']);

      // Numeric lte: <= 10 should return 2 and 10
      const results2 = backend.findDocuments({
        filters: { count: { op: 'lte', value: 10 } },
      });
      expect(results2).toHaveLength(2);
      const ids2 = results2.map(r => r.docId as string).sort();
      expect(ids2).toEqual(['item-10', 'item-2']);

      // Clean up
      backend.removeDocument(docId('item-2'));
      backend.removeDocument(docId('item-10'));
      backend.removeDocument(docId('item-100'));
    });

    it('handles date range queries lexicographically', () => {
      backend.putFieldIndex(docId('cli-acme'), [
        { name: 'opened_at', value: '2026-01-15', numericValue: null, type: 'date' },
      ]);
      backend.putFieldIndex(docId('cli-beta'), [
        { name: 'opened_at', value: '2026-06-01', numericValue: null, type: 'date' },
      ]);

      // Date range: >= 2026-03-01 should return only cli-beta
      const results = backend.findDocuments({
        filters: { opened_at: { op: 'gte', value: '2026-03-01' } },
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.docId).toBe('cli-beta');
    });

    it('respects limit and offset', () => {
      const page1 = backend.findDocuments({ docType: docType('client'), limit: 1, offset: 0 });
      const page2 = backend.findDocuments({ docType: docType('client'), limit: 1, offset: 1 });
      expect(page1).toHaveLength(1);
      expect(page2).toHaveLength(1);
      expect(page1[0]!.docId).not.toBe(page2[0]!.docId);
    });
  });

  describe('objects', () => {
    it('puts and finds objects', () => {
      backend.putDocument(makeDoc('cli-acme', 'client', 'clients/cli-acme.md'));
      backend.putObjects(docId('cli-acme'), [
        makeObject('cli-acme', 'entity', 'person', 'Jane Smith'),
        makeObject('cli-acme', 'date', 'date', '2026-03-28'),
      ]);

      const all = backend.findObjects({ docId: docId('cli-acme') });
      expect(all).toHaveLength(2);

      const people = backend.findObjects({ primitive: 'entity', subtype: 'person' });
      expect(people).toHaveLength(1);
      expect(people[0]!.value).toBe('Jane Smith');

      const dates = backend.findObjects({ primitive: 'date' });
      expect(dates).toHaveLength(1);
    });

    it('searches with contains', () => {
      backend.putDocument(makeDoc('rpt-001', 'report', 'reports/rpt-001.md'));
      backend.putObjects(docId('rpt-001'), [
        makeObject('rpt-001', 'entity', 'person', 'Officer Davis'),
        makeObject('rpt-001', 'entity', 'person', 'Maria Torres'),
      ]);

      const results = backend.findObjects({ contains: 'Davis' });
      expect(results).toHaveLength(1);
      expect(results[0]!.value).toBe('Officer Davis');
    });

    it('replaces objects on re-put', () => {
      backend.putDocument(makeDoc('cli-acme', 'client', 'clients/cli-acme.md'));
      backend.putObjects(docId('cli-acme'), [makeObject('cli-acme', 'entity', 'person', 'Old')]);
      backend.putObjects(docId('cli-acme'), [makeObject('cli-acme', 'entity', 'person', 'New')]);

      const results = backend.findObjects({ docId: docId('cli-acme') });
      expect(results).toHaveLength(1);
      expect(results[0]!.value).toBe('New');
    });
  });

  describe('relationships', () => {
    beforeEach(() => {
      backend.putDocument(makeDoc('cli-acme', 'client', 'clients/cli-acme.md'));
      backend.putDocument(makeDoc('cas-001', 'case', 'cases/cas-001.md'));
      backend.putDocument(makeDoc('con-jane', 'contact', 'contacts/con-jane.md'));

      const rels: Relationship[] = [
        { sourceDocId: docId('cas-001'), targetDocId: docId('cli-acme'), field: 'client', relationType: 'ref' },
        { sourceDocId: docId('cas-001'), targetDocId: docId('con-jane'), field: 'primary_contact', relationType: 'ref' },
      ];
      backend.putRelationships(docId('cas-001'), rels);
    });

    it('gets outgoing relationships', () => {
      const rels = backend.getRelationships(docId('cas-001'), 'outgoing');
      expect(rels).toHaveLength(2);
    });

    it('gets incoming relationships', () => {
      const rels = backend.getRelationships(docId('cli-acme'), 'incoming');
      expect(rels).toHaveLength(1);
      expect(rels[0]!.sourceDocId).toBe('cas-001');
    });

    it('gets both directions', () => {
      const rels = backend.getRelationships(docId('cas-001'), 'both');
      expect(rels).toHaveLength(2); // 2 outgoing, 0 incoming
    });
  });

  describe('blocks', () => {
    it('puts and gets blocks', () => {
      backend.putDocument(makeDoc('cas-001', 'case', 'cases/cas-001.md'));
      const blocks: ParsedBlock[] = [
        { id: blockId('summary'), heading: 'Summary', level: 1, startLine: 5, endLine: 10, content: 'Summary content' },
        { id: blockId('timeline'), heading: 'Timeline', level: 2, startLine: 12, endLine: 20, content: 'Timeline content' },
      ];
      backend.putBlocks(docId('cas-001'), blocks);

      const result = backend.getBlocks(docId('cas-001'));
      expect(result).toHaveLength(2);
      expect(result[0]!.id).toBe('summary');
      expect(result[1]!.id).toBe('timeline');
      expect(result[0]!.content).toBe('Summary content');
    });
  });

  describe('materializeDocument', () => {
    it('writes everything in a single transaction', () => {
      const doc = makeDoc('cli-acme', 'client', 'clients/cli-acme.md');
      const objects = [makeObject('cli-acme', 'entity', 'name', 'Acme')];
      const rels: Relationship[] = [];
      const blocks: ParsedBlock[] = [
        { id: blockId('main'), heading: 'Acme', level: 1, startLine: 5, endLine: 10, content: 'Main' },
      ];
      const fields = [{ name: 'status', value: 'active', numericValue: null, type: 'enum' }];

      backend.materializeDocument(doc, objects, rels, blocks, fields);

      expect(backend.getDocument(docId('cli-acme'))).not.toBeNull();
      expect(backend.findObjects({ docId: docId('cli-acme') })).toHaveLength(1);
      expect(backend.getBlocks(docId('cli-acme'))).toHaveLength(1);
    });
  });

  describe('file hashes', () => {
    it('gets file hash', () => {
      backend.putDocument(makeDoc('cli-acme', 'client', 'clients/cli-acme.md'));
      expect(backend.getFileHash(filePath('clients/cli-acme.md'))).toBe('hash_cli-acme');
    });

    it('returns null for unknown path', () => {
      expect(backend.getFileHash(filePath('nonexistent.md'))).toBeNull();
    });

    it('gets all file hashes', () => {
      backend.putDocument(makeDoc('cli-acme', 'client', 'clients/cli-acme.md'));
      backend.putDocument(makeDoc('cli-beta', 'client', 'clients/cli-beta.md'));

      const hashes = backend.getAllFileHashes();
      expect(hashes.size).toBe(2);
    });
  });

  describe('stats', () => {
    it('returns correct stats', () => {
      backend.putDocument(makeDoc('cli-acme', 'client', 'clients/cli-acme.md'));
      backend.putDocument(makeDoc('cas-001', 'case', 'cases/cas-001.md'));
      backend.putObjects(docId('cli-acme'), [makeObject('cli-acme', 'entity', 'name', 'Acme')]);
      backend.putRelationships(docId('cas-001'), [
        { sourceDocId: docId('cas-001'), targetDocId: docId('cli-acme'), field: 'client', relationType: 'ref' },
      ]);

      const stats = backend.getStats();
      expect(stats.totalDocuments).toBe(2);
      expect(stats.totalObjects).toBe(1);
      expect(stats.totalRelationships).toBe(1);
      expect(stats.documentCountByType['client']).toBe(1);
      expect(stats.documentCountByType['case']).toBe(1);
    });
  });
});
