import { describe, expect, it } from 'vitest';
import { relationshipPaths } from '../../src/engine/reads.js';
import type { EngineContext } from '../../src/engine/context.js';
import { docId, docType, blockId, type DocId, type Relationship } from '../../src/types.js';

function ref(source: string, target: string, field: string, line: number | null = null): Relationship {
  return {
    sourceDocId: docId(source),
    targetDocId: docId(target),
    field,
    relationType: 'ref',
    evidence: {
      sourceLine: line,
      sourceBlockId: line === null ? null : blockId('links'),
      origin: { kind: 'field', name: field },
    },
  };
}

function mention(source: string, target: string, annotation: string): Relationship {
  return {
    sourceDocId: docId(source),
    targetDocId: docId(target),
    field: annotation,
    relationType: 'mention',
    evidence: {
      sourceLine: 12,
      sourceBlockId: blockId('notes'),
      origin: { kind: 'annotation', name: annotation },
    },
  };
}

function context(): EngineContext {
  const docs = new Map([
    ['doc-a', { docId: docId('doc-a'), docType: docType('item') }],
    ['doc-b', { docId: docId('doc-b'), docType: docType('item') }],
    ['doc-c', { docId: docId('doc-c'), docType: docType('item') }],
    ['doc-d', { docId: docId('doc-d'), docType: docType('item') }],
    ['doc-e', { docId: docId('doc-e'), docType: docType('item') }],
    ['doc-m', { docId: docId('doc-m'), docType: docType('note') }],
  ]);
  // Deliberately reverse the natural order. Traversal must not inherit backend
  // row order.
  const relationships: Relationship[] = [
    ref('doc-e', 'doc-d', 'next'),
    ref('doc-d', 'doc-a', 'cycle'),
    ref('doc-c', 'doc-d', 'next', 8),
    ref('doc-b', 'doc-d', 'next', 7),
    mention('doc-a', 'doc-m', 'person'),
    ref('doc-a', 'doc-missing', 'broken'),
    ref('doc-a', 'doc-c', 'alpha'),
    ref('doc-a', 'doc-b', 'beta'),
  ];

  const backend = {
    getDocument(id: DocId) {
      return docs.get(id as string) ?? null;
    },
    getRelationships(id: DocId, direction: 'outgoing' | 'incoming' | 'both') {
      const outgoing = relationships.filter(rel => rel.sourceDocId === id);
      const incoming = relationships.filter(rel => rel.targetDocId === id);
      if (direction === 'outgoing') return outgoing;
      if (direction === 'incoming') return incoming;
      return [...outgoing, ...incoming];
    },
  };
  return { backend } as unknown as EngineContext;
}

describe('relationshipPaths', () => {
  it('defaults to ref edges, preserves evidence, and represents missing targets', () => {
    const result = relationshipPaths(context(), { startDocId: docId('doc-a') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.contractVersion).toBe(1);
    expect(result.value.filters.extractionKinds).toEqual(['ref']);
    expect(result.value.nodes.some(node => node.docId === 'doc-m')).toBe(false);
    expect(result.value.nodes).toContainEqual({
      docId: 'doc-missing', docType: null, distance: 1, state: 'missing',
    });
    const broken = result.value.edges.find(edge => edge.targetDocId === 'doc-missing');
    expect(broken?.targetState).toBe('missing');
    expect(broken?.evidence.origin).toEqual({ kind: 'field', name: 'broken' });
    expect(result.value.paths.every(path => new Set(path.nodeIds).size === path.nodeIds.length)).toBe(true);
  });

  it('returns deterministic multiple paths to an optional target', () => {
    const query = { startDocId: docId('doc-a'), targetDocId: docId('doc-d'), maxDepth: 4 };
    const first = relationshipPaths(context(), query);
    const second = relationshipPaths(context(), query);
    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(first.value.target).toMatchObject({ docId: 'doc-d', state: 'present', reached: true });
    expect(first.value.paths.map(path => path.nodeIds)).toEqual([
      ['doc-a', 'doc-b', 'doc-d'],
      ['doc-a', 'doc-c', 'doc-d'],
    ]);
    expect(first.value.paths.flatMap(path => path.nodeIds).every(id => id !== 'doc-a'
      || first.value.paths.every(path => path.nodeIds.filter(node => node === id).length === 1))).toBe(true);
  });

  it('returns the zero-hop path when the optional target is the start', () => {
    const result = relationshipPaths(context(), {
      startDocId: docId('doc-a'), targetDocId: docId('doc-a'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.nodes.map(node => node.docId)).toEqual(['doc-a']);
    expect(result.value.edges).toEqual([]);
    expect(result.value.paths).toEqual([{
      pathId: 'path-0001', targetDocId: 'doc-a', nodeIds: ['doc-a'], edgeIds: [],
    }]);
    expect(result.value.truncation).toEqual({ truncated: false, limitsReached: [] });
  });

  it('supports incoming traversal and field or extraction-kind filters', () => {
    const incoming = relationshipPaths(context(), {
      startDocId: docId('doc-d'), direction: 'incoming', maxDepth: 1,
    });
    expect(incoming.ok).toBe(true);
    if (incoming.ok) {
      expect(incoming.value.nodes.map(node => node.docId)).toEqual(['doc-d', 'doc-b', 'doc-c', 'doc-e']);
    }

    const fields = relationshipPaths(context(), {
      startDocId: docId('doc-a'), fieldLabels: ['alpha'], maxDepth: 4,
    });
    expect(fields.ok).toBe(true);
    if (fields.ok) expect(fields.value.nodes.map(node => node.docId)).toEqual(['doc-a', 'doc-c']);

    const mentions = relationshipPaths(context(), {
      startDocId: docId('doc-a'), extractionKinds: ['mention'], maxDepth: 1,
    });
    expect(mentions.ok).toBe(true);
    if (mentions.ok) {
      expect(mentions.value.nodes.map(node => node.docId)).toEqual(['doc-a', 'doc-m']);
      expect(mentions.value.edges[0]?.evidence).toEqual({
        sourceLine: 12,
        sourceBlockId: 'notes',
        origin: { kind: 'annotation', name: 'person' },
      });
    }
  });

  it('traverses incoming and outgoing edges deterministically with direction both', () => {
    const query = {
      startDocId: docId('doc-d'),
      direction: 'both' as const,
      maxDepth: 1,
    };
    const first = relationshipPaths(context(), query);
    const second = relationshipPaths(context(), query);

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(first.value.direction).toBe('both');
    expect(first.value.nodes.map(node => node.docId)).toEqual([
      'doc-d', 'doc-a', 'doc-b', 'doc-c', 'doc-e',
    ]);
    expect(first.value.edges.map(edge => [edge.sourceDocId, edge.targetDocId])).toEqual([
      ['doc-b', 'doc-d'],
      ['doc-c', 'doc-d'],
      ['doc-d', 'doc-a'],
      ['doc-e', 'doc-d'],
    ]);
    expect(first.value.paths.map(path => path.nodeIds)).toEqual([
      ['doc-d', 'doc-b'],
      ['doc-d', 'doc-c'],
      ['doc-d', 'doc-a'],
      ['doc-d', 'doc-e'],
    ]);
  });

  it.each([
    ['maxDepth', { maxDepth: 1 }],
    ['maxNodes', { maxNodes: 2 }],
    ['maxEdges', { maxEdges: 1 }],
    ['maxPaths', { maxPaths: 1 }],
  ] as const)('reports explicit %s truncation', (limit, overrides) => {
    const result = relationshipPaths(context(), { startDocId: docId('doc-a'), ...overrides });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncation.truncated).toBe(true);
    expect(result.value.truncation.limitsReached).toContain(limit);
  });

  it('rejects limits above the hard cap and errors for a missing start', () => {
    const overCap = relationshipPaths(context(), { startDocId: docId('doc-a'), maxDepth: 5 });
    expect(overCap.ok).toBe(false);
    if (!overCap.ok) expect(overCap.errors[0]?.code).toBe('INVALID_FIELDS');

    const missing = relationshipPaths(context(), { startDocId: docId('doc-absent') });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors[0]?.code).toBe('FILE_NOT_FOUND');
  });
});
