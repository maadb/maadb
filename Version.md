---
enabled: true
current: 0.10.0
dev_flow: formal
---

# Version History

## 0.10.0 — 2026-07-12

Data-correctness release across YAML storage, soft-delete visibility, list-field query semantics, and exclusive document creation.

- **Type-faithful YAML lists.** List serialization preserves string lookalikes such as `"true"`, `"007"`, `"null"`, and `"a: b"` as strings while retaining actual booleans, numbers, and nulls. Validation now enforces every declared `item_type`, including default list-of-string behavior, and schema loading rejects invalid item types or enum lists without values.
- **Tombstone isolation.** Objects, blocks, relationships, subtype inventory, summary statistics, composites, aggregates, joins, and semantic results exclude data owned by soft-deleted documents. Relationships also omit deleted endpoints. Integrity sweeps ignore deleted sources and identify broken refs whose targets are retained tombstones through the additive `deletedTargets` detail field.
- **Correct list-field predicates.** `neq` now uses none-equal semantics for multi-valued fields, so `[x, y]` does not match `neq x`. Multiple positive range predicates on one field must be satisfied by the same indexed value rather than different list items.
- **Portable exclusive creation.** Filesystems that reject hard-link publication with `EPERM`, `ENOTSUP`, or `EOPNOTSUPP` fall back to a direct `wx` write. Existing targets remain protected from replacement; the fallback only relaxes reader atomicity while the new file is being written.

1127 tests passing (+9). No dependency changes or database migrations. Additive integrity response field: `details[].deletedTargets`. Behavior changes: malformed list items are rejected according to their declared schema type; soft-deleted child data is no longer visible through read surfaces; and list-field `neq`/multi-range filters now follow collection-correct semantics.

## 0.9.0 — 2026-07-10

Write-identity and filesystem-boundary enforcement. Every write path now fails closed on identity tampering and path escapes. Minor bump: this release changes caller-visible behavior in four ways.

**Breaking changes:**

- Caller-supplied `doc_id`, `doc_type`, or `schema` inside `fields` is rejected with `FRONTMATTER_GUARD` on create, update, and both bulk paths. Previously these keys were silently absorbed — and on create the caller value overrode the engine-owned identity, silently desyncing a document's stored identity from its filename and index row. Callers must strip identity keys from field payloads before writing.
- Registry schema references must match `<name>.v<N>` (lowercase/snake-case name, positive integer version). A non-conforming ref fails `REGISTRY_INVALID` at load and the project refuses to boot. Migration: rename the schema file and registry ref to conform, then repair stored `schema:` fields with `maad_repair_where fix_schema_drift`.
- Symlink escapes fail closed everywhere. Containment checks for not-yet-existing write paths now resolve the nearest existing ancestor through the real filesystem instead of falling back to a lexical check, and registry, schema, and template references are re-verified through realpath — a path that resolves outside the project root is rejected even if its text looks contained.
- Document creation publishes via hard link and now requires a filesystem with hard-link support (NTFS, ext4; not exFAT or some network mounts). Creation is exclusive: an on-disk file absent from the index is no longer overwritten — it fails `DUPLICATE_DOC_ID`, and two concurrent creates of the same document admit exactly one publisher.

Also in this release: update, delete, and repair validate a file's *stored* identity against the addressed record before touching it (mismatches fail `FRONTMATTER_GUARD`, or `REPAIR_REQUIRES_MIGRATION` on repair paths); atomic-write temp files carry pid + UUID so concurrent writers cannot collide on a shared temp name; and registry loading re-checks containment after directory creation. 1118 tests passing (+17: identity-guard coverage down to the MCP handler layer, symlink/junction escape rejection on both platforms, exclusive-create race). New dev dependency `@vitest/coverage-v8` for the coverage workflow; the vitest fork pool is bounded to 4 workers for deterministic runs on high-core hosts. No schema changes.

## 0.8.4 — 2026-07-09

Boot false-empty index guard. On the serving paths (the project pool and single-project startup), the engine now refuses to serve a persisted index that reports zero documents while registered paths hold markdown on disk — the "derived index was lost" shape (fresh clone, volume-restore, or a wiped `_backend/`). Previously `init()` succeeded with an empty index and every list/search/query silently returned `[]` (and the next single-file write left the index half-populated), so a routine restore could make live records invisible with no error.

Detection is exact: the guard fires only when the index is empty AND registered types exist AND markdown is present under a registered path, so a genuinely empty architect-mode project (types defined, no docs yet) still boots normally. Read-only mode fails closed with `INDEX_EMPTY` (it cannot rebuild the index); read-write mode fails closed by default, or rebuilds from the markdown at boot when `MAAD_BOOT_REINDEX=1` is set — `init()` runs before the per-request timeout is armed, so a blocking boot rebuild is not bound by the 30s cap, and embeddings drain asynchronously. The guard is scoped to the serving paths: the CLI bootstrap (`init` → reindex) and direct `indexAll` callers are unchanged.

New `INDEX_EMPTY` error code and `MAAD_BOOT_REINDEX` env flag (a behavior toggle, never a path). README's "delete `_backend/` and it rebuilds" note corrected to describe the explicit-reindex / boot-rebuild behavior. 1101 tests passing (+6). No dependency, schema, or API-shape changes.

## 0.8.3 — 2026-07-08

CLI CI-gate exit codes. `maad validate` and `maad reindex` now fail closed: both commands report findings inside a *successful* engine result (validate returns a completed report with an `invalid` count; full reindex returns per-file failures in `errors[]`), so the previous exit-code check — which only failed on engine errors — printed the problem and still exited 0, greenlighting CI over invalid or partially indexed data.

`maad validate` (whole-project and single-doc forms) exits nonzero when any document is structurally invalid, after printing the full report. Precision drift remains informational and never fails the gate. `maad reindex` exits nonzero when any per-file error occurred (parse failures, duplicate doc_ids, over-cap skips), after printing the report and regenerating MAAD.md/SCHEMA.md for the docs that did index; the 0.8.1 warnings channel stays advisory and does not affect exit status. Engine and MCP result semantics are unchanged — `maad_validate` / `maad_reindex` continue returning structured reports for callers to interpret.

1095 tests passing (+5, first process-exit coverage for CLI commands). No dependency, schema, or API changes. Behavior change: scripts that relied on exit 0 while validation or reindex reported findings will now fail — that is the point.

## 0.8.2 — 2026-07-07

Semantic re-embed gating. `putBlockText` now diffs incoming blocks against stored per-block content hashes instead of wholesale delete + re-enqueue: unchanged blocks keep their vectors and never re-enqueue (a pending queue row from an earlier failed embed survives and retries), metadata-only changes (heading/block id) refresh the text and FTS rows but keep the vector, text changes and new blocks replace and re-enqueue as before, and removed blocks clean all four semantic tables for their ordinal. Embedding is the expensive network/model-bound leg of the semantic index — previously ANY reindex of a doc re-embedded EVERY block, so a one-character edit or a frontmatter-only change paid the full re-embed cost. `maad_reindex --embeddings` still force-re-enqueues everything (the explicit rebuild path is unchanged).

Also fixes a latent single-flight race in the embed worker, present since 0.8.0 but surfaced by the gate: an empty-queue drain completes without awaiting, so a concurrent `flush()`/`kick()` could fold into a drain that had already passed its final rerun check and return without draining newly queued work. The fold now chains a follow-up check, so `flush()` reliably drains work enqueued at any point.

New `block_text.text_hash` column (auto-migrated via `ALTER`; pre-0.8.2 rows re-embed once on their next touch and heal to hashed form). 1090 tests passing (+6). No new dependencies, no new env vars, no API changes.

## 0.8.1 — 2026-07-07

Index integrity patch. A full audit of the indexing pipeline — prompted by a field incident where a routine `maad reindex --force` silently made hundreds of valid records invisible — closed a cluster of silent data-loss paths in `indexAll` and hardened the surrounding code.

- **Stale-row sweep guard.** The sweep never removes an index row whose file still exists on disk. A stale row with a live file means the file sits outside every scanned registered path (registry path mismatch — e.g. a kebab-case directory registered under its underscore name — glob failure, or moved directory); pruning it silently orphaned valid data and broke every inbound reference. Such rows are now kept and warned about; only rows whose files are genuinely gone are pruned, and the count surfaces as `IndexResult.pruned`. Related mismatch shapes warn too: a registered path that scanned zero files while the index holds rows of that type, and a missing registered directory.
- **Warnings surface end-to-end.** New `IndexResult.warnings` channel: the CLI prints warnings, prune counts, `rebuiltTypes`, and `partial` (previously dropped from human output), and `maad_reindex` attaches warnings to the standard `_meta.warnings` response channel.
- **docId-collision guard on reindex.** Two live files sharing a `doc_id` previously collapsed silently — the backend's `INSERT OR REPLACE` resolved on either the `doc_id` primary key or the `file_path` unique constraint, so one incoming row could delete up to two other docs' rows with no error, scan order deciding the winner. The backend now uses a targeted upsert on `doc_id`, and the indexer rejects genuine collisions with a `DUPLICATE_DOC_ID` indexing error (matching the write path's long-standing guard) while still handling legitimate moves and in-place `doc_id` renames explicitly.
- **Recursive scan fallback.** When `fs.promises.glob` is unavailable, the fallback directory walk was silently non-recursive — every doc in a subdirectory vanished from the scan and the sweep pruned its rows. The fallback now walks recursively and reports that it fired.
- **Schema-fingerprint retry.** Per-type schema-index fingerprints no longer persist when docs of that type failed to index, so a forced rebuild that partially failed stays dirty and retries on the next pass instead of hash-skipping the failed docs forever.
- **Persisted partial/stale state.** New `documents.partial` column (auto-migrated via `ALTER`, like `valid` in 0.7.17): annotation-capped docs persist their partial-body state, and a previously indexed file that grows past `MAAD_MAX_DOC_BYTES` keeps its row queryable but flagged stale, with its stored hash invalidated so it re-indexes the moment it's readable again. `maad_summary` warnings gain `partialDocs`.
- **Numeric indexing fixes.** List items now index numeric values per the schema's `item_type` (previously hardcoded to string, so numeric range filters on list-of-number/amount fields never matched), and `amount` values tolerate currency markers (`"$100"`, `"€ 1,500"`, `"USD 25"` previously extracted null).
- **Hot-path cleanups.** `indexAll` reads each file once (hash + parse shared one read; previously two full reads per changed file), takes a single `getAllFileHashes` snapshot per run (was two full-table scans), stats files asynchronously, and never reads a file already known to be over the byte cap. `removeDocument` is transaction-wrapped to match the write path's atomicity.

1084 tests passing (+10). One additive `documents.partial` column (auto-migrated). No new dependencies, no new env vars. Behavior changes: duplicate doc_ids across files now surface `DUPLICATE_DOC_ID` errors on reindex instead of silent last-wins, and stale index rows whose files still exist are kept and warned about instead of silently pruned.

## 0.8.0 — 2026-06-29

Semantic Retrieval. A new `maad_semantic_search` primitive adds meaning-based retrieval over record bodies, indexed per block, with a 3-mode dial — `exact` (FTS5/BM25, deterministic, no model), `semantic` (`sqlite-vec` vector KNN), and `hybrid` (both legs fused by Reciprocal Rank Fusion). One call in, one ranked list out; the agent picks the mode and that choice lands in the audit trail, so the engine never silently auto-fuses. Block-level hits roll up to documents with a best-block snippet.

Embeddings are derived and rebuildable — the canonical source stays markdown. They are generated async-on-write by a worker that runs outside the write mutex, so the deterministic write/commit path is unchanged and `exact` touches no model. The embedding provider is pluggable: host-injected (the engine holds no API keys) or env-constructed for standalone `maad serve`. This release ships the OpenAI provider and a deterministic offline provider; the local ONNX default (`nomic-embed-text-v1.5` via transformers.js) is deferred to a follow-up. With no provider, `semantic`/`hybrid` degrade to the lexical leg (flagged in `_meta.degraded`); `exact` always works.

Entirely opt-in behind `MAAD_SEMANTIC_ENABLE` — off, the engine behaves exactly as 0.7.x (no extension load, no new tables, no worker, fully additive). New surface: `maad_semantic_search`, `MAAD_SEMANTIC_ENABLE` / `MAAD_EMBED_*`, `maad_health.embeddings`, `maad_reindex --embeddings`. New **optional** dependency `sqlite-vec` — lazily required only when enabled, so the engine boots and runs unchanged whether or not the package is installed (absent or failed load ⇒ semantic disabled). The index self-heals on an embedding dim/model change (drops stale vectors, re-enqueues for re-embed) and is cleaned on delete.

## 0.7.18 — 2026-06-14

Engine self-defense against heavy-op load storms. A misbehaving background caller that hammers the expensive maintenance ops (`maad_reindex`, `maad_reload`, `maad_schema`, `maad_summary`) in a tight loop could pile up transient heap faster than GC reclaims it and OOM-crash-loop a memory-capped engine — the process died rather than shedding the excess. A new `HeavyOpGuard` at the MCP request boundary adds four independent, false-positive-cheap defenses, all returning the retryable `OVERLOADED` code rather than risking a crash:

- **Free-headroom admission gate** — refuses a heavy op when free heap, or free cgroup budget, whichever is tighter, drops below a floor (default 96 MiB). Keyed on *absolute* free bytes, not a heap ratio: per-op cost is roughly fixed regardless of dataset size, so a byte floor protects a small engine without false-tripping a legitimately large resident working set that needs its own headroom. Fails open if memory can't be sampled.
- **Single-flight coalescing** — folds identical concurrent heavy ops into one execution instead of re-running each.
- **Process-global concurrency cap** (default 4) — the pool runs one engine per project in a single process, so heavy ops on different projects allocate heap concurrently in the same process; a global semaphore bounds the executing count across all engines and sheds over the cap.
- **Circuit breaker** — after repeated memory sheds it opens for a cooldown (default 3 sheds → 5 s) and fast-fails all heavy ops without re-sampling, adding temporal hysteresis that breaks an OOM→hot-retry loop even when a caller ignores `retryAfterMs`; half-opens after the cooldown and closes on a healthy sample.

Refusals are retryable, so the guard is a backstop, never a correctness boundary. `maad_health.runtime` gains a `heavyOpGuard` block (free-heap floor, concurrency cap, breaker state, shed/coalesce/concurrency/breaker counters). New env: `MAAD_HEAVY_OP_GUARD_DISABLE`, `MAAD_HEAVY_OP_MIN_FREE_HEAP_MB`, `MAAD_HEAVY_OP_RETRY_AFTER_MS`, `MAAD_HEAVY_OP_MAX_CONCURRENT`, `MAAD_HEAVY_OP_BREAKER_THRESHOLD`, `MAAD_HEAVY_OP_BREAKER_COOLDOWN_MS`.

1017 tests passing (+24). New error code: `OVERLOADED`. No new dependencies, no schema changes. Behavior change: identical concurrent reindex/reload/schema/summary calls now coalesce to one run, and heavy ops shed (retryable) under low memory headroom, concurrency saturation, or an open breaker rather than risking an OOM.

## 0.7.17 — 2026-06-13

Query performance — covering indexes for filtered + sorted reads. A `findDocuments` call that filters on indexed schema fields and sorts on another indexed field compiled to a correlated subquery for the sort key plus `IN (SELECT …)` filter membership, and the planner drove the scan off the low-selectivity `deleted` index — forcing a full materialize-and-sort of the matched set with no `LIMIT` push-down. Cost grew superlinearly with corpus size.

Three new `field_index` covering indexes — `(field_name, field_value, doc_id)`, `(field_name, numeric_value, doc_id)`, and `(doc_id, field_name, field_value, numeric_value)` — let the planner satisfy filter membership and the scalar sort key directly from an index, and a new `documents(deleted, doc_type, doc_id)` composite stops it choosing the all-rows `deleted` index. A post-reindex `ANALYZE` (new `MaadBackend.analyze()`, called from `indexAll` only when rows were touched) keeps planner statistics current so the composites are actually chosen. All indexes apply automatically on next `init()` via `CREATE INDEX IF NOT EXISTS`; existing databases build them once on first boot after upgrade — adding index-maintenance cost to a full reindex in exchange for the read-path win.

Filtered queries that sort on a scalar schema field now take a sort-index-driven path: the engine walks the sort field's covering index in order and gates candidate rows with `EXISTS` filter probes, so a `LIMIT`ed query terminates early instead of materializing and sorting the whole matched set. Documents with no value for the sort field are gathered by a second query and ordered on the NULL side (last under `DESC`, first under `ASC`), preserving both the result set and the prior aggregate path's ordering. List-field sorts keep the aggregate MIN/MAX path; a new engine-set `sortListField` query flag routes the two.

`summary()`'s validation-error warning and `maad_validate` now read per-document validity persisted at index time instead of re-reading and re-validating every record file on each call. A new `documents.valid` column — set from the structural validation the indexer already runs — backs a single `COUNT`; existing databases gain the column via `ALTER` on first boot (defaulting to valid, self-correcting on next reindex). This also fixes a latent correctness bug: both `summary()` and whole-project `validate` previously fetched records via `findDocuments({ limit: 100000 })` and silently undercounted past 100k records — `summary()` now counts in SQL and whole-project `validate` pages through every record.

993 tests passing (+11 over 0.7.16 — sort-missing-field and validity-count coverage). One additive `documents.valid` column (auto-migrated; defaults to valid). No new dependencies, no new env vars. No breaking changes — query results and validation semantics are unchanged; reads and sorted queries get faster and validation counts are no longer capped.

## 0.7.16 — 2026-06-09

Dependency security wave. **simple-git 3.35.2 → 3.36.0** — closes a high-severity advisory (CVE-2026-6951: the `-c` option block could be bypassed with its `--config` long form, enabling `ext::` transport RCE where untrusted input reaches git options). The engine never passes user input as git options, so practical exposure was low, but this is the core dependency of the per-write commit path. 3.36.0 also default-blocks a denylist of env vars (EDITOR, PAGER, GIT_ASKPASS, GIT_SSH*, etc.) in custom child environments; new `buildGitEnv()` strips that denylist from the merged env — the engine's local plumbing commands must never open an editor, pager, or credential prompt, and several of those vars are present in every interactive shell and CI runner.

**js-yaml 4.1.1 → 4.2.0** — the 4.2.0 resolver stopped coercing some number-shaped scalars (bare sci-notation, underscore digits), which silently disabled the serializer's parse-back quoting guard for those forms. The guard now quotes numeric lookalikes via a static version-independent pattern, so string fields survive round-trip under any downstream YAML parser, not just the installed resolver. **better-sqlite3 12.8.0 → 12.10.0** (native rebuild verified on both CI platforms). Dev deps: @types/node 24.13.1, typescript 6.0.3, vitest 4.1.8. `npm audit fix` cleared all remaining transitive advisories — `npm audit` now reports zero vulnerabilities (was 2 high + 5 moderate). Lockfile root version resynced.

982 tests passing (unchanged). No engine API changes. Test-infrastructure hardening for CI runners (30s vitest timeouts, rmSync retry options) also landed in this window.

## 0.7.15 — 2026-06-09

Public-CLI housekeeping + CI. New `maad version` command (also `--version` / `-v`) — previously fell through to the help screen as an unknown command. A CI workflow now runs build, typecheck, and the full test suite on every push and pull request, on Node 24 across Ubuntu **and Windows** — the Windows leg guards the CRLF/path-separator class fixed in 0.7.14; until now tests only ran at release-tag time, so dependency PRs merged unverified. `.gitattributes` locks LF line endings repo-wide; `.nvmrc` pins Node 24.

Brand sweep: user-facing `MAAD` display strings become `MAADb` in the CLI help header, generated MAAD.md content, Architect skill text, and generated CLAUDE.md. The `MAAD.md` filename, `MAAD_*` env var prefix, error codes, and all code identifiers are unchanged — those are public contracts.

Packaging: the unused `MAAD.md` / `_skills/` entries are dropped from package.json `files` (both are generated per-project at runtime and never shipped; the entries only created a risk of publishing stale local artifacts from a dev checkout). The publish workflow gains a concurrency group and a packed-tarball sanity check; the same tarball check runs in CI. README refreshed: badges, current-state section, and a broken spec-doc link.

982 tests passing (unchanged). No engine behavior changes. No new dependencies.

## 0.7.14 — 2026-06-09

Correctness patch — six fixes from a full engine audit, each independently surfaced and test-covered.

- **CRLF/BOM write tolerance.** `extractBody`/`appendToBody` matched frontmatter delimiters with LF-only regexes. Updating a document whose file carried CRLF line endings (Windows editors, `core.autocrlf=true` checkouts) treated the entire file — frontmatter included — as body and wrapped new frontmatter around it: silent, committed corruption. The parser side was already CRLF-tolerant, which masked the writer-side gap. Delimiters now tolerate `\r\n` and a UTF-8 BOM; extracted bodies normalize to LF.
- **Git child environment.** simple-git's `.env()` *replaces* the child environment and persists on the shared instance — after the first auto-commit, every subsequent git spawn ran with only the four `GIT_AUTHOR_*`/`GIT_COMMITTER_*` vars (no `PATH`, no `HOME`, so no global git config or `safe.directory`). Worked by accident on most hosts. Identity is now merged over `process.env` at all three injection sites (autoCommit, initRepo, addAnnotatedTag).
- **Numeric sort.** `maad_query` sortBy on a `number`/`amount` field ordered on the TEXT `field_value` column — `"100" < "2" < "9"` — despite `numeric_value` existing for exactly this. Numeric fields now order on `field_index.numeric_value`. List-field sort keys are deterministic (smallest item ascending, largest descending) instead of an arbitrary row.
- **Filter expansion on join/verify.** `maad_join`, `maad_verify mode: 'count'`, and `maad_verify mode: 'integrity'` scope filters passed raw filters to the backend, which throws on documented composite shapes — a `between` filter on `maad_join` crashed instead of filtering. All three now expand filters identically to `maad_query`.
- **Pagination guards.** `limit`/`offset` now validate as integers (`limit >= 1`, `offset >= 0`) at the MCP boundary, with a backend sanitization backstop. SQLite treats `LIMIT -1` as *unlimited*, so a negative limit previously returned the entire table straight past the 500-row cap.
- **Pathspec-scoped commits.** Per-write auto-commits now stage-check and commit only the operation's own files. Unrelated staged content in a project repo (operator activity, leftovers from a prior failed commit) can no longer be swept into a `maad:<action>` commit under the wrong audit-trail message — and no longer trips the staged-change detection.

982 tests passing (+27 over 0.7.13). No new dependencies, no new env vars, no schema changes. Behavior changes: invalid `limit`/`offset` values now reject at the tool boundary instead of passing through; numeric-field sorts return corrected order; join/verify composite filters that previously errored now work.

## 0.7.13 — 2026-06-08

Per-document index-time memory guards. A single document can allocate many times its byte size in V8 heap while indexing — each body annotation becomes a parsed annotation, an extracted object, and often a relationship, all live at once with the SQLite bind params (measured ~15–20× the file's bytes). Unbounded, one pathological document (e.g. a paste carrying hundreds of thousands of `[[…]]` annotations) can exhaust the heap and FATAL the whole engine process, taking every project on that engine down and crash-looping on restart as reindex re-touches the same document.

Two layered guards, both designed to keep the document **findable** rather than silently dropping it:

- **Annotation cap** (`MAAD_MAX_DOC_ANNOTATIONS`, default 50,000; `0` disables). Body annotation extraction stops at the cap, bounding the object/relationship set. The document record and frontmatter index are still written in full, so the doc stays queryable by id and by frontmatter field — only its body objects are partial. Counted in the new `IndexResult.partial` and logged as a degraded `engine.doc_body_truncated` event.
- **Byte backstop** (`MAAD_MAX_DOC_BYTES`, default 16 MiB; `0` disables). A file too large to even read and line-split safely is skipped entirely with the new `DOC_TOO_LARGE` finding (in the reindex result's `errors[]`), logged as `engine.doc_too_large`. 16 MiB is far past any legitimate single record.

For scale: a normal record is single-digit KB; the default byte cap is ~28 average novels of text in one file. The annotation cap is the primary guard (annotation count, not bytes, is the allocation driver); the byte cap is the read-safety backstop.

955 tests passing (+3 over 0.7.12). New error code: `DOC_TOO_LARGE`. New env vars: `MAAD_MAX_DOC_ANNOTATIONS`, `MAAD_MAX_DOC_BYTES`. New `IndexResult.partial` field. No new dependencies. No breaking changes for documents under the caps.

## 0.7.12 — 2026-05-22

`maad_query` sort contract. `sortBy` now accepts system sort keys (`updated_at`, `indexed_at`, `doc_id`, `doc_type`, `created_at` plus camelCase aliases) on the `documents.*` columns, or any indexed schema field of the requested `docType`. Unknown or unindexed keys reject up front with new `UNSUPPORTED_SORT_FIELD` error instead of silently degrading to all-NULL ordering. Every sorted query (including the default `indexed_at DESC`) emits a deterministic `doc_id` tie-breaker in the requested direction.

Engine-stamped `createdAt`. New `documents.created_at` column populated on create, preserved across updates. Pre-0.7.12 databases pick up the column via idempotent `ALTER TABLE` on first boot; existing rows backfill `created_at = updated_at` as the best-available approximation. `GetResult.createdAt` is part of the read surface.

File-path canonicalization. `documents.file_path` is stored in forward-slash form regardless of host platform. New `toCanonicalRelPath()` helper in `src/engine/helpers.ts` routes through `indexFile`, `createDocument`, and `softDelete`. `getDocumentByPath` gains a separator-tolerant fallback so legacy backslash rows from pre-0.7.12 Windows writes are still resolvable; they migrate on next reindex (lazy migration). The "two forms of relPath" workaround in `verifyIntegrity` is gone.

952 tests passing (+20 over 0.7.11). New error code: `UNSUPPORTED_SORT_FIELD`. No new dependencies. Behavior change: callers that previously relied on unknown-sort-key silent degradation now receive an error.

## 0.7.11 — 2026-05-22

`maad_search` rejects unknown `primitive` values up front with the new `INVALID_PRIMITIVE` error. Before, invalid primitive strings passed through to `WHERE primitive = ?` and returned a clean `total: 0` indistinguishable from a legitimate no-match. New `isValidPrimitive()` type-guard in `src/types.ts` gates the MCP tool boundary (`src/mcp/tools/read.ts`) and the CLI command (`src/cli/commands/read.ts`); engine signature unchanged. Tool description rewritten to enumerate all 11 primitives and note that frontmatter string fields index as `primitive=entity, subtype=<field-name>`. 932 tests passing.

## 0.7.10 — 2026-05-20

**Integrity & Cleanup.** Consolidated release closing the eight-step `0.7.10` line locked in spec `docs/archive/0.7.10-integrity-cleanup.md`. Eight tool additions, two new error codes, two new health-observability surfaces, one latent autoCommit bugfix, one info-disclosure surface closed in pino logs. Granular delivery history in the rc.1 through rc.8 entries below.

**Confirm contract (foundation, rc.1).** Every destructive tool added in this release defaults to dry-run; `confirm: true` is required to mutate. `requireConfirm()` helper + `CONFIRM_REQUIRED` error code; audit-log payload carries `confirm_mode: 'dry_run' | 'confirmed'`. Pattern reusable for any future destructive tool.

**Integrity sweep + orphan-finder (rc.1).** `maad_verify mode: 'integrity'` walks markdown on disk, compares to the SQLite index, surfaces five drift categories: `missing_in_index` / `missing_on_disk` / `hash_drift` / `schema_drift` / `broken_refs`. `maad_find_orphans` is a thin wrapper over the broken_refs sub-mode — one implementation, two surfaces. broken_refs detection is index-driven (joins `relationships` to `documents`) and never re-parses frontmatter from disk — collapses the per-call working-set floor on busy projects (rc.4 measurement: 7.7× cycle-2/cycle-1 working-set growth eliminated). Filter / docType / docId scope filters cap the sweep; `verbose: true` returns per-record `details[]`. Performance budget under 5s for a 10k-record project.

**Snapshot backups (rc.1).** `maad_backup` admin tool creates annotated git tags on HEAD with structured names (`maad-snapshot-YYYY-MM-DD-HHMM[-<label>]` UTC). Three modes in one tool: `create` / `list` (with optional `since` filter) / `delete`. Underlying commits are never touched — deleting a snapshot just drops the ref. New error codes `TAG_EXISTS`, `TAG_NOT_FOUND`, `NO_HEAD_COMMIT`.

**V8 + cgroup memory-pressure watcher (rc.1, rc.5).** Periodic sampler emits a degraded-severity `engine.memory_pressure` ops event when V8 heap ratio OR cgroup memory ratio crosses a configurable threshold. Edge-triggered with cooldown — fires once on threshold crossing, suppresses while sustained, re-fires after cooldown. `maad_health.runtime.memoryPressure` block surfaces sampler state including heap (`heapUsedMb`/`heapCapMb`/`heapRatio`) and process (`rssMb`/`externalMb`/`arrayBuffersMb`) + cgroup v1/v2 (`cgroupCurrentMb`/`cgroupMaxMb`/`cgroupRatio`) telemetry. rc.5 added the cgroup half to close the observability gap for kernel-level OOM kills where V8 stays below its own heap cap but off-heap/native/RSS exhausts the container. New env vars `MAAD_MEMORY_PRESSURE_INTERVAL_MS` (default 60000), `MAAD_MEMORY_PRESSURE_RATIO` (default 0.8), `MAAD_MEMORY_PRESSURE_COOLDOWN_MS` (default 300000).

**Pino write-body redaction (rc.6).** `src/mcp/guardrails.ts:auditToolCall` now projects `args.body` / `args.appendBody` into byte counts (`bodyBytes`, `appendBodyBytes`) and collapses `fields` to `fieldNames` (keys only) before the log line is emitted. Bulk shapes (`records[]`, `updates[]`) collapse to counts plus aggregate byte totals. `src/logging.ts` REDACT_PATHS adds `args.body`, `args.appendBody`, `args.records[*].body`, `args.updates[*].body`, `args.updates[*].appendBody` as belt-and-braces at the pino transport boundary. Closes the info-disclosure surface where write tool_call events logged full document bodies into Docker stdout/json logs. Logging contract — pino is telemetry, not a content archive — documented in both files.

**Destructive cleanup primitives (rc.7).** Four admin-tier tools governed by the confirm contract, single-commit atomic per call.
- `maad_bulk_delete` — explicit docId list, soft (default) or hard mode. Per-record failures collect into `result.failed` without aborting the batch.
- `maad_delete_where` — filter-driven, composes `findDocuments` + `bulkDelete`. Probe-with-limit overflow detection (`limit: maxRecords+1`) catches oversize scopes without paginating the full match set.
- `maad_purge_soft_deleted` — hard-delete the cemetery older than a retention threshold (default 30 days; `MAAD_PURGE_DEFAULT_RETENTION_DAYS` env). `result.scanned` reports the unclipped count so operators can see when the cemetery exceeds `maxRecords` and chunk.
- `maad_repair_where` (rc.8) — tolerant repair via strategy registry (`prune_orphan_refs` drops broken ref-field targets; `fix_schema_drift` bumps schemaRef + adds defaulted optional fields + drops removed fields, never coerces). Type-coercion cases surface as `REPAIR_REQUIRES_MIGRATION` for a future migration tool.

Per-tool `maxRecords` cap default 100, hard ceiling 1000, with `MAAD_CLEANUP_MAX_RECORDS_<TOOL>` env override (tool-arg primary, env secondary, default tertiary). All four tools support `idempotencyKey` for retry deduplication.

**autoCommit fix (rc.7).** Latent bug: `simple-git`'s `StatusSummary.staged` array misses renames — git's rename detection collapses soft-delete's `cli-x.md → _deleted_cli-x.md` pair to a single `R` index entry that never appears in `staged[]`. Pre-rc.7, autoCommit returned noop for any soft-delete commit while reporting `writeDurable: true` (because `noop !== failed`). Engine acked durable while the soft-delete sat uncommitted in the working tree. Fix inspects the `files[]` index column as a fallback after the existing `staged.length > 0` fast path. Affects single-record `maad_delete` soft mode too. Verified end-to-end against rc.6 binaries before patching.

**Integrity + backup observability on maad_health (this release).** `maad_health` surface gains three optional fields backed by `engine_meta`:
- `lastIntegritySweepAt: ISO8601 | null` — timestamp of the most recent `maad_verify mode: 'integrity'` call (any scope).
- `lastIntegrityFindings: { missing_in_index, missing_on_disk, hash_drift, schema_drift, broken_refs } | null` — counts from that sweep.
- `lastBackupTag: { tag, sha, createdAt } | null` — most recent `maad_backup mode: 'create'`.

Write hooks: `verifyIntegrity` stamps the two integrity keys post-sweep; `createBackup` stamps `last_backup_tag` post-tag. Both defensive — a backend write failure here cannot poison the read result. Operators read `lastIntegrityFindings.broken_refs > 0` or `lastBackupTag` age without re-running the underlying tool. Stored values that fail JSON parse drop to null rather than surfacing corrupt.

**Tier table.** Admin tier now 38 tools (was 34 in 0.7.9): `maad_backup` + `maad_bulk_delete` + `maad_delete_where` + `maad_purge_soft_deleted` + `maad_repair_where`. Reader tier gains `maad_find_orphans`. WRITE_TOOLS in `src/mcp/kinds.ts` now 12.

927 tests passing (+110 over 0.7.9 baseline of 817). 6 skipped (existing Windows-only skips). New error codes: `CONFIRM_REQUIRED`, `TAG_EXISTS`, `TAG_NOT_FOUND`, `NO_HEAD_COMMIT`, `REPAIR_REQUIRES_MIGRATION`. New env vars: `MAAD_MEMORY_PRESSURE_INTERVAL_MS`, `MAAD_MEMORY_PRESSURE_RATIO`, `MAAD_MEMORY_PRESSURE_COOLDOWN_MS`, `MAAD_PURGE_DEFAULT_RETENTION_DAYS`, `MAAD_CLEANUP_MAX_RECORDS_BULK_DELETE`, `MAAD_CLEANUP_MAX_RECORDS_DELETE_WHERE`, `MAAD_CLEANUP_MAX_RECORDS_PURGE_SOFT_DELETED`, `MAAD_CLEANUP_MAX_RECORDS_REPAIR_WHERE`. No new dependencies. No breaking changes — every addition is opt-in or additive.

Spec rotated from `docs/specs/` to `docs/archive/` per the convention.

## 0.7.10-rc.8 — 2026-05-20

`maad_repair_where` — tolerant-only repair via strategy registry.

Lands the second-to-last deferred 0.7.10 spec item (step 8 of the implementation sequencing). Admin/write tool that runs a tolerant-only repair pass over records matching a `(docType, filter)` scope. Each match runs through the requested strategies in order; per-record per-strategy outcomes accumulate independently; per-record successes write once with a single trailing commit for the batch.

**Strategy registry.** New `src/engine/repairs.ts` holds an internal `REPAIR_STRATEGIES` map with two strategies shipped in v1, plus the `repairWhere` orchestrator. The pattern leaves the extension point clean for future tolerant repairs (`normalize_whitespace`, `resort_yaml_keys`, etc.) without changing the tool surface.

**`prune_orphan_refs`** — for each ref-typed field in the record's frontmatter, if the target docId is unresolved (missing OR soft-deleted — aligned with `verifyIntegrity`'s `broken_refs` semantics, since soft-deleted records are not visible to ref-resolving callers), drop the broken ref. Single-valued ref → set to `null`; `list of ref` → filter out missing targets. Pure compute; the orchestrator owns the disk write.

**`fix_schema_drift`** — bump the record's `schema` frontmatter value to the registry's current schemaRef for its docType. Tolerant migration: drops fields no longer declared, adds missing optional fields with their schema `defaultValue`, NEVER coerces types. Required-field gaps and any type change that would need coercion surface as **`REPAIR_REQUIRES_MIGRATION`** (new error code added to `ErrorCode` union) for a future migration tool to handle. `amount` accepts both number and string (legitimate hybrid type throughout the engine); every other declared type is strict.

**Orchestrator.** `repairWhere(ctx, filter, docType, repairTypes, maxRecords)` queries matches with `findDocuments`, chains strategies per record, writes via `atomicWrite` + `indexFile` per successful record, emits one trailing `gitCommit` for the batch. Per-record per-strategy failures collect without aborting other records. Mirrors the `bulkUpdate` pattern.

**MCP tool.** New `maad_repair_where` registration in `src/mcp/tools/cleanup.ts`. Admin tier, write kind, confirm-contract governed (dry-run preview by default; `confirm: true` mutates), idempotency replay via `idempotencyKey`, maxRecords cap default 100 / ceiling 1000 with `MAAD_CLEANUP_MAX_RECORDS_REPAIR_WHERE` env override. Probe-with-limit pattern (`limit: maxRecords + 1`) detects overflow without scanning the full matching set; oversize matches return `BULK_LIMIT_EXCEEDED` with chunking hint. Dry-run preview reports the matched docId list and the strategies that would be applied.

**Tier registration.** `maad_repair_where` added to `ADMIN_TOOLS` (now 38) in `roles.ts` and `WRITE_TOOLS` (now 12) in `kinds.ts`.

921 tests passing (+10 over rc.7 baseline of 911 — 10 new `engine.repairWhere` cases covering both strategies, scoped filters, combined-strategy chaining, single-commit batching, per-record failure isolation, empty-match no-op). No new dependencies. New error code `REPAIR_REQUIRES_MIGRATION`. No breaking change.

Remaining for final 0.7.10: `maad_health` additions (`lastIntegritySweepAt`, `lastIntegrityFindings`, `lastBackupTag` backed by `engine_meta`) and docs/spec rotation. Spec at `docs/specs/0.7.10-integrity-cleanup.md` §Implementation sequencing step 9–10.

## 0.7.10-rc.7 — 2026-05-20

Destructive cleanup primitives + soft-delete autoCommit fix.

Lands the three deferred destructive tools from the 0.7.10 Integrity & Cleanup spec, all governed by the confirm-contract foundation that shipped in rc.1.

**`maad_bulk_delete`** (admin, write) — Delete an explicit list of records in a single commit. `mode: 'soft'` (default, rename to `_deleted_*`) or `'hard'` (unlink file + remove index row via CASCADE). Per-record failures collect into `result.failed` without aborting the batch. `confirm: true` required to mutate; absent/false returns dry-run preview with the resolved affected set. `maxRecords` defaults to 100 (ceiling 1000); env override `MAAD_CLEANUP_MAX_RECORDS_BULK_DELETE`. Idempotency replay via `idempotencyKey`.

**`maad_delete_where`** (admin, write) — Filter-driven bulk delete. Same filter shape as `maad_query`. Composes the underlying engine surfaces: `findDocuments({docType, filters})` → `bulkDelete(matched, mode)`. Probes with `limit: maxRecords + 1` to detect overflow without scanning the full matching set; oversize matches return `BULK_LIMIT_EXCEEDED` with chunking hint. Dry-run preview returns the would-affect docId list. Same maxRecords + confirm + idempotency surface as `bulk_delete`. Env override `MAAD_CLEANUP_MAX_RECORDS_DELETE_WHERE`.

**`maad_purge_soft_deleted`** (admin, write) — Hard-delete the cemetery older than a retention threshold. Removes `_deleted_*` files from disk, removes documents rows (cascade clears objects/relationships/blocks/field_index in the same statement), single trailing commit. `olderThan` defaults to now minus 30 days (`MAAD_PURGE_DEFAULT_RETENTION_DAYS` env override). Result reports `scanned` (total matching the threshold) vs `purged.length` (clipped to `maxRecords`) so operators can see when the cemetery exceeds the cap and chunk accordingly. Env override `MAAD_CLEANUP_MAX_RECORDS_PURGE_SOFT_DELETED`.

**Cleanup-cap helper.** New `resolveCleanupMaxRecords(toolSuffix, argValue, env)` + `checkCleanupSize(tool, count, max)` in `src/mcp/bulk-cap.ts`. Tool-call arg primary, env secondary, default tertiary. Hard ceiling 1000 regardless of source.

**Latent bug fix: soft-delete autoCommit returned noop.** `src/git/commit.ts:autoCommit` checked `status.staged.length === 0` to detect "nothing to commit", but `simple-git`'s `StatusSummary.staged` array misses renames — when git's rename detection kicks in (soft-delete writes a `cli-x.md → _deleted_cli-x.md` pair, which `git status --porcelain=v2` collapses to an `R` index entry), the `staged` array stays empty and the commit silently noop'd. Behavior was masked because `commitOutcome.status !== 'failed'` still satisfied `writeDurable: true` — the engine acked durable while the soft-delete sat uncommitted in the working tree. Fix inspects `files[]` index column as a fallback (anything other than `' '` or `'?'`), keeping the existing `staged.length > 0` fast path. Single-record `maad_delete` soft mode now commits correctly too. Bulk-delete soft mode would have inherited the same silent-noop without this fix.

**Tier registration.** `maad_bulk_delete` / `maad_delete_where` / `maad_purge_soft_deleted` added to `ADMIN_TOOLS` in `roles.ts` and `WRITE_TOOLS` in `kinds.ts` (write-kind under the per-engine mutex). Admin tier now 37 tools (was 34).

**New module.** `src/mcp/tools/cleanup.ts` holds the three tool registrations; pattern matches `tools/backup.ts` (admin + write + dispatch).

911 tests passing (+26 over rc.6 baseline of 885 — 7 engine.bulkDelete tests, 5 engine.purgeSoftDeleted tests, 3 delete-where composition tests, 11 cleanup-cap helper tests). No new dependencies. No new error codes (reuses `CONFIRM_REQUIRED` from rc.1 and `BULK_LIMIT_EXCEEDED` from 0.7.3). No breaking change.

Remaining for final 0.7.10: `maad_repair_where` (repair-strategy registry — `prune_orphan_refs` + `fix_schema_drift`) and `maad_health` additions (`lastIntegritySweepAt`, `lastIntegrityFindings`, `lastBackupTag` backed by `engine_meta`). Spec at `docs/specs/0.7.10-integrity-cleanup.md` §Implementation sequencing steps 8–9.

## 0.7.10-rc.6 — 2026-05-19

Redact document bodies from pino `tool_call` logs.

Engine `tool_call` ops events previously carried full `args.body` / `args.appendBody` strings for `maad_create` / `maad_update` calls via `auditToolCall` → `engine/logger.ts` → pino. Two problems: (1) duplicates user document content into Docker stdout/json logs, an info-disclosure surface separate from MAADB storage + git history; (2) plausible pino transport / object-retention contributor to load-proportional native-memory growth — engine logged 7–8 KB+ per document write on top of the durable write itself.

Two-layer fix. `src/mcp/guardrails.ts:auditToolCall` now projects body fields into byte counts (`bodyBytes`, `appendBodyBytes`) and collapses `fields` to `fieldNames` (keys only — values stay out of pino); bulk shapes (`records[]`, `updates[]`) collapse to counts plus aggregate body-byte totals. Other scalars (docId, docType, project, expectedVersion, idempotencyKey, confirm) pass through verbatim. `src/logging.ts` REDACT_PATHS gains `args.body`, `args.appendBody`, `args.records[*].body`, `args.updates[*].body`, `args.updates[*].appendBody` as defense-in-depth so any future caller that bypasses the projection helper is still redacted at the pino transport boundary. The logging contract — pino is telemetry, not a content archive — is documented in both files.

885 tests passing (+12 over rc.5 baseline of 873 — 7 new auditToolCall projection tests + 5 new pino-redact-paths tests). No new dependencies. No new env vars. No surface change beyond the redacted log shape. No breaking change for log consumers that filtered on tool/docId/docType (those fields are preserved).

## 0.7.10-rc.5 — 2026-05-18

Runtime memory-pressure observability now covers the kernel/cgroup OOM class, not only V8 heap pressure. `src/mcp/memory-pressure.ts` samples `process.memoryUsage()` RSS, external, and arrayBuffer bytes alongside V8 heap usage, reads cgroup v2/v1 memory current/max when available, and fires the existing `engine.memory_pressure` ops event when either V8 heap ratio or cgroup memory ratio crosses the configured threshold. `maad_health.runtime.memoryPressure` now includes `heapRatio`, `rssMb`, `externalMb`, `arrayBuffersMb`, `cgroupCurrentMb`, `cgroupMaxMb`, `cgroupRatio`, `heapInPressure`, and `cgroupInPressure` while keeping `ratio` as the heap-ratio compatibility alias.

This specifically closes the observability gap for exit-137 kernel OOM kills where V8 stays below its own heap cap but off-heap/native/RSS memory exhausts the container cgroup. It is still observability, not the storage/query memory fix.

## 0.7.10-rc.4 — 2026-05-18
Index-driven broken_refs check — collapses the per-call working-set floor.

Multi-cycle heap-snapshot diagnostic on a busy deployment of rc.3 found that `verifyIntegrity` (and by extension `maad_find_orphans`) was re-parsing every doc's frontmatter from disk to surface broken refs, materializing ~7 property arrays per doc and retaining ~80 MB of working set on a 2200-doc project. Trajectory across three integrity-walk cycles was not a JIT-amortization curve — cycle 2 ballooned to 7.7× cycle 1, signaling per-call materialization survival across function boundaries.

The relationships table already carries every ref discovered at index time, and the `documents` table is the authoritative source for "does the target exist." A new `BackendAdapter.getBrokenRefs()` collapses the entire broken_refs sweep to one SQL roundtrip (joining `relationships` to `documents` to filter to refs whose target is missing or soft-deleted) and `verifyIntegrity` no longer touches disk for this category. Per-call frontmatter parses drop from N (one per doc) to zero. Drift between disk and the index — the only case the old approach would catch that the new one wouldn't — is exactly what the `hash_drift` and `missing_in_index` categories already cover; `broken_refs` is not the right surface for that detection.

Semantically equivalent under a healthy index; existing 17 verify-integrity + find-orphans tests pass without modification. 873 tests passing in total. No new dependencies. No public surface change. The new method is a backend-adapter contract addition.

Operators on deployed rc.3 can either upgrade to rc.4 and watch the working-set floor drop on the next integrity sweep, or stay on rc.3 — the memory-pressure watcher already in place will fire if real production load approaches the heap cap.

## 0.7.10-rc.3 — 2026-05-17
Republish of rc.2 — test fixture identity for direct simple-git calls.

rc.2 publish was blocked by two remaining backup-test failures on the CI runner. Two tests in `tests/mcp/backup.test.ts` simulate a "user-created" tag by calling `simpleGit(TEMP_ROOT).addAnnotatedTag(...)` directly without going through `GitLayer` — the engine fix in rc.2 didn't touch that path. The test's `beforeEach` was already chaining `.env()` for the init commit but not setting repo-local `user.email` / `user.name`, so any direct simple-git operation later in a test body had no identity to anchor on. Added `setupGit.addConfig('user.email', ...)` + `addConfig('user.name', ...)` to the fixture init so repo-local config persists for all subsequent operations.

Test-only change. 873 tests passing under simulated-CI git config. No engine or surface change. No new dependencies.

Scope otherwise identical to rc.1 below.

## 0.7.10-rc.2 — 2026-05-17
Republish of rc.1 — fixes a CI test-suite failure in the new `maad_backup` tool.

rc.1 publish was blocked because `GitLayer.addAnnotatedTag` (new in 0.7.10 P4) didn't inject the `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` env per call, so the test suite failed on the GitHub Actions runner with `fatal: unable to auto-detect email address`. Same per-call identity-injection pattern that `autoCommit` and `initRepo` adopted in 0.7.3 (fup-2026-095) now extends to the annotated-tag operation: `resolveCommitAuthor()` is read on each call and chained through simple-git's `.env()` before `addAnnotatedTag`. The bug was masked on any dev machine with a global `git config user.email` set; the GitHub-hosted runner has none, so the failure surfaced there first.

No new tests — the 15 existing backup tests in `tests/mcp/backup.test.ts` now pass on bare CI runners and continue to pass locally. 873 tests passing in total. No new dependencies. No breaking changes. No surface change beyond the bug fix.

Scope otherwise identical to rc.1 below.

## 0.7.10-rc.1 — 2026-05-17
Integrity audit + snapshot backups + V8 memory-pressure observability.

Release candidate for the 0.7.10 line. Ships the read-side audit tooling, snapshot backups, and a pre-OOM observability surface — the destructive cleanup primitives (`maad_bulk_delete`, `maad_delete_where`, `maad_repair_where`, `maad_purge_soft_deleted`) and the corresponding `maad_health.lastIntegritySweepAt` / `lastIntegrityFindings` / `lastBackupTag` additions from the original Integrity & Cleanup scope defer to a follow-on rc / final 0.7.10. Published to npm dist-tag `next`; stable users continue to receive 0.7.9 on `latest`.

**Confirm-contract foundation (P1).** Cross-cutting safety contract that every destructive tool in the 0.7.10 line will adopt. New `CONFIRM_REQUIRED` error code in `src/errors.ts`. New `requireConfirm()` helper alongside the existing `isDryRun()` pattern. Audit-log payload gains `confirm_mode: 'dry_run' | 'confirmed'` so post-hoc analysis distinguishes exploration from action. No destructive tools yet wired to the contract — those land in the follow-on rc.

**Integrity sweep (P2) — `maad_verify mode: 'integrity'`.** Read-only walker that compares markdown on disk to the SQLite index across five drift categories: `missing_in_index` (file present on disk, no index row), `missing_on_disk` (index row, no file), `hash_drift` (file changed externally — sha256 mismatch), `schema_drift` (record's `schemaRef` behind the currently-loaded schema-pack), `broken_refs` (frontmatter ref field points to a non-existent docId). Reuses the existing `collectMarkdownFiles` walker, `fileHash` sha256 algorithm, and `getDocumentByPath` lookup — no new index column, no new walker, no second source of truth. Scope filters (`docType`, `docId`, `filter`, `categories`) constrain the sweep; `verbose: true` returns per-record `details[]` with the exact mismatch values. Performance budget < 5s for a 10k-record project.

**Find-orphans wrapper (P3) — `maad_find_orphans`.** Thin convenience wrapper over `maad_verify({ mode: 'integrity', categories: ['broken_refs'], verbose: true })`. Two surfaces, one implementation. Tests verify parity with the underlying integrity-mode call.

**Snapshot backups (P4) — `maad_backup`.** Admin-tier tool that creates annotated git tags on the project repo HEAD. Three modes: `create` (default — generates `maad-snapshot-YYYY-MM-DD-HHMM[-<label>]` UTC tag name, label sanitized to `[a-z0-9-]+` capped at 32 chars), `list` (returns existing snapshot tags with `{ tag, sha, message, createdAt }`), and `delete` (removes a single snapshot tag). Backed by new `GitLayer` methods (`addTag` / `listTagsByPrefix` / `deleteTag` / `headSha` / `currentBranch`) and a new `src/engine/backup.ts`. Three new error codes: `TAG_EXISTS`, `TAG_NOT_FOUND`, `NO_HEAD_COMMIT`. No destructive defense-in-depth required — tag creation/deletion just manipulates refs, no working-tree mutation.

**V8 memory-pressure watcher (P5).** Periodic V8 heap-pressure sampler in `src/mcp/memory-pressure.ts` emits a degraded-severity `engine.memory_pressure` ops event when `process.memoryUsage()` heap_used vs `v8.getHeapStatistics()` heap_size_limit crosses a configurable threshold (default 0.8). State surfaces on the new `maad_health.runtime.memoryPressure` block (`{ enabled, intervalMs, thresholdRatio, lastSampleAt, heapUsedMb, heapCapMb, ratio, inPressure, lastPressureAt, pressureFiresTotal }`). Edge-triggered with cooldown — fires once when the ratio first crosses threshold, suppresses while pressure is sustained until the cooldown window elapses, then re-fires with `edge: false`. First sample below threshold re-arms the edge trigger. Under cgroup-capped deployments on Node 24, V8 trips its auto-calibrated heap cap (~253 MB old-space on a 512 MiB cgroup) without an engine-side warning surface before SIGABRT; the watcher gives operators a pre-OOM signal that's visible before the crash. New env vars `MAAD_MEMORY_PRESSURE_INTERVAL_MS` (default 60000, set 0 to disable), `MAAD_MEMORY_PRESSURE_RATIO` (default 0.8, clamped to [0,1]), `MAAD_MEMORY_PRESSURE_COOLDOWN_MS` (default 300000). Sampler is injectable for testing.

**Bug fixes.** Parser now tolerates CRLF line endings in heading detection (Windows checkouts via `core.autocrlf=true` no longer break block-pointer math). SIGHUP instance-reload handler no longer crashes when `ctx.tokens` is undefined on synthetic instances. `verifyIntegrity` Windows path-separator mismatch corrected — `documents.file_path` stores native-separator paths (backslash on Windows) and the reader now queries with the matching form rather than the forward-slash-normalized form, fixing a Windows-only bug where every record miscounted as `missing_in_index`.

**Test infrastructure.** `tests/engine/pipeline.test.ts` now copies `simple-crm` to a temp root in `beforeAll` instead of writing into the shared fixture's `_backend` during `indexAll`. Eliminates the parallel-race class with sibling tests that `cpSync` the same fixture — the shared `simple-crm/_backend` is now truly read-only across the suite.

**Publish workflow.** `.github/workflows/publish.yml` now auto-detects pre-release versions (any with a hyphen, e.g. `0.7.10-rc.1`) and routes to npm dist-tag `next` instead of `latest`, so pre-release publishes don't shadow the stable release on `npm install @maadb/core`.

869 tests passing (+52 over 0.7.9 baseline of 817 — 14 new memory-pressure, plus integrity / find-orphans / backup / confirm-contract tests landed across P1–P4, plus a pre-existing parser fix landed). New error codes: `CONFIRM_REQUIRED`, `TAG_EXISTS`, `TAG_NOT_FOUND`, `NO_HEAD_COMMIT`. New env vars: `MAAD_MEMORY_PRESSURE_INTERVAL_MS`, `MAAD_MEMORY_PRESSURE_RATIO`, `MAAD_MEMORY_PRESSURE_COOLDOWN_MS`. No new dependencies. No breaking changes — every addition is opt-in or additive.

Deferred to follow-on rc / final 0.7.10 release: `maad_bulk_delete`, `maad_delete_where`, `maad_repair_where`, `maad_purge_soft_deleted` (steps 5–8 in the original spec) and the three `maad_health` fields backed by `engine_meta` (step 9).

## 0.7.9 — 2026-05-05
First npm publish via Trusted Publishers (OIDC).

Package transitions from `@maadb/core` name reservation (0.0.1, published as a placeholder during scope setup) to first real release at 0.7.9. Auth path is npm Trusted Publishers — short-lived OIDC tokens minted by GitHub Actions, no long-lived `NODE_AUTH_TOKEN` in repo secrets. The publish workflow (`.github/workflows/publish.yml`) triggers on `v*` tag push, gates on a `npm-publish` GitHub Environment with required-reviewer protection (admin bypass disabled), verifies `package.json` version matches the tag, and publishes with `--provenance` so each release ships verifiable build attestations.

README refreshed: dynamic npm version badge added, version badge bumped, Current state line updated, 0.7.8 rotated into Recent shipped scope. No engine code changes — 817 tests passing, identical to 0.7.8.

§Planned cascade renumbered after 0.7.9 was used for the first npm publish: Cleanup Wave 1 → 0.7.10, Agent-First Engine → 0.7.11.

## 0.7.8 — 2026-05-02
Repository hygiene + dependency tightening + Node 24 baseline.

Cleanup pass with no engine code changes. Caret specifiers tightened to exact pins on runtime infrastructure (`@modelcontextprotocol/sdk`, `better-sqlite3`, `pino`, `simple-git`) and tilde on utility libraries and dev dependencies — currently-installed versions preserved, no forced downgrades, future minor releases now deliberate rather than implicit on `npm install`.

`engines.node` raised from `>=22` to `>=24` (current Active LTS as of October 2025); `@types/node` aligned to 24.x to match. No Node 24-only APIs added — existing code runs unchanged on Node 22 with an `engine-strict` warning on install. The bump signals the maintained baseline, not a runtime requirement.

`.github/dependabot.yml` added: weekly schedule, grouped `@types/*` and dev dependencies, major bumps held for manual review. Combined with the policy of not merging fresh releases within ~7 days unless security-tagged, the repo now has a defended supply-chain posture.

Documentation cleanup: `ROADMAP.md` deleted (Version.md §Planned has been canonical since 0.7.0; the file had drifted into pre-0.7 slot numbers contradicting actual ship history). `RELEASE-CHECKLIST.md` removed from the public repo. `FRAMEWORK.md` relocated to `docs/framework.md` to keep the repo root tight. `LICENSE` copyright corrected. `README.md` refreshed to the current version, current shipped scope, and Node 24 baseline. Shipped 0.7.0 and 0.7.1 specs rotated from `docs/specs/` to `docs/archive/`.

817 tests passing — same as 0.7.7. No new dependencies. No breaking changes.

## 0.7.7 — 2026-05-01
Schema-cache coherence across concurrent writers (fup-2026-202).

Pre-0.7.7, when two engine processes shared the same backend (same project directory, same SQLite database), each held its own in-memory schema cache. If process A edited a schema file on disk and called `maad_reload`, process A's in-memory schemas reflected the edit. Process B's in-memory schemas did not. When process B then ran `maad_update` on a doc, `processDocument` rewrote that doc's `field_index` entries using B's stale view of the schema — silently clobbering correct entries that A's prior `indexAll` had populated. No error, no log line. The visible symptom was a query missing records that obviously matched the filter on disk.

The exact bug was reproduced live on 2026-05-01: a separate concurrent agent session edited a record after this session reloaded a schema; SQLite inspection confirmed the affected record had every other field indexed but zero rows for the newly-indexed list field. Recovery required a manual `maad_reindex --force` from a process with fresh schema.

Fix: `SchemaStore` now captures mtime + size per file at load time (in a `cachedFiles: Map<absolutePath, {mtimeMs, size}>`) covering each `_schema/*.yaml` plus `_registry/object_types.yaml`. New method `SchemaStore.isStale(): boolean` re-stats each cached file synchronously and returns true if any mtime or size has drifted, or if a cached file no longer exists. The engine's `runExclusive` entry — the chokepoint every write op flows through — calls `isStale()` before invoking the handler. On drift, the engine runs a lightweight in-place reload (re-reads registry + schemas, swaps refs) without touching the backend or git layer, and emits a `schema_cache_stale` ops event with the trigger op name and the list of changed files. The next write proceeds with fresh schemas.

Cost on the no-drift path: one `fstat` per cached schema file (~microseconds). Schema edits are rare; the staleness check is cheap; the reload only fires when files actually changed. The `reload` op itself skips the staleness check (it's about to re-init everything regardless), preventing redundant work.

Failure handling: if registry or schema reload fails mid-write (e.g., a schema file was edited into invalid YAML), the engine logs a best-effort warning and proceeds with the existing in-memory schemas rather than blocking the write — a rare edge case where doing nothing is the lesser harm.

Tests: 6 new in `tests/engine/schema-cache-coherence.test.ts` cover the staleness probe (no-drift, content edit, mtime-only edit via `utimes`) plus end-to-end create + update flows that mutate a schema mid-session and verify the indexed-field-filter query returns the doc (the canary for silent corruption). 817 tests passing (+6 over 0.7.6 baseline).

No new dependencies. No breaking changes. New ops event: `schema_cache_stale`. No new error codes. Internal-only API addition: `SchemaStore.cachedFiles` and `SchemaStore.isStale()` — direct callers can now ask whether their cache is fresh, but most won't need to.

## 0.7.6 — 2026-05-01
Parser / write-path security hardening (fup-2026-200).

Pre-0.7.6, custom doc IDs flowed from the MCP boundary directly into `path.join(dirPath, "${id}.md")` with no validation. A hostile docId of `../../etc/maliciousfile` resolved outside the project root before any pathguard fired — `assertContainedIn` was wired into the registry loader and `maad_scan` but never the write path. Real exploit, no exotic conditions required.

New `src/engine/docid-safe.ts` exports `checkDocIdSafe(id) → DocIdRejection | null` enforcing a narrow profile: `[a-zA-Z0-9._-]+` within [1, 128] characters, no leading `.`, no `..` substring, no Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM0-9`, `LPT0-9`), no control characters. The validator runs at every write-path boundary — `createDocument` and per-record in `bulkCreate` — and rejects with `INVALID_DOC_ID` plus a structured `reason` code. Auto-generated doc IDs from `generateDocId` are path-safe by construction so the validator never trips on them.

Defense-in-depth: `pathguard.isContainedIn(fp, projectRoot)` now fires immediately before every `atomicWrite`, returning `PATH_OUTSIDE_PROJECT` if the resolved path escapes the project root. Even if a future code path bypasses `checkDocIdSafe`, the write physically cannot land outside the project.

Tests cover the full hostile-input matrix: 49 docId profile cases (path traversal via `../`, `/`, `\`, absolute paths; control chars including NUL/newline/tab/CR; Windows reserved names; unicode/emoji/shell metachars; over-length; empty; trailing/leading dot/dash) plus end-to-end probes through `createDocument`, `bulkCreate`, and `reindex`. Bulk batches with mixed safe/hostile records reject hostile per-record without aborting the batch and leave no on-disk artifacts. A reindex over a hand-placed file with broken YAML surfaces in `errors[]` without crashing or corrupting the index. HTML/script content in body and quoted/backslash content in frontmatter strings round-trip verbatim — engine does not render or transform.

Acceptance from the followup met: (1) engine rejects unsafe doc IDs/paths consistently with structured errors, (2) malformed records return structured errors without leaving on-disk artifacts or corrupting the index, (3) request-level size limits already enforced via MCP rate-limit (1 MiB body cap), (4) extraction/indexing failures contained — single bad record does not abort the indexAll run, (5) test fixtures cover create / bulk / reindex flows.

811 tests passing (+72 over 0.7.5 baseline). New error code: none — reuses existing `INVALID_DOC_ID` and `PATH_OUTSIDE_PROJECT`. No new dependencies. No breaking changes — auto-generated doc IDs are unchanged, only newly-supplied custom IDs land in the validator.

Granular per-field body/frontmatter size caps are follow-on if a concrete need surfaces; the existing 1 MiB request cap bounds the worst case today.

## 0.7.5 — 2026-05-01
Unix domain socket transport (fup-2026-148).

New `MAAD_TRANSPORT=unix` (or `--transport unix`) binds the same MCP/HTTP server to a Unix domain socket instead of TCP. Same SDK transport, same auth path, same session/SSE plumbing — only the socket binding differs. Intended for trusted-host colocated deployments (Patchnet Projects MVP Phase C, brain-app multi-tenant) where the engine must never open a TCP port and access is gated at the filesystem layer. Bearer auth via `_auth/tokens.yaml` is still required as defense in depth.

`startHttpTransport` gains optional `socketPath` and `socketMode` (default `0o660`) options. When `socketPath` is set, the server unlinks any stale socket file from a prior crashed run before bind, calls `httpServer.listen(socketPath)`, and chmods the socket to the configured mode. On `close()` the socket file is unlinked best-effort. `host` / `port` / `trustProxy` are accepted but ignored when `socketPath` is set — the caller routes via `transport='unix'` from the server boot path.

CLI gains `--unix-socket <path>` and `--unix-socket-mode <octal>` (default `660`). Env: `MAAD_UNIX_SOCKET`, `MAAD_UNIX_SOCKET_MODE`. Boot validation rejects `--transport unix` without a socket path or with synthetic instance mode (single-project legacy paths remain stdio-only).

`maad_health.transport.kind` gains `'unix'` plus a `socketPath` field so operators can confirm the bind without grepping logs. Telemetry's `TransportKind` union now `stdio | http | unix`. `idle_sweep`, `session_open`, `session_close` events are unchanged — the transport-agnostic SessionRegistry already handles them.

Tests: `tests/mcp/http-unix-socket.test.ts` covers bind / stale-socket cleanup / `/healthz` / `/mcp initialize` / shutdown unlink. Skipped on Windows because Node's `AF_UNIX` requires admin/elevated permissions on `%TEMP%` paths (deployment target is Linux). 739 tests passing (+0 over 0.7.4 baseline; 5 new UDS tests skipped on this host, run on Linux CI/deploy).

No breaking changes — all additions are additive. Existing HTTP and stdio deployments are unaffected.

## 0.7.4 — 2026-05-01
Reindex auto-detects schema-index changes (fup-2026-093).

Pre-0.7.4, `maad_reindex` decided whether to reindex a document by comparing the file's content hash to the stored hash. After a schema edit that flipped a field to `index: true` (or added a new indexed field), existing markdown was unchanged on disk, so reindex reported `{scanned: N, indexed: 0, skipped: N, errors: []}` and the new index stayed empty. Looked like a successful no-op. The only workaround was to touch every affected doc with a real field write — undocumented and easy to miss.

Fix: the engine now tracks a per-type fingerprint of the indexed-field set (sorted `name:type` pairs hashed) in a new `engine_meta` SQLite table. Each `indexAll` run computes the current fingerprint per type, compares against the stored value, and force-rebuilds docs of any type whose fingerprint changed — regardless of file-hash skip. Fingerprints persist after successful rebuild, so a crash mid-reindex leaves the prior fingerprint in place and the next run retries cleanly.

`IndexResult` gains an optional `rebuiltTypes: string[]` field so operators can see which types triggered a forced rebuild. Empty/absent when nothing changed; populated when schema edits or `--force` was in play. The `--force` flag remains as the explicit escape hatch but is rarely needed since 0.7.4 — the engine handles the common schema-edit case automatically.

Backend gains `getMeta(key)` / `setMeta(key, value)` for the namespaced engine-meta surface (currently only `schema_index_fp:<doc_type>`; future expansion possible). New `engine_meta(key, value)` SQLite table created idempotently via `IF NOT EXISTS` so existing databases pick it up on first 0.7.4 boot. No migration required.

739 tests passing (+5 over 0.7.3 baseline of 734). Closes the workaround used for fup-2026-201 (brain `followup.tags` index flip) — the next schema-index change in any project should just work without a `--force` reindex.

## 0.7.3 — 2026-05-01
Engine hardening + agent-first composites. Five followups bundled.

**fup-2026-199 — YAML coercion-roundtrip guard.** New `wouldCoerceFromString` guard in `writer/serializer.ts` parses every candidate string scalar back through the `js-yaml` `CORE_SCHEMA` loader and forces quotes if it doesn't roundtrip as a string. Closes the implicit-tag class the static keyword/digit-prefix checks missed: all-digit (`4962218` → !!int), scientific-notation lookalike (`1e38892` → !!float Infinity), leading-zero (`007` → 7), keyword-shaped (`true`/`null`). Pairs with the 0.6.7 Phase-2 datetime-preservation fix to complete string-fidelity end-to-end. New `tests/engine/string-preservation.test.ts` (T18-T21, 6 cases) plus +6 in `tests/writer/serializer.test.ts`.

**fup-2026-190[1] — Bulk-tool 50-item cap.** New `src/mcp/bulk-cap.ts` extracted as a pure-function guard so per-tool wiring stays a one-line check. `maad_bulk_create` and `maad_bulk_update` reject requests over the cap with new `BULK_LIMIT_EXCEEDED` error code carrying `{tool, received, limit, suggestedChunkSize}` and a chunking hint in the message. Default 50, configurable via `MAAD_BULK_MAX_ITEMS`, hard-clamped to [1, 1000] so a misconfigured operator can't disable the floor. Independent of per-session write-rate limits — those throttle frequency, this caps per-request blast radius and bounds memory cost of bulk-result payloads. 9 new tests.

**fup-2026-095 — autoCommit identity env per-invocation.** `resolveCommitAuthor` exported from `src/git/commit.ts`. `autoCommit` and `initRepo` chain `git.env('GIT_AUTHOR_NAME'/'EMAIL'/'GIT_COMMITTER_NAME'/'EMAIL', ...)` before every spawned git process — these env vars take precedence over `git config` and don't require touching repo state. Defaults `maadb-engine` / `engine@maadb.local`; override via `MAAD_COMMIT_AUTHOR_NAME` / `MAAD_COMMIT_AUTHOR_EMAIL`. Removes the host-config fragility that left brain-app's working tree stuck with 21 staged-uncommitted files when the system user had no `user.name`/`user.email` configured. 4 new tests.

**fup-2026-096 — opsLog readiness self-check.** New `logOpsChannelReady` ops event called from `mcp/server.ts` immediately after `initLogging`. Deploy validation can grep `ops_channel_ready` to confirm the channel is wired before any tool call — if this line is missing in `journalctl`, no other ops event (`commit_failed`, `rate_limited`, `validation_warning`) will surface either. +1 logging test.

**fup-2026-079[a] — `maad_query depth: cold | full`.** New `src/mcp/query-depth.ts` with `hydrateQueryRows` helper. Handler accepts `depth: 'hot' | 'cold' | 'full'` (default `hot` = pre-0.7.3 behavior) plus `depthMaxResults` (default 50, hard cap 100). `cold` attaches `body` per row; `full` attaches resolved composite (refs + objects + related). Per-row failures stamp `_hydrationError` and don't abort the batch — partial results surface to the caller. `_meta.depth` carries `{depth, hydrated, capped?}`. Collapses the query-then-N-gets agent pattern that was the most-cited Tier-3 friction signal. 7 new tests.

**fup-2026-150 — EnginePool idle-timeout eviction (Stage 1).** Pulled forward from 0.9.0 to bound multi-tenant memory growth. `EnginePool` gains `lastTouchedAt` per loaded engine, `acquire`/`release` refcount, background `evictIdle` sweep, `startIdleSweeper` / `stopIdleSweeper` lifecycle, `EvictionStats` snapshot, static `readIdleSweepEnv`. `MAAD_PROJECT_IDLE_TIMEOUT_MS` default 1800000 (30 min), `0` disables; `MAAD_PROJECT_SWEEP_INTERVAL_MS` default 60000 (60 s). `withSession` acquires/releases the refcount around handler execution so the sweeper never evicts a project with in-flight ops; sweep timer is `unref()`'d so process exit stays clean. Sweeper started from `mcp/server.ts`. Stage 2 (LRU + hard cap) gated on Stage 1 evidence. 10 new tests.

734 tests passing (+44 over 0.7.2 baseline of 690), tsc clean. New error code: `BULK_LIMIT_EXCEEDED`. New env vars: `MAAD_BULK_MAX_ITEMS`, `MAAD_COMMIT_AUTHOR_NAME`, `MAAD_COMMIT_AUTHOR_EMAIL`, `MAAD_PROJECT_IDLE_TIMEOUT_MS`, `MAAD_PROJECT_SWEEP_INTERVAL_MS`. No new dependencies. No breaking changes — all additions are additive (depth/depthMaxResults default to existing behavior; bulk cap is a defense floor; idle timeout is opt-out via env=0).

## 0.7.2 — 2026-04-24
Atomic writes on the parser path.

Body `---` thematic breaks no longer rejected as multi-document YAML — the misapplied `checkMultiDocument` scan that flagged any `---` after the frontmatter fence is removed. gray-matter already scopes frontmatter to the first `---`/`---` pair; everything after is body content. Writes now pre-flight the composed markdown through the parser before `atomicWrite`, so invalid frontmatter fails cleanly with no orphan file on disk. Post-write index failures carry `docId` + `filePath` in error details so callers can clean up if one ever slips through. New export `parseDocumentFromContent(raw, path, subtypeMap)` drives the pre-flight without a disk roundtrip. 690 tests passing (+1 over 0.7.1 baseline). Closes fup-2026-091; R3 Phase B cursor continuation shifts to 0.7.3.

## 0.7.1 — 2026-04-22
Agent-first aggregate capabilities.

Multi-hop ref traversal in `maad_aggregate.groupBy` (`a->b->c` syntax, arbitrary depth; broken refs bin under `__unresolved__` so data-quality issues stay visible). Range / composite filters on `maad_query` and `maad_aggregate` — `between` shortcut + array-of-ops with AND semantics, desugared to atomic conditions at engine layer so the backend only sees the simple forms. Hard caps on `limit` (500 on query, 2000 on aggregate) with silent clamp + `_meta.limit_clamped` signal; server-side projected-size guard (64KB default, `MAAD_RESPONSE_MAX_BYTES` override) returns `RESPONSE_TOO_LARGE` with hint — closes the silent-harness-truncation bug from jrn-2026-093. MAAD.md + CLAUDE.md generators gain trigger rules pushing agents toward `aggregate` / `join` over manual record iteration.

**Scope guard (enters ROADMAP verbatim):** MAADB is an agent-friendly document store with ergonomic aggregates — not an OLAP engine. If reports regularly drive schema decisions or routinely scan >50K records, the right break is a separate reporting module that consumes MAADB dumps, not bolting analytics features onto MAADB itself.

R3 cursor continuation deferred to 0.7.2 per fup-2026-092 (jrn-2026-093 full diagnostic, jrn-2026-094 scope lock). Spec at `docs/specs/0.7.1-agent-first-aggregate.md`. Six new error codes: `RESPONSE_TOO_LARGE`, `CURSOR_INVALID`, `SCHEMA_REF_CHAIN_INVALID`, `FILTER_BETWEEN_INVALID`, `FILTER_EMPTY_ARRAY`, `FILTER_OP_INVALID`. 689 tests passing (+49 over 0.7.0 baseline), no new dependencies.

## 0.7.0 — 2026-04-21
Scoped Auth & Identity + Response Hygiene.

Per-agent tokens at `_auth/tokens.yaml` (`maad_pat_<32hex>` plaintext, SHA-256 persisted, returned once at issue). Three-cap role composition on every request — min of project ceiling, token cap, and requested role. Records immutable except `revokedAt`; capability changes require revoke + reissue. CLI and admin MCP tools for issue/revoke/rotate/list/show. SIGHUP hot-reloads tokens.yaml alongside instance.yaml.

**BREAKING:** Legacy shared-secret `MAAD_AUTH_TOKEN` mode removed; tokens.yaml is now required for HTTP. Migration recipe in `docs/specs/0.7.0-scoped-auth.md`.

Also: identity-enriched audit events and git commits (`MAAD_COMMIT_IDENTITY` default on). Response hygiene pass — slim `maad_summary` (subtype inventory → `maad_describe`), null-field omission in `maad_schema`, opt-in `filePath` and `_meta.request_id`, trimmed verbose tool descriptions. 640 tests. No new dependencies.

## 0.6.12 — 2026-04-21
Aggregate Subscription Visibility. New admin-only `maad_subscriptions` tool returns `{totalSubscriptions, subscriptions[], byProject, byDocType}` across every session in the instance. Pairs with a cheap `subscribed` counter on `maad_health.sessions`. Admin-on-every-bound-project gate.

## 0.6.11 — 2026-04-21
Live Notifications. New reader tools `maad_subscribe({docTypes?, project?})` and `maad_unsubscribe()`. Durable writes fan out `notifications/resources/updated` to matching subscribers with `uri: maad://records/<docId>` plus extra params. Filter AND-semantics: docTypes omitted = all types; project omitted = session's visible scope. One subscription per session. Durability-gated by the 0.6.10 signal — subscribers never see non-durable or no-op events.

## 0.6.10 — 2026-04-21
Commit Durability Signal. `autoCommit` returns a three-state `CommitOutcome` (`committed` | `noop` | `failed`) replacing the silent `null` return that masked commit failures. Every write result carries `writeDurable: boolean` + optional `commitFailure`. MCP responses stamp `_meta.write_durable` on successful writes; failures surface with forensic detail. `maad_health` gains `commitFailuresTotal` and related counters, plus a `commit_failed` ops event. Existing clients that ignore `_meta` see zero behavioral change.

## 0.6.9 — 2026-04-21
Instance Hot-Reload. New admin MCP tool `maad_instance_reload` plus POSIX SIGHUP handler re-parse `instance.yaml` and apply the diff without restart. Added projects register lazily; removed projects evict their engine and cancel bound sessions. Path or role mutations on existing projects reject with `INSTANCE_MUTATION_UNSUPPORTED`. `maad_health` gains an `instance` block with reload counters. SIGHUP unavailable on Windows; use the MCP tool.

## 0.6.8 — 2026-04-17
Gateway Session Pinning. HTTP transport honors a new `X-Maad-Pin-Project: <name>` request header at MCP `initialize`: the session is bound to the named project synchronously before any tool call reaches a handler, and any subsequent `maad_use_project` / `maad_use_projects` attempt rejects with a new `SESSION_PINNED` MCP error. Unblocks trusted-gateway multi-tenant deployments (hosted MAADB behind a per-user gateway) by moving tenant-boundary enforcement from the gateway's MCP-message parser to the engine's session-creation path — gateway sets one header, engine enforces the boundary for the life of the session. Feature is fail-safe: absent header = identical behavior to 0.6.7; stdio is untouched (header plumbing is HTTP-only); synthetic (legacy `--project`) instances log `pin_ignored_legacy` once per process and proceed as if the header weren't there.

Shipped in seven phases. P1 (session model) — `BindingSource = 'client_tool' | 'gateway_pin'` type, `SessionState.bindingSource` field, optional `source` param on `bindSingle`/`bindMulti` defaulting to `client_tool`. P2 (rebind rejection) — guard at the top of both bind methods emits `SESSION_PINNED` before the existing `SESSION_ALREADY_BOUND` branch when `bindingSource === 'gateway_pin'`; placed at the session layer so existing `maad_use_project` / `maad_use_projects` tool handlers inherit the behavior with zero handler-level changes. Error message is actionable: `"session is pinned to project 'X' by gateway; open a new session with a different X-Maad-Pin-Project header to switch projects"`. P3 (HTTP transport) — new `src/mcp/transport/pin.ts` pure validator returning `{status: 'absent' | 'valid' | 'rejected'}` with PIN_PROJECT_INVALID / PIN_PROJECT_NOT_FOUND / PIN_ON_EXISTING_SESSION paths; `startHttpTransport` gains required `instance: InstanceConfig` opt; validator runs between auth and session-id resolution; on valid, the project name threads through the `onsessioninitialized` closure and calls `bindSingle(sid, name, { source: 'gateway_pin' })` immediately after `sessions.create(sid)`. Synthetic instances skip validation with a one-time info log. P4 (observability) — `SessionsBlock.pinned` counter in `maad_health`, computed via `ctx.sessions.snapshot().filter(s => s.bindingSource === 'gateway_pin').length`; `SessionOpenFields.binding_source` optional field plumbs into the audit log; `maad_current_session` tool response gains `binding_source` field; new `logPinRejected` emits `pin_rejected` ops events with `{remote_addr, code, project}`. P5 (acceptance tests) — new `tests/mcp/http-pin-project.test.ts` walks all 13 acceptance criteria from the fup spec end-to-end. P6 / P7 docs + release.

Four new error codes: `PIN_PROJECT_INVALID`, `PIN_PROJECT_NOT_FOUND`, `PIN_ON_EXISTING_SESSION`, `SESSION_PINNED`. 21 new tests (4 session + 4 telemetry + 13 acceptance), 575 total passing (baseline 554 at 0.6.7, +21). tsc --noEmit clean. No new dependencies.

Load-bearing security invariant for operators: **the gateway MUST strip any client-supplied `X-Maad-Pin-Project` header before setting its own**. Forwarding client-set headers defeats the pin and lets any authenticated client pick their own tenant — classic trusted-header-spoofing pitfall (same family as forwarded `X-Forwarded-For` without `MAAD_TRUST_PROXY=false`). Engine MUST bind to 127.0.0.1 or a private network; if the engine is directly reachable from clients, the header has no security value. Deploy guides updated (systemd + docker) with gateway strip-then-set patterns.

## 0.6.7 — 2026-04-16
Schema Precision Hints. Date fields gain three optional schema keys: `store_precision` (engine-enforced minimum on write, year/month/day/hour/minute/second/millisecond), `on_coarser` (warn by default, error opt-in — the non-breaking rollout mechanism), and `display_precision` (consumer-side rendering hint, engine never enforces). Absent keys = pre-0.6.7 lenient behavior; fully backward compatible. Enforcement fires only at write-time — reads, reindex, and `maad_validate` (without `includePrecision`) never judge historical data. Updates skip precision on unchanged fields via `changedFields` set so schemas can tighten precision without breaking records written earlier.

Shipped on branch `feat/0.6.7-schema-precision` across five phases. P1 (commit 793d4fa) — precision detection primitives (`src/schema/precision.ts`): literal-string precision detection (`2026-04-16T00:00:00Z` classified as `second`, not day-padded-to-midnight), `comparePrecision`, `isCoarserThan`, `isPrecision` type guard, timezone suffix stripped before classification. P2 (commit 4962218) — round-trip datetime preservation fix. Codex review (jrn-2026-025) surfaced that gray-matter's default js-yaml engine was coercing `!!timestamp` scalars into JS Date objects, and five downstream sites (writer/serializer:66-67, extractor/fields:49-50, engine/indexing:164-176, engine/reads:368-369, engine/writes:551-557) were normalizing Dates via `.toISOString().slice(0, 10)` — silently truncating finer-than-day precision on every round-trip. Fix consolidates all 11 `matter()` callers through a single `parseMatter()` helper in `src/parser/matter.ts` that injects a string-preserving YAML engine (js-yaml `CORE_SCHEMA` without `!!timestamp`), changes the five slice sites to emit full ISO with millisecond precision, quoted so external parsers using `DEFAULT_SCHEMA` can't re-coerce either. `js-yaml@^4.1.0` promoted from transitive (via gray-matter) to direct dependency; `@types/js-yaml` added as dev. Without this fix, precision enforcement would have produced false positives on MAADB's own update round-trips. P3 (commit f4cd65f) — reusable validation warning channel. `ValidationResult.warnings: ValidationWarning[]` with new `ValidationWarning` type (`field`, `message`, `code`, `location`). `code` is an open string so future soft-validations (deprecated fields, length hints, cross-field invariants) can introduce new codes without a type change. `BulkResult` gains per-record `succeeded[].warnings` plus top-level aggregated `warnings[]` with `{docId}.` field prefix. New `attachWarnings()` helper in `src/mcp/response.ts` — no-op on empty, merges into `_meta.warnings[]` via existing `attachMeta`. Four write tool handlers (`maad_create`, `maad_update`, `maad_bulk_create`, `maad_bulk_update`) wired. P4 (commit 988be25) — DSL + write-mode-gated enforcement. `src/schema/loader.ts` parses three new optional YAML keys on date fields; schema-load rule rejects `display_precision` finer than `store_precision` with `SCHEMA_INVALID`. Validator gains `ValidationOptions {mode, changedFields?}` with default `mode: 'read'` as the safety default. Precision gate fires only on `mode === 'write'` with declared `storePrecision`, respects `changedFields` on update path, skips when structural validation already failed. Five call sites pass explicit mode: writes.ts create/update/bulk → `write`, indexing.ts → `index`, reads.ts → `read`, maintenance.ts → `audit`. `maad_schema` passthrough of the three keys in field descriptors. `maad_validate` gains `includePrecision: true` producing informational `precisionDrift[]` array without mutating `valid`/`invalid` counts. New `logValidationWarning()` emits one `warn`-level ops log line per warning with structured fields (request_id, session_id, project, tool, doc_id, doc_type, field, code, message) — wired at all four write tool handlers. P5 — docs. `_skills/schema-guide.md` gains a Date precision section with event-timestamp + birthday examples, the rules, and the update-neighbor-safe backward-compat semantics. README Current State + Roadmap table refreshed.

78 new tests, 554 total passing (baseline 476 at 0.5.0, +78 across precision primitives 23, string-preserving YAML 7, datetime round-trip 5, warnings channel 7, validator enforcement 16, loader DSL 8, engine integration 10, + two bumped existing tests). tsc --noEmit clean. New deps: `js-yaml@^4.1.0` (prod, was transitive), `@types/js-yaml` (dev). Ship gate for the hosted brain: precision contract had to land before end-user data existed because coarse writes are permanent data loss — no migration can recover precision that was never captured. Spec at `docs/specs/0.6.7-schema-precision.md`. Design lock in brain as decision `dec-maadb-067-schema-precision`.

## 0.5.0 — 2026-04-15
Remote MCP transport. Engine served over HTTP/SSE via `StreamableHTTPServerTransport` (MCP SDK 1.29+) — one process, many concurrent client sessions, bearer-token auth at handshake, concurrent reads while writes hold the mutex, polling delta, extended health surface. stdio remains the default for local use.

Delivered in eight phases (R0–R7) on `master`. R0 catalogued the SDK HTTP server conventions (header casing, session ID delegation, who owns which response header, timeout ownership at the raw `node:http` layer) and folded drift items into the spec. R1 wired the transport scaffold — `node:http` with explicit `headersTimeout` / `requestTimeout` / `keepAliveTimeout`, response hardening (`nosniff` + `no-store` injected above SDK's `no-cache`), per-session 128-bit CSPRNG session IDs supplied via `sessionIdGenerator` callback, 1 MiB body-size pre-check, per-session McpServer factory. R2 added bearer auth — constant-time `crypto.timingSafeEqual` compare, length-mismatch dummy compare to normalize timing, 401 UNAUTHORIZED precedes 404 SESSION_NOT_FOUND so unauthenticated callers can't enumerate session IDs, `AUTH_TOKEN_REQUIRED` boot fail on HTTP mode without token, pino redaction on `authorization` verified end-to-end. R3 added the session lifecycle fan-out — `SessionRegistry.registerCloseHandler`, idempotent `destroy(sid, reason)`, `peek` without bumping `lastActivityAt`, idle sweeper with inbound-only activity clock (outbound SSE pushes don't count, so zombie streams evict at `MAAD_SESSION_IDLE_MS`, default 30 min), closes the 0.4.1 polish item for rate-limit dispose on disconnect. Pino fix: log destination pinned to stderr (fd 2) because H6 had defaulted to stdout, which corrupts the stdio JSON-RPC channel. R4 promoted the read/write distinction to a first-class contract: `OperationKind` declared per tool in `src/mcp/kinds.ts`, `withEngine` wraps writes in `runExclusive` while reads bypass the mutex entirely, `runExclusive` now reentrant via AsyncLocalStorage keyed on engine instance (so `withEngine` → `engine.createDocument` re-entry no longer deadlocks), module-load disjointness assertions + coverage test force every tool to declare a kind. R5 shipped `maad_changes_since` — opaque base64url cursor, strict tuple ordering on `(updated_at ASC, doc_id ASC)` with `>` comparison so ties never duplicate or skip, operation classification by document version (`1 → create`, `>1 → update`), limit clamp at 1000, hasMore via n+1 fetch, delete events deferred until the engine tombstones (0.7.0+). R6 extended `maad_health` with transport posture (`kind`, `host?`, `port?`, `uptimeSeconds`) and session telemetry (`active`, `openedTotal`, `closedTotal`, `lastOpenedAt`, `lastClosedAt`, `idleSweepLastRunAt`); added unauthenticated `GET /healthz` liveness (200 `{ok:true}` live / 503 `SHUTTING_DOWN` draining, no state leak, routed before auth so orchestrators don't need the bearer token); wired structured `session_open` / `session_close` audit events and `idle_sweep` ops events. R7 shipped deployment guides (systemd + nginx, Docker + traefik), README/ROADMAP updates, and this release.

82 new tests across transport / auth / lifecycle / kinds / concurrent-reads / changes-since / healthz / health-telemetry modules, 476 total passing. New dependency: none (pino added in 0.4.1). New CLI flags: `--transport`, `--http-host`, `--http-port`, `--auth-token`, `--session-idle-ms`, `--http-max-body`, `--trust-proxy`, `--http-headers-timeout`, `--http-request-timeout`, `--http-keepalive-timeout`, all with matching `MAAD_*` env vars. New error codes: `AUTH_TOKEN_REQUIRED` (boot), `UNAUTHORIZED` (401), `SESSION_NOT_FOUND` (404), `MISSING_OPERATION_KIND` (tool registration bug), `PAYLOAD_TOO_LARGE` (413). Spec at `docs/specs/0.5.0-remote-mcp.md`.

## 0.4.1 — 2026-04-15
Production hardening pass on the write path and operational surface. Per-engine FIFO write mutex serializes all mutating ops (`AsyncFifoMutex`, wrapped via `runExclusive`). Stale `.git/index.lock` recovery on init (30s mtime threshold). Idempotency keys on writes — optional client-supplied, per-(project, tool, key) scope, 10-min TTL LRU cache, replay identified via `_meta.replayed` + `_meta.original_request_id`. Per-session token-bucket rate limiting: 10 writes/sec, 60 writes/min, 5 concurrent in-flight, 1 MiB payload cap. Structured JSON logging via pino with separate ops + audit channels, one `tool_call` line per request, one `write` audit line per successful mutation. Per-request timeout (30s default) via `Promise.race`. Graceful shutdown state machine: running → draining → exiting; SIGTERM drain waits for mutex + in-flight to settle, bounded by `MAAD_SHUTDOWN_TIMEOUT_MS` (10s default), second signal accelerates, exit code 0 on clean drain / 1 on timeout. Extended `maad_health`: write queue depth, last write op, last write timestamp, repo size on disk (cached 60s), git clean flag, disk headroom. New error codes: `WRITE_TIMEOUT` (reserved for 0.8.5), `SHUTTING_DOWN`, `RATE_LIMITED`, `REQUEST_TIMEOUT`. `pino` added as production dependency. Canonical request flow order: session → role → project → shutdown → payload → idempotency → concurrent → write-rate → mutex → engine. 71 new tests (mutex, concurrency, idempotency, rate-limit, logging, lifecycle, health-extensions), 394 total passing.

## 0.4.0 — 2026-04-14
Multi-project routing: one MCP server, many MAAD projects via `instance.yaml`. Sessions bind to a project (single mode) or whitelist (multi mode) with per-project roles and optional session-level downgrade (`as: reader`). Backward-compatible: `--project --role` still works as a synthetic single-project instance with auto-bind. New: `EnginePool` with eviction seam (policy deferred to 0.9.0), `SessionRegistry` keyed by MCP-SDK session IDs (HTTP/SSE-ready), 4 instance-level tools (`maad_projects`, `maad_use_project`, `maad_use_projects`, `maad_current_session`), `withSession` routing helper. Tool schemas gained an optional `project` field (additive). README and ROADMAP updated. Spec at `docs/specs/0.4.0-multi-project-routing.md`. 57 new tests, 323 total passing.

## 0.2.13 — 2026-04-10
**Breaking:** MCP tool names renamed from `maad.<tool>` to `maad_<tool>` for Anthropic/OpenAI tool-name regex conformance (`^[a-zA-Z0-9_-]{1,64}$`). The dot-separated form was rejected by Claude Desktop and any downstream LLM provider that validates tool definitions. All 22 tools and 5 planned tools (ROADMAP) flipped to underscore: `maad_summary`, `maad_get`, `maad_bulk_create`, etc. Pre-1.0 breaking change. Agent prompts and external automations pinned to the old dotted names need updating.

**Fix:** Empty-project boot. Engine `init()` self-heals `_registry/object_types.yaml`, `_schema/`, and `_backend/` on empty directories (read-only mode still returns READ_ONLY errors). Pre-check crash in `mcp/lifecycle.ts` removed — agents can now connect to empty dirs and enter Architect mode. New `src/skills-scaffold.ts` with `ensureProjectSkills()` helper: single source of truth for generating `_skills/*.md` from TS templates, never overwrites existing files, called from lifecycle after init, from `maad init` CLI, and ready for 0.4.0 `EnginePool`. `maad_summary` and `maad_health` now return structured `emptyProject: boolean`, `bootstrapHint: "_skills/architect-core.md" | null`, `readOnly: boolean`. Committed `_skills/*.md` files removed from the repo — TS templates in `src/architect.ts` and `src/skill-files.ts` are canonical. 10 new bootstrap tests (276 total).

## 0.2.12 — 2026-04-09
maad_verify fact-checking tool (field + count modes), grounding rules in MAAD.md generator, MIT LICENSE file, .gitignore hardened, author email updated, README + FRAMEWORK synced and tightened. 13 reader / 18 writer / 22 admin tools. 266 tests passing.

## 0.2.11 — 2026-04-09
Dynamic server version from package.json, MAAD_PROJECT/MAAD_ROLE/MAAD_PROV env var fallbacks for container deployments, OpenClaw MCP registration docs in README. 266 tests passing.

## 0.2.10 — 2026-04-09
Read-back verification on bulk_create and bulk_update. Deterministic sampling (all ≤20, evenly spaced 10 for larger). Canonical value comparison (dates, arrays, booleans). Verifies frontmatter, body content, and field_index integrity. Returns sampledIds for auditability. 266 tests passing.

## 0.2.9 — 2026-04-09
Summary warnings (brokenRefs, validationErrors), business-friendly validation messages with field expectations, bulk_update batched into single git commit. 266 tests passing.

## 0.2.8 — 2026-04-09
Version tracking on reads, query sort, updated_at, list field index fix. Reads now return version and updatedAt for optimistic locking. Reindex no longer bumps version when content unchanged. List fields denormalized to one row per item in field_index (fixes broken filters). maad_query supports sortBy/sortOrder. Engine-managed updated_at timestamp on documents table with auto-migration. 266 tests passing.

## 0.2.7 — 2026-04-08
Critical: frontmatter guard prevents updates from wiping required fields — aborts before write if any required field would be removed. Write safety: parseFields() at MCP layer handles string-serialized fields, engine rejects non-object fields. Audit fix: date-only --since now inclusive of the specified day (appends T00:00:00). 266 tests passing.

## 0.2.6 — 2026-04-08
Filter shorthand: ref fields (and any field) can be filtered with plain string values instead of requiring `{ op: 'eq', value: '...' }`. Aggregate totalMetric: grand total of the metric across all groups returned automatically. 264 tests passing.

## 0.2.5 — 2026-04-08
Read path + write path improvements from LLM evaluation feedback. Query projection (return frontmatter fields in results), maad_aggregate (count/sum/avg/min/max grouped by field), maad_join (cross-ref with projected fields from both sides), search `query` alias for `contains` (fixes silent param drop), schema output includes idPrefix and format hints, range query documentation. Bulk operations: maad_bulk_create and maad_bulk_update (per-record results, single git commit). Provenance flag: `--prov off|on|detail` on serve — `_source` metadata in tool responses, provenance instructions in summary. 21 admin tools, 17 writer, 12 reader. 260 tests passing.

## 0.2.4 — 2026-04-07
MCP server stability: auto-create missing type directories, maad_reload (re-init engine mid-session), maad_health (engine status). CLAUDE.md generated on init with MCP-first agent instructions. MAAD.md updated with MCP-first language. Skill files: _skills/schema-guide.md and _skills/import-guide.md generated on init. 17 admin tools, 13 writer, 10 reader. 236 tests passing.

## 0.2.3 — 2026-04-07
Production hardening Phase C: batch doc lookups (getDocumentsByIds eliminates N+1 in listRelated and getDocumentFull), real pagination (countDocuments/countObjects — total means total matches not page size), DRY query builders in SQLite backend. 236 tests passing.

## 0.2.2 — 2026-04-07
Production hardening Phase B: 25 MCP boundary tests (role gating, response contracts, path containment, guardrails, health/read-only). Service separation — extracted config.ts, lifecycle.ts from server.ts. 236 tests passing.

## 0.2.1 — 2026-04-07
Production hardening Phase A: durable write pipeline (atomic writes, operation journal, startup reconciliation), canonicalized path containment checks, structured error policy with severity logging (no more silent catches), health reporting + read-only mode, AI guardrails (dry-run, tool allowlists, audit logging), release checklist. MAAD-TOOLS.md archived. 211 tests passing.

## 0.2.0 — 2026-04-07
MCP server: 15 tools via stdio transport with role-based access (reader/writer/admin, default reader). Standard response contract { ok, data|errors }. Scan path safety (project-root only). Shutdown hooks. README trimmed — moved architecture detail to FRAMEWORK.md. Archived pre-build design docs to Project-Archive/. 4 production dependencies. 211 tests passing.

## 0.1.5 — 2026-04-07
FRAMEWORK.md: data doctrine, three-tier command model (primitive / deterministic composite / agent workflow), engine design principles. New scan command for LLM-native onboarding (file-level structural analysis + corpus-level pattern summary). Removed inspect from engine (documented as agent composition pattern). Marked get full as provisional composite. Added search --doc flag. MAAD.md now regenerated on every reindex. Old FRAMEWORK.md and README-MVP.md archived. 211 tests passing.

## 0.1.4 — 2026-04-07
summary is now sync read-only (no indexAll, no git audit). Rebuilt dist to match source. MAAD.md boot contract rewritten — stable instructions, summary for live snapshot, SCHEMA.md for deep reference only. Fixed project description to "Markdown As A Database". Added prepublishOnly build hook. 203 tests passing.

## 0.1.3 — 2026-04-07
Pointer-only DB refactor (frontmatter/content stripped from SQLite, all reads from disk). Three new LLM UX commands: summary (one-call orientation), get full (resolved record with refs/objects/related), schema (field definitions for writes). Static MAAD.md (no volatile counts). 203 tests passing.

## 0.1.2 — 2026-04-07
CLI write commands: create, update, inspect. MAAD.md auto-generation on init and reindex (LLM instruction file with full type/command reference). SQLite busy_timeout for concurrent read tolerance. Date extraction fix (gray-matter Date objects now convert to ISO). Roadmap updated with maad-demo, maad-benchmark, and three-repo structure. 192 tests passing.

## 0.1.1 — 2026-04-07
Punchlist fixes: git boundary detection (check .git at project root, not parent), reindex stale row cleanup (removes orphaned records for deleted files), numeric query semantics (numeric_value REAL column for correct range comparisons), write-path recovery warnings, YAML profile enforcement (rejects deep nesting, multi-document), list-of-ref relationship support (validator + extractor), round-trip authoring stability tests, test isolation hardening, MCP stub cleanup (removed unused SDK dep). 192 tests passing.

## 0.1.0 — 2026-04-06
Initial engine build. Parser, registry, schema, extractor (11 primitives), SQLite backend, 6-stage pipeline, CRUD, tiered reads, relationship traversal, deterministic writer with templates, git auto-commit and audit, CLI with 11 commands. 174 tests passing.

## Planned

Cascade renumbered after 0.7.13–0.7.16 (index-memory guards, audit correctness patch, housekeeping + CI, dependency security wave) consumed the planned slots. 0.8.0 shipped as Semantic Retrieval (the priority line; FTS5 moved up into it); the prior hygiene/imports → remote-hardening → query-power track sits +0.5 below it. (The 0.7.17/0.7.18 bullets below predate the shipped 0.7.17/0.7.18 — read-path performance + heavy-op self-defense — and describe displaced scope still pending a re-slot.)

- **0.7.17** — Durability & hot-path (from the 2026-06-09 engine audit). fsync'd atomic writes (unique temp suffix, failure cleanup), `maad_summary` rework (index-time validation state instead of full-corpus sync scan), journal reconcile that repairs `file_written` divergence and survives failed commits, prepared-statement caching, `documents(updated_at, doc_id)` index, pathspec-limited per-write `git status`, engine-owned `git gc --auto` hook, `indexAll` mtime+size precheck.
- **0.7.18** — Agent-First Engine (renumbered from 0.7.13). `maad_status` cross-project rollup, followup `supersedes` schema field, canonical `_skills/session-protocol.md` in engine. Plus remaining composites that collapse common call chains: `maad_bulk_update_where`, `maad_context(docId)`, `maad_get_many`, `maad_related depth: 'hydrated'`, `maad_subscribe_from(cursor)`. (`maad_query depth: 'cold'|'full'` shipped early in 0.7.3.)
- **0.8.x (follow-up)** — Semantic Retrieval Phase 2: local ONNX embedding provider (`nomic-embed-text-v1.5`, 512-dim Matryoshka, via transformers.js) as the default offline/no-key option, shipped as an optional dependency so an API-only install stays lean. (Phase 1 — the primitive, vector + FTS5 index, RRF, and OpenAI/injected providers — shipped in 0.8.0.)
- **0.8.5** — Operational Hygiene + Imports. `maad_prune_sessions` (stale-session sweeper), `maad_compact` (`VACUUM` + `git gc`), `maad_reindex_selective`, `maad_find_duplicates` + original Import workflow: `_inbox/` convention, source tracking, duplicate detection, readonly type flag.
- **0.9.0** — Remote MCP hardening: per-connection role tiers, rate-limit policy (per-token aggregation + live-session caps), backpressure thresholds, mutex timeout, stress suite, metrics export.
- **0.9.5** — Eviction Stage 2 + query power: LRU + hard pool cap (Stage 1 idle-timeout shipped in 0.7.3), in-place project mutations (lifts `INSTANCE_MUTATION_UNSUPPORTED`), fuzzy entity matching, compound filters (AND/OR), cursor-based pagination. (FTS5 moved into 0.8.0 Semantic Retrieval.)
- **0.10.0** — Object attributes: user-defined tags on extracted objects, stored as YAML, indexed on reindex.
- **1.0.0** — Stable release: API locked, npm published, full test coverage, migration guide.
