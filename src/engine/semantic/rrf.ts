// ============================================================================
// Reciprocal Rank Fusion (0.8.0)
// Merge N independently-ranked lists into one score map. RRF is rank-based and
// scale-free — exactly why the engine fuses here rather than handing the agent
// two incomparable score columns (BM25 vs cosine distance). Each item's score
// is Σ over the lists it appears in of 1/(K + rank), rank 1-based.
//
// Used for hybrid (two legs). Called with a single list it degrades to a clean
// rank-based score, so exact/semantic single-leg paths reuse the same merge.
// ============================================================================

/** Default RRF constant. 60 is the value from the original RRF paper; larger K
 *  flattens the contribution of top ranks (less aggressive). */
export const DEFAULT_RRF_K = 60;

/**
 * Fuse ranked lists of opaque string keys. Input lists are in rank order (index
 * 0 = best). Returns a key→score map; higher score = more relevant.
 */
export function rrfFuse(lists: string[][], k: number = DEFAULT_RRF_K): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const key = list[i]!;
      const contribution = 1 / (k + i + 1);
      scores.set(key, (scores.get(key) ?? 0) + contribution);
    }
  }
  return scores;
}
