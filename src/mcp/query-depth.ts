// ============================================================================
// 0.7.3 — maad_query depth hydration helper.
//
// Composite that kills the query-then-N-gets agent pattern. After the engine
// finds matching pointer rows, the handler optionally hydrates each row with
// body content (depth=cold) or full composite (depth=full).
//
// Sequential per-row to keep memory bounded and to mirror per-doc error
// surfaces; one failure does not abort the batch — failed rows omit
// body/composite and stamp `_hydrationError` so callers see the partial.
//
// Hard cap on hydration count (default 50, max 100) keeps response payloads
// from blowing past the response-size guard. Beyond cap, remaining rows
// return at hot depth.
// ============================================================================

import type { DocId } from '../types.js';
import type { DocumentMatch } from '../types.js';
import type { GetResult, GetFullResult } from '../engine/types.js';
import type { Result } from '../errors.js';

export type QueryDepth = 'hot' | 'cold' | 'full';

export interface HydrationEngine {
  getDocument(id: DocId, depth: 'cold'): Promise<Result<GetResult>>;
  getDocumentFull(id: DocId): Promise<Result<GetFullResult>>;
}

export interface HydrationOptions {
  depth: QueryDepth;
  depthMaxResults?: number;
}

export interface HydratedRow extends DocumentMatch {
  body?: string;
  composite?: GetFullResult;
  _hydrationError?: string;
}

export interface HydrationOutcome {
  rows: HydratedRow[];
  meta: { depth: QueryDepth; hydrated: number; capped?: boolean } | null;
}

const HARD_CAP = 100;
const DEFAULT_CAP = 50;

export async function hydrateQueryRows(
  engine: HydrationEngine,
  rows: DocumentMatch[],
  opts: HydrationOptions,
): Promise<HydrationOutcome> {
  if (opts.depth === 'hot') {
    return { rows, meta: null };
  }

  const requested = opts.depthMaxResults ?? DEFAULT_CAP;
  const cap = Math.min(Math.max(1, requested), HARD_CAP);
  const toHydrate = Math.min(rows.length, cap);

  const hydrated: HydratedRow[] = await Promise.all(
    rows.slice(0, toHydrate).map(async (row): Promise<HydratedRow> => {
      if (opts.depth === 'cold') {
        const r = await engine.getDocument(row.docId, 'cold');
        if (r.ok) return { ...row, body: r.value.body ?? '' };
        return { ...row, _hydrationError: r.errors[0]?.code ?? 'UNKNOWN' };
      }
      const r = await engine.getDocumentFull(row.docId);
      if (r.ok) return { ...row, composite: r.value };
      return { ...row, _hydrationError: r.errors[0]?.code ?? 'UNKNOWN' };
    }),
  );

  const merged: HydratedRow[] = [...hydrated, ...rows.slice(toHydrate)];
  const meta: HydrationOutcome['meta'] = { depth: opts.depth, hydrated: toHydrate };
  if (rows.length > cap) meta.capped = true;
  return { rows: merged, meta };
}
