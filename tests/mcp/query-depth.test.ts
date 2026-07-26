// ============================================================================
// 0.7.3 — maad_query depth hydration.
//
// The handler in src/mcp/tools/read.ts delegates row hydration to
// hydrateQueryRows so the cap / sequential-error / meta-shape behavior is
// pure-function testable without spinning up an engine.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { hydrateQueryRows, type HydrationEngine } from '../../src/mcp/query-depth.js';
import { docId, docType, filePath } from '../../src/types.js';
import type { DocumentMatch } from '../../src/types.js';
import type { GetResult, GetFullResult } from '../../src/engine/types.js';
import type { Result } from '../../src/errors.js';

function makeRow(id: string): DocumentMatch {
  return {
    docId: docId(id),
    docType: docType('case'),
    filePath: filePath(`cases/${id}.md`),
  };
}

function makeGetResult(id: string, body: string): Result<GetResult> {
  return {
    ok: true,
    value: {
      docId: docId(id),
      docType: docType('case'),
      version: 1,
      updatedAt: '2026-05-01T00:00:00.000Z',
      depth: 'cold',
      frontmatter: {},
      body,
    } as GetResult,
  };
}

function makeFullResult(id: string): Result<GetFullResult> {
  return {
    ok: true,
    value: {
      docId: docId(id),
      docType: docType('case'),
      version: 1,
      updatedAt: '2026-05-01T00:00:00.000Z',
      frontmatter: {},
      body: 'full body',
      refs: [],
      objects: [],
      related: [],
    } as unknown as GetFullResult,
  };
}

describe('hydrateQueryRows — depth=hot is a no-op', () => {
  it('returns rows unchanged with null meta', async () => {
    const rows = [makeRow('cas-001'), makeRow('cas-002')];
    const engine: HydrationEngine = {
      getDocument: async () => { throw new Error('should not be called'); },
      getDocumentFull: async () => { throw new Error('should not be called'); },
    };
    const out = await hydrateQueryRows(engine, rows, { depth: 'hot' });
    expect(out.rows).toBe(rows);
    expect(out.meta).toBeNull();
  });
});

describe('hydrateQueryRows — depth=cold attaches body to each row', () => {
  it('hydrates all rows with bodies (under default cap of 50)', async () => {
    const rows = [makeRow('cas-001'), makeRow('cas-002'), makeRow('cas-003')];
    const engine: HydrationEngine = {
      getDocument: async (id) => makeGetResult(id as string, `body for ${id as string}`),
      getDocumentFull: async () => { throw new Error('not called'); },
    };
    const out = await hydrateQueryRows(engine, rows, { depth: 'cold' });
    expect(out.rows).toHaveLength(3);
    expect((out.rows[0] as { body?: string }).body).toBe('body for cas-001');
    expect((out.rows[1] as { body?: string }).body).toBe('body for cas-002');
    expect((out.rows[2] as { body?: string }).body).toBe('body for cas-003');
    expect(out.meta).toEqual({ depth: 'cold', hydrated: 3 });
  });

  it('caps hydration at depthMaxResults; remaining rows return at hot depth', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => makeRow(`cas-${i}`));
    const engine: HydrationEngine = {
      getDocument: async (id) => makeGetResult(id as string, `b-${id as string}`),
      getDocumentFull: async () => { throw new Error('not called'); },
    };
    const out = await hydrateQueryRows(engine, rows, { depth: 'cold', depthMaxResults: 2 });
    expect(out.rows).toHaveLength(5);
    expect((out.rows[0] as { body?: string }).body).toBe('b-cas-0');
    expect((out.rows[1] as { body?: string }).body).toBe('b-cas-1');
    // Remaining rows are unchanged hot-depth pointers — no body attached
    expect((out.rows[2] as { body?: string }).body).toBeUndefined();
    expect((out.rows[3] as { body?: string }).body).toBeUndefined();
    expect((out.rows[4] as { body?: string }).body).toBeUndefined();
    expect(out.meta).toEqual({ depth: 'cold', hydrated: 2, capped: true });
  });

  it('hard-caps depthMaxResults at 100 even when caller asks for more', async () => {
    const rows = Array.from({ length: 150 }, (_, i) => makeRow(`cas-${i}`));
    const engine: HydrationEngine = {
      getDocument: async (id) => makeGetResult(id as string, ''),
      getDocumentFull: async () => { throw new Error('not called'); },
    };
    const out = await hydrateQueryRows(engine, rows, { depth: 'cold', depthMaxResults: 5000 });
    expect(out.meta?.hydrated).toBe(100);
    expect(out.meta?.capped).toBe(true);
  });

  it('per-row failure does not abort the batch — failed row stamps _hydrationError', async () => {
    const rows = [makeRow('cas-001'), makeRow('cas-bad'), makeRow('cas-003')];
    const engine: HydrationEngine = {
      getDocument: async (id) => {
        if ((id as string) === 'cas-bad') {
          return { ok: false, errors: [{ code: 'FILE_NOT_FOUND', message: 'gone' }] };
        }
        return makeGetResult(id as string, 'ok');
      },
      getDocumentFull: async () => { throw new Error('not called'); },
    };
    const out = await hydrateQueryRows(engine, rows, { depth: 'cold' });
    expect(out.rows).toHaveLength(3);
    expect((out.rows[0] as { body?: string }).body).toBe('ok');
    expect((out.rows[1] as { _hydrationError?: string })._hydrationError).toBe('FILE_NOT_FOUND');
    expect((out.rows[2] as { body?: string }).body).toBe('ok');
  });
});

describe('hydrateQueryRows — depth=full attaches composite to each row', () => {
  it('hydrates all rows with full composite', async () => {
    const rows = [makeRow('cas-001'), makeRow('cas-002')];
    const engine: HydrationEngine = {
      getDocument: async () => { throw new Error('not called'); },
      getDocumentFull: async (id) => makeFullResult(id as string),
    };
    const out = await hydrateQueryRows(engine, rows, { depth: 'full' });
    expect(out.rows).toHaveLength(2);
    expect((out.rows[0] as { composite?: unknown }).composite).toBeDefined();
    expect((out.rows[1] as { composite?: unknown }).composite).toBeDefined();
    expect(out.meta).toEqual({ depth: 'full', hydrated: 2 });
  });
});

describe('hydrateQueryRows — empty input', () => {
  it('returns empty rows with hydrated=0 meta when depth=cold and rows=[]', async () => {
    const engine: HydrationEngine = {
      getDocument: async () => { throw new Error('not called'); },
      getDocumentFull: async () => { throw new Error('not called'); },
    };
    const out = await hydrateQueryRows(engine, [], { depth: 'cold' });
    expect(out.rows).toHaveLength(0);
    expect(out.meta).toEqual({ depth: 'cold', hydrated: 0 });
  });
});
