# Retrieval scope and corpus growth

Exact search now applies live-document, document-type and expanded field filters in SQL before the lexical candidate limit. It no longer selects the 2,000 most recently indexed documents as an eligibility list. Ordinary document queries and retrieval share the same filter builder, including numeric ranges and multi-value inequality semantics. Parameters remain bound values. Indexing time has no relevance weight; lexical ties use document ID and block ordinal for deterministic ordering.

Exact mode makes zero embedding calls. FTS tokenization remains OR-based BM25, not literal phrase matching. Search still retrieves at most `max(5*k, 50)` lexical blocks before best-block document rollup; many matching blocks in one document can therefore underfill a page. SQL can evaluate a large matching scope, but no unbounded document ID list is transferred to the engine.

Vector search uses the existing global nearest-neighbor query, with a fixed 1,000-block candidate budget for scoped requests. Only those bounded candidate IDs are checked against the shared relational predicates, before fusion. An older document inside that pool remains eligible regardless of indexing order. Documents outside the global pool can still be missed, including when out-of-scope neighbors fill it. This is bounded candidate retrieval, not exhaustive scoped vector recall. Unscoped vector requests retain their existing `max(5*k, 50)` pool.

Deleted and missing documents cannot pass relational eligibility. Hydration also checks live document existence. Each search uses its supplied project backend; caller authorization and project selection remain the application layer's responsibility. Field filters can enforce a supplied access scope but are not an authorization system. No cross-project counts or new persistent storage are introduced.

## Compatibility and limitations

`mode`, `results`, snippets, scores and `total` keep their existing meanings. **`total` is the returned count**, not the number of all matches or eligible documents. RRF scores are ranking signals. Existing fallback strings in `degraded` remain unchanged. Scoped vector saturation now sets legacy `degraded: scope_truncated` even on a full page, unless a fallback reason takes precedence.

The optional additive `limitations` array reports independent conditions:

| Value | Meaning |
|---|---|
| `no_vector_provider` | Requested vector retrieval fell back to lexical because the vector index/provider was unavailable. |
| `embed_failed` | Query embedding failed; lexical fallback was used. |
| `vec_search_failed` | Vector query failed; lexical fallback was used. |
| `lexical_candidate_pool_saturated` | The lexical leg filled its block budget. |
| `vector_candidate_pool_saturated` | The global vector leg filled its block budget, whether or not the returned page is full. |
| `embeddings_pending` | At least one live, in-scope block remains in the embedding queue. |

Saturation is conservative: filling a budget does not prove additional matches exist. Pending embedding detection uses a scoped existence query, not a global count; it is not a complete index-health or coverage measurement. Exact requests do not report embedding limitations. Multiple limitations can coexist. Empty or punctuation-only lexical queries yield no matches. Scoped semantic requests may now embed even when no document is eligible, because the old preliminary allow-list query is gone.

The low-level `searchFts` optional ID restriction remains available; an explicitly empty ID list now matches nothing. Its new optional relational scope is AND-combined with that restriction. Custom semantic-index implementations must implement the candidate-filter and pending-embedding methods.

## Verification

Run from the repository root:

```powershell
npx vitest run tests/engine/semantic-scope-growth.test.ts tests/engine/semantic-search.test.ts tests/backend/semantic-store.test.ts
npm run lint
npm test
npx vitest run --config tests/performance/vitest.config.ts
```

The growth fixture has 2,105 documents, one old unique lexical match, and 2,104 newer irrelevant updates. Running the old-evidence regression with the original search implementation returned `[]` instead of `['old']`; restoring this implementation passes. Tests cover indexing-order changes, zero query embedding calls in exact mode, document type and access/range filters, no matches, soft/hard deletion, older vector eligibility, full-page saturation, out-of-scope vector crowding, and simultaneous fallback/lexical saturation/pending embeddings. Existing backend filter and application access tests remain part of the full suite.

## Opt-in baseline

The separate performance configuration is not part of normal test discovery. It creates one SQLite index under an allocated OS temporary directory, populates it through the backend, validates each result, then closes the backend and removes only that verified fixture root. No dependencies, runtime directories, environment defaults, canonical markdown files, Git history or network model calls are added.

The workload has 1,000 and 10,000 documents with one block each, one unique old match, repeated irrelevant update text, two scalar fields, no graph edges, no concurrent mutations, and no background worker. Source timestamps are fixed at 2020; indexing timestamps distinguish the old record (2000) from updates (2026). Corpus duplication is intentionally high. Each query runs once for first-call timing, five more warmups, then 30 measured samples. The reported first call is **not** a cold OS-cache measurement. Timings include filtering, FTS, fusion, document hydration and snippet handling, but exclude fixture construction.

Observed on 2026-09-05, Windows x64, Node 24.15.0, installed Vitest 4.1.11:

| Documents | Query | First ms | p50 ms | p95 ms | p99 ms |
|---:|---|---:|---:|---:|---:|
| 1,000 | Unique match | 2.20 | 0.50 | 0.57 | 0.57 |
| 1,000 | Common term | 1.90 | 1.92 | 2.19 | 12.24 |
| 10,000 | Unique match | 4.99 | 4.58 | 6.04 | 6.25 |
| 10,000 | Common term | 12.47 | 12.51 | 13.17 | 13.55 |

Main database files were about 1.12 MB and 9.21 MB (WAL bytes excluded); process RSS snapshots ranged from 106 to 131 MB. These are small local observations, not production guarantees or before/after speedup claims. Thirty samples provide only coarse tail estimates. The broader roadmap's proposed 30% read-latency and 40% call-count improvements concern later read workflows and are not demonstrated here. This slice establishes correctness and measurements; it sets no performance pass/fail threshold.

Remaining work includes 100k corpora, Linux/cold-cache/multi-project/mixed-write runs, vector and per-stage timing, event-loop delay and index lag, richer relevance judgments, known scope counts, index generations, quantified embedding coverage, and resumable passage retrieval. Temporal investigation, caches, durable events, bulk mutation and releases are outside this slice.

## Validation outcome

- `npm run lint`: passed.
- Targeted semantic/backend run: 31 tests passed; the final growth file then passed all five tests after adding the multi-value and pending-metadata isolation case.
- Initial `npm test`: 1,288 tests passed before one worker exited unexpectedly; Vitest reported an unhandled fork-pool error and exited nonzero. This was not treated as a successful suite.
- `npm test -- --maxWorkers=1`: passed, 115 files / 1,301 tests, with one pre-existing skipped file / six pre-existing skipped tests, in 192.27 seconds. No new test is skipped.
- Opt-in baseline: passed its result assertions and emitted the measurements above.
- `git diff --check`: passed. No dependency, version or release changes were made.
