// ============================================================================
// maad_semantic_search (0.8.0) — the one retrieval primitive, with a 3-mode dial.
//   exact    — FTS5/BM25 only. Touches NO model (deterministic, no embedding).
//   semantic — query-embed + vector KNN.
//   hybrid   — both legs, fused by RRF.
// Retrieval is block-level; results roll up to documents (best block per doc)
// with a snippet. The agent picks the mode → that choice lands in the audit
// trail, preserving the determinism contract (vs auto-fusing engines).
// ============================================================================

import { ok, singleErr, type Result } from '../../errors.js';
import { docId as toDocId, docType as toDocType, type DocumentQuery } from '../../types.js';
import type { EngineContext } from '../context.js';
import { logger } from '../logger.js';
import { expandFilters, MAX_QUERY_LIMIT } from '../reads.js';
import { rrfFuse, DEFAULT_RRF_K } from './rrf.js';
import type {
  SemanticSearchQuery,
  SemanticSearchResult,
  SemanticHit,
  SearchMode,
} from './types.js';

const DEFAULT_K = 10;
const MODES: readonly SearchMode[] = ['exact', 'hybrid', 'semantic'];
const KEY_SEP = ' ';
const SNIPPET_MAX = 240;
// This vec0 query retrieves global neighbors. Under scope, retrieve a bounded
// wider pool and apply relational eligibility before fusion.
const VEC_SCOPE_POOL_CAP = 1000;

export function isValidMode(mode: string): mode is SearchMode {
  return (MODES as readonly string[]).includes(mode);
}

function clampK(k: number | undefined): number {
  if (k === undefined || !Number.isFinite(k)) return DEFAULT_K;
  return Math.max(1, Math.min(Math.trunc(k), MAX_QUERY_LIMIT));
}

function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1).trimEnd() + '…';
}

interface BlockMeta { docId: string; blockOrd: number; heading: string; snippet: string }

export async function semanticSearch(
  ctx: EngineContext,
  query: SemanticSearchQuery,
): Promise<Result<SemanticSearchResult>> {
  if (!isValidMode(query.mode)) {
    return singleErr('INVALID_MODE', `Invalid mode '${query.mode}'. Valid modes: ${MODES.join(', ')}.`);
  }
  const sem = ctx.backend.semantic();
  if (!sem || !sem.isReady()) {
    return singleErr('SEMANTIC_DISABLED',
      'Semantic retrieval is not enabled on this engine. Set MAAD_SEMANTIC_ENABLE and run reindex --embeddings.');
  }

  const text = (query.query ?? '').trim();
  const k = clampK(query.k);
  const withSnippet = query.snippet ?? true;
  if (text.length === 0) return ok({ mode: query.mode, total: 0, results: [] });

  const expanded = expandFilters(query.filters as Record<string, unknown> | undefined);
  if (!expanded.ok) return expanded;
  const scope: DocumentQuery = { filters: expanded.value };
  if (query.docType !== undefined) scope.docType = toDocType(query.docType);
  const scoped = query.docType !== undefined || query.filters !== undefined;
  // Scoped FTS is also needed for vector-error lexical fallback. Exact mode
  // needs no vector helper. Never pass scope to legacy methods that may ignore it.
  if (scoped && (!sem.searchFtsScoped || (query.mode !== 'exact' && !sem.filterDocIds))) {
    return singleErr('SEMANTIC_DISABLED',
      'This semantic backend does not support relational scopes. Implement searchFtsScoped (and filterDocIds for vector modes); the requested scope was not executed.');
  }
  let degraded: string | undefined;
  const limitations: string[] = [];

  const basePool = Math.max(k * 5, 50);
  const ftsPool = basePool;
  // Over-fetch the vec leg under scope (no in-SQL filter) so in-scope blocks
  // ranked below out-of-scope ones still enter the candidate set.
  const vecPool = scoped ? VEC_SCOPE_POOL_CAP : basePool;

  const needVec = query.mode !== 'exact';
  const vecAvailable = needVec && sem.isVecReady() && ctx.embeddingProvider !== undefined;

  let useFts = query.mode === 'exact' || query.mode === 'hybrid';
  let useVec = vecAvailable && (query.mode === 'semantic' || query.mode === 'hybrid');
  if (needVec && !vecAvailable) degraded = degraded ?? 'no_vector_provider';
  if (query.mode === 'semantic' && !vecAvailable) useFts = true; // lexical fallback

  // Embed the query up front (only when a vector leg is needed) so exact mode
  // provably never touches a model. A query-embed failure degrades to lexical.
  let queryVec: Float32Array | null = null;
  if (useVec) {
    try {
      const embedded = await ctx.embeddingProvider!.embed([text], 'query');
      queryVec = embedded[0] ?? null;
    } catch (e) {
      logger.bestEffort('engine', 'semantic_query_embed_failed',
        `query embedding failed; lexical fallback: ${(e as Error).message}`);
      queryVec = null;
    }
    if (queryVec === null) {
      useVec = false;
      useFts = true;
      degraded = 'embed_failed';
    }
    // A concurrent reload may have closed the backend during the embed await;
    // semantic() returns null once the backend is closed.
    if (ctx.backend.semantic() === null) {
      return singleErr('SEMANTIC_DISABLED', 'Engine reloaded during semantic search; retry the request.');
    }
  }

  const blockMeta = new Map<string, BlockMeta>();
  const lists: string[][] = [];

  const pushFtsLeg = (): void => {
    const ftsList: string[] = [];
    const ftsHits = sem.searchFtsScoped
      ? sem.searchFtsScoped(text, ftsPool, withSnippet, scope)
      : sem.searchFts(text, ftsPool, withSnippet);
    if (ftsHits.length >= ftsPool) limitations.push('lexical_candidate_pool_saturated');
    for (const h of ftsHits) {
      const key = h.docId + KEY_SEP + h.blockOrd;
      ftsList.push(key);
      if (!blockMeta.has(key)) {
        blockMeta.set(key, { docId: h.docId, blockOrd: h.blockOrd, heading: h.heading, snippet: h.snippet });
      }
    }
    lists.push(ftsList);
  };

  if (useFts) pushFtsLeg();

  let vecTruncated = false;
  if (useVec && queryVec !== null) {
    try {
      const vecHits = sem.searchVec(queryVec, vecPool);
      if (vecHits.length >= vecPool) vecTruncated = true;
      const eligible = sem.filterDocIds
        ? new Set(sem.filterDocIds([...new Set(vecHits.map(h => h.docId))], scope))
        : null; // Legacy unscoped retrieval still checks live documents at hydration.
      const vecList: string[] = [];
      for (const h of vecHits) {
        if (eligible && !eligible.has(h.docId)) continue;
        const key = h.docId + KEY_SEP + h.blockOrd;
        vecList.push(key);
        if (!blockMeta.has(key)) {
          blockMeta.set(key, { docId: h.docId, blockOrd: h.blockOrd, heading: '', snippet: '' });
        }
      }
      lists.push(vecList);
    } catch (e) {
      // A vec-index error (e.g. dim mismatch / corruption) degrades to lexical
      // instead of failing the whole search — matching the embed-failure path.
      logger.bestEffort('engine', 'semantic_vec_search_failed',
        `vector search failed; lexical fallback: ${(e as Error).message}`);
      degraded = 'vec_search_failed';
      if (!useFts) pushFtsLeg();
    }
  }

  // Fuse (RRF of one list = clean rank-based score; of two = hybrid fusion).
  const scores = rrfFuse(lists, DEFAULT_RRF_K);

  // Roll up blocks → documents: keep each doc's best-scoring block, apply scope.
  const bestPerDoc = new Map<string, { key: string; score: number }>();
  for (const [key, score] of scores) {
    const meta = blockMeta.get(key)!;
    const cur = bestPerDoc.get(meta.docId);
    if (cur === undefined || score > cur.score) bestPerDoc.set(meta.docId, { key, score });
  }

  // Resolve documents (excludes soft-deleted/missing) and fill any missing
  // heading/snippet. Heading is always backfilled (it is the maad_get navigation
  // key); snippet only when requested.
  const hits: SemanticHit[] = [];
  for (const [dId, best] of bestPerDoc) {
    const doc = ctx.backend.getDocument(toDocId(dId));
    if (!doc) continue;
    const meta = blockMeta.get(best.key)!;
    let heading = meta.heading;
    let snippet = meta.snippet;
    if (heading.length === 0 || (withSnippet && snippet.length === 0)) {
      const bt = sem.getBlockText(dId, meta.blockOrd);
      if (bt) {
        if (heading.length === 0) heading = bt.heading;
        if (withSnippet && snippet.length === 0) snippet = truncate(bt.text, SNIPPET_MAX);
      }
    }
    hits.push({
      docId: dId,
      docType: doc.docType as string,
      blockOrd: meta.blockOrd,
      heading,
      score: best.score,
      snippet: withSnippet ? snippet : '',
    });
  }
  hits.sort((a, b) => b.score - a.score || a.docId.localeCompare(b.docId));

  const top = hits.slice(0, k);
  if (needVec) {
    if (!sem.hasPendingEmbeddings) limitations.push('embeddings_coverage_unknown');
    else if (sem.hasPendingEmbeddings(scope)) limitations.push('embeddings_pending');
  }
  // Signal a potentially-incomplete scoped result (vec leg saturated its pool).
  if (vecTruncated) limitations.push('vector_candidate_pool_saturated');
  if (degraded !== undefined) limitations.unshift(degraded);
  if (degraded === undefined && scoped && vecTruncated) degraded = 'scope_truncated';
  return ok({
    mode: query.mode,
    total: top.length,
    results: top,
    ...(limitations.length > 0 ? { limitations } : {}),
    ...(degraded !== undefined ? { degraded } : {}),
  });
}
