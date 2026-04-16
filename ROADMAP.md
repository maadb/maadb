# MAADB Roadmap

## Shipped

### v0.1.x — Foundation (2026-04-06)

- Core type system (branded IDs, 11 primitives, extensible subtype map)
- Parser (frontmatter, blocks, inline annotations, verbatim zone safety)
- Registry + schema system (YAML loader, validator, 8 field types, ref targets, templates)
- Extractor (11 normalizers, field extraction, annotation objects, relationships)
- SQLite backend (WAL mode, full query builder)
- Engine (6-stage pipeline, CRUD, tiered reads, relationship traversal)
- Writer (deterministic YAML serialization, template body generation)
- Git integration (auto-commit, structured messages, history, audit, diff)
- CLI (11 commands)
- Production hardening (durable writes, path security, error policy, batch queries, pagination)

### v0.2.x — MCP Server + Query Power (2026-04-07 through 2026-04-08)

- Pointer-only DB — SQLite stores pointers only, all content reads from files
- MCP server with stdio transport and role-based access (reader/writer/admin)
- LLM UX layer: `summary`, `get full`, `schema` commands
- Query projection (return only requested fields)
- Aggregation tool (`count`, `sum`, `avg`, `min`, `max` grouped by field)
- Cross-ref joins (`maad_join` — query + follow refs + project both sides)
- Bulk operations (`bulk_create`, `bulk_update` — single git commit)
- Provenance mode (`--prov off|on|detail`)
- Architect skill — autonomous database design and deployment
- Static MAAD.md generation
- 266 tests, 4 production dependencies

### v0.4.0 — Multi-Project Routing (2026-04-14)

- `instance.yaml` declares multiple projects served by one MCP server
- Session-bound mode: `maad_use_project` (single) or `maad_use_projects` (multi whitelist); session-level role downgrade via `as=<role>`
- `EnginePool` lazy-loads engines per project; eviction seam exposed, policy deferred to 0.9.0
- `SessionRegistry` keyed by MCP-SDK session IDs — HTTP/SSE-ready for 0.5.0 remote transport
- 4 instance-level tools (`maad_projects`, `maad_use_project`, `maad_use_projects`, `maad_current_session`); all 22 existing tools become routable
- Backward-compatible `--project` / `--role` single-project mode (auto-bind to synthetic `default` project)
- 57 new tests, 323 total passing

### v0.4.1 — Production Hardening (2026-04-15)

Hardened the write path and operational surface before exposing the engine over a network transport. No tool-surface changes beyond new error codes and extended `maad_health`.

- Per-engine FIFO write mutex (`AsyncFifoMutex`, `runExclusive` wrapper) — serializes all 9 mutating engine methods
- Stale `.git/index.lock` recovery on init (30s mtime threshold, refuses to start if lock is recent)
- Idempotency keys — `(project, tool, key)` scoped LRU cache (10-min TTL, 10k max), replay identified via `_meta.replayed` + `_meta.original_request_id`
- Per-session token-bucket rate limiting (writes/sec=10, writes/min=60, concurrent=5) + 1 MiB payload cap
- Structured JSON logging (pino) with separate ops + audit channels, per-request `request_id` threaded through responses
- Per-request timeout (30s default) + graceful shutdown state machine (running → draining → exiting)
- Extended `maad_health`: writeQueueDepth, lastWriteOp, lastWriteAt, repoSizeBytes (cached 60s), gitClean, diskHeadroomMb
- New error codes: `RATE_LIMITED`, `REQUEST_TIMEOUT`, `SHUTTING_DOWN`, `WRITE_TIMEOUT` (reserved for 0.8.5)
- 71 new tests across mutex/concurrency/idempotency/rate-limit/logging/lifecycle/health-extensions modules, 394 total passing

### v0.5.0 — Remote MCP Transport (2026-04-15)

Engine served over HTTP/SSE so MCP clients can connect across the network. One server process handles many concurrent client sessions. Builds on the 0.4.0 `SessionRegistry` (keyed by HTTP session ID) and the 0.4.1 hardened engine. stdio remains the default for local use.

- [x] HTTP/SSE transport via `StreamableHTTPServerTransport` (MCP SDK 1.29+), `node:http` with explicit headers/request/keep-alive timeouts, response hardening (`nosniff` + `no-store`), 128-bit CSPRNG session IDs
- [x] Bearer-token auth at handshake — constant-time compare (`crypto.timingSafeEqual`), 401 precedes 404 so unauth callers can't enumerate sessions, pino redaction on the authorization header
- [x] Session lifecycle fan-out — `registerCloseHandler`, idempotent `destroy(sid, reason)`, `peek` without bumping `lastActivityAt`, rate-limit dispose on close
- [x] Idle sweeper — inbound-only activity clock, evicts zombie SSE streams past `MAAD_SESSION_IDLE_MS` (30 min default)
- [x] `OperationKind` (`read` / `write`) classification per tool, reentrant write mutex via AsyncLocalStorage — concurrent reads while a write holds the lock, deadlock-free re-entry from engine methods
- [x] `maad_changes_since` polling delta — opaque base64url cursor, strict tuple ordering on `(updated_at, doc_id)`, deterministic pagination, operation classification from document version
- [x] Extended `maad_health` — `transport {kind, host?, port?, uptimeSeconds}` and `sessions {active, openedTotal, closedTotal, lastOpenedAt, lastClosedAt, idleSweepLastRunAt}`
- [x] Unauthenticated `GET /healthz` liveness probe — 200 `{ok:true}` live / 503 `SHUTTING_DOWN` during drain, no state leak in body, not exposed under stdio
- [x] Audit + ops events — `session_open`, `session_close`, `auth_failure`, `idle_sweep` on their channels
- [x] Deploy guides — [systemd + nginx (bare metal)](docs/deploy/systemd.md), [Docker + traefik](docs/deploy/docker.md)
- [x] TLS terminated at reverse proxy (documented, not enforced in-engine)

82 new tests (transport/auth/lifecycle/concurrency/changes-since/healthz/health-telemetry), 476 total passing. Spec at [`docs/specs/0.5.0-remote-mcp.md`](docs/specs/0.5.0-remote-mcp.md).

### v0.6.7 — Schema Precision Hints (2026-04-16)

Schema-driven datetime precision contract. Date fields can now declare `store_precision` (engine-enforced minimum on write) and `display_precision` (consumer-side rendering hint). Non-breaking by construction: absent keys = pre-0.6.7 lenient behavior; default `on_coarser: warn` means opt-in schemas emit warnings rather than blocking on historical coarse data. Enforcement fires at write-time only — read, reindex, and audit paths never judge historical values. Ship gate for the hosted brain: coarse writes are permanent data loss, so the contract had to land before end-user data existed.

Delivered in five phases (P1–P5) on branch `feat/0.6.7-schema-precision`. P1 (commit 793d4fa) landed the precision primitives — `detectPrecision()` honoring literal-string shape (`2026-04-16T00:00:00Z` is `second`, not day-padded), `comparePrecision()`, `isCoarserThan()`, `isPrecision()` type guard. P2 (commit 4962218) closed a load-bearing round-trip bug surfaced by Codex review (jrn-2026-025): gray-matter's default YAML engine coerced `!!timestamp` scalars into JS Date objects, and five downstream sites (writer/serializer, extractor/fields, engine/indexing, engine/reads, engine/writes) normalized Dates via `.toISOString().slice(0, 10)` — silently truncating any finer-than-day precision on every round-trip. Fix consolidates all 11 `matter()` callers through a single `parseMatter()` helper that injects a string-preserving YAML engine (`js-yaml` `CORE_SCHEMA` without the timestamp type), and changes the five slice sites to emit full ISO millisecond precision, quoted so external parsers can't re-coerce. `js-yaml@^4.1.0` promoted to direct dependency. P3 (commit f4cd65f) added the reusable `ValidationWarning[]` channel — `ValidationResult.warnings`, response `_meta.warnings[]` plumbing via new `attachWarnings()` helper, `BulkResult` gains per-record `succeeded[].warnings` plus top-level aggregated `warnings[]` with `{docId}.` field prefix. Four write tool handlers wired (maad_create, maad_update, maad_bulk_create, maad_bulk_update). Channel is reusable for future soft-validations — deprecated fields, length hints, cross-field invariants, schema-evolution notices all slot in without further plumbing. P4 (commit 988be25) turned on the contract. Schema DSL parses three new keys on date fields with schema-load-time validation that `display_precision` is coarser-or-equal to `store_precision` (inverted rejects with `SCHEMA_INVALID`). Validator gains `ValidationOptions {mode, changedFields?}` with default `mode: 'read'` — the safety default. Precision gate fires only when `mode === 'write'`, `fieldDef.storePrecision` is declared, `changedFields` includes the field (or is undefined for create), and structural validation passed. Five call sites pass explicit mode: `writes.ts` create/update/bulk → `'write'` (update also passes `changedFields` Set from the already-tracked array — the T4 backward-compat hinge), `indexing.ts` → `'index'`, `reads.ts` → `'read'`, `maintenance.ts` → `'audit'`. `maad_schema` response field entries include `storePrecision` / `onCoarser` / `displayPrecision` when declared. `maad_validate` gains `includePrecision: true` option producing informational `precisionDrift[]` array (never mutates valid/invalid counts). New `logValidationWarning()` emits one `warn`-level ops log line per warning with structured fields (request_id, session_id, project, tool, doc_id, doc_type, field, code, message). P5 shipped the docs — `_skills/schema-guide.md` gains a Date precision section with event-timestamp and birthday examples plus the rules (storage wins, write-time only, update-neighbor safe, audit-via-`includePrecision`), README Current State + Roadmap refreshed, this file, `Version.md` bumped, tag cut.

78 new tests (precision primitives 23 + string-preserving YAML 7 + datetime round-trip 5 + warnings channel 7 + validator enforcement 16 + loader DSL 8 + engine integration 10 + bumped pre-existing 2), 554 total passing. New deps: `js-yaml@^4.1.0` + `@types/js-yaml` (dev), both already transitive via gray-matter. New error code: the warning code `PRECISION_COARSER_THAN_DECLARED` is the first tenant of the open-string `ValidationWarning.code` field — future codes introduced without type change. Spec at [`docs/specs/0.6.7-schema-precision.md`](docs/specs/0.6.7-schema-precision.md). Decision record `dec-maadb-067-schema-precision` in the project brain.

---

## Current: v0.6.7

See Shipped block above.

---

## Planned

### 0.5.1 — Deployment Workflow

Zero-to-operational in one agent session. Builds on 0.4.0 multi-project mode and the 0.4.1 hardened engine.

- [ ] `_skills/deploy.md` — agent-guided instance setup (prerequisites, scaffolding, `instance.yaml`, MCP config, Architect handoff per project)
- [ ] README deployment section validated against fresh installs (instance-first)
- [ ] Platform-specific MCP config generation (Claude Code, Claude Desktop, generic stdio + HTTP) — emits instance-mode configs by default
- [ ] `maad init-instance` CLI command — scaffolds `instance.yaml` and directory layout
- [ ] `maad add-project <name> <path>` CLI command — appends to `instance.yaml`, creates project dir if missing
- [ ] Verify deploy → `maad_use_project` → architect → operational flow end-to-end

### 0.6.0 — Scoped Auth & Identity

Required for multi-user / multi-agent demos where one brain is shared with differentiated permissions and auditable provenance. Pulls the token → role mapping forward from 0.9.0 (was 0.8.5) and adds identity attribution on every write. File-backed token registry, no external IdP yet.

- [ ] Token registry at `_auth/tokens.yaml` — each bearer maps to `{ role, user_id?, agent_id?, name?, created_at }`
- [ ] Per-token role gating replaces server-wide `--role` as the source of truth (legacy `--role` stays as synthetic single-token fallback)
- [ ] `withSession` reads role from authenticated token claim, not server config
- [ ] Hash-indexed constant-time token lookup (no linear scan)
- [ ] Audit log enriched — `user_id`, `agent_id` on every `tool_call`, `session_open`, `session_close`, `auth_failure`
- [ ] Git commit messages include token-claimed identity (per-write attribution)
- [ ] `maad_health.sessions` breakdown by role and identity for admin introspection
- [ ] CLI: `maad issue-token --role <role> [--user <id>] [--agent <id>] [--name <label>]` — emits bearer + records registry entry
- [ ] CLI: `maad revoke-token <id|hash>` — tombstones a token; subsequent requests hit 401
- [ ] 401 response shape unchanged (no identity leak on unauth)
- [ ] Scope out: external IdP (OIDC/JWT), rotation UX, per-tenant token quotas — future

### 0.6.5 — Live Notifications

Push-based change feed so subscribed agents see writes without polling `maad_changes_since`. Layered on the existing SSE channel — zero overhead when nobody subscribes.

- [ ] `maad_subscribe` tool — session declares filter `{ docTypes?, project?, since? }`, server pushes matching events on the SSE stream
- [ ] `notifications/resources/updated` notification fires per successful write, payload shaped like a `changes_since` item so subscribers can resume on reconnect
- [ ] Per-session queue cap — drops oldest on overflow, emits `notifications/resources/list_changed` as a catch-up-via-polling hint
- [ ] Writes notify after commit, not before — preserves read-after-write consistency
- [ ] Reentrant-safe: write mutex held through notify dispatch
- [ ] Multi-subscriber fan-out within one process; cross-process broadcast deferred
- [ ] Scope out: WebSockets (SSE suffices for unidirectional push), cross-project subscriptions (scope to bound project only)

### 0.7.0 — npm Package Prep

Was 0.6.0. Makes the engine trivially installable into container images and remote deployments.

- [ ] Clean up public API surface
- [ ] `npx maad serve` works without cloning the repo
- [ ] Package published to npm
- [ ] MCP configs simplify to `npx maad` instead of absolute paths
- [ ] Getting started guide for new users

### 0.7.5 — Import Workflow

Recurring import of raw files into MAADB projects.

- [ ] `_inbox/` directory convention (drop zone for raw files)
- [ ] `_skills/import-workflow.md` — agent-guided inbox processing
- [ ] Source tracking fields (`source_file`, `source_hash`) as schema convention
- [ ] Duplicate detection via `source_hash` query before create
- [ ] Readonly type flag — engine rejects updates on readonly types
- [ ] Delete source from `_inbox/` after successful import
- [ ] Test with static catalog archetype

### 0.8.0 — LLM Evaluation

Was 0.7.5. Prove the engine works across models and use cases with real data. Deferred from 0.3.0 slot — production hardening and remote transport took priority.

- [ ] Multi-model testing (Claude, GPT, Gemini) against maadb-demo
- [ ] Identify friction points in tool usage, schema design, and boot flow
- [ ] Document what works and what breaks per model
- [ ] Benchmark: token usage, call count, accuracy on structured tasks
- [ ] Test the Architect skill end-to-end: vague prompt → working database

### 0.8.5 — Provenance + Admin Tooling

Was 0.8.0. Better visibility into what happened and why.

- [ ] Provenance refinement — cleaner source attribution in responses
- [ ] Admin dashboard tool — project health, index stats, schema drift detection
- [ ] `maad_export` — dump project data in portable format
- [ ] Improved error messages with actionable guidance

### 0.8.7 — Storage Backend Abstraction (prep)

Placeholder — design work only, no runtime migration. Locks in a `StorageBackend` interface so future work (alternative backends, enterprise hosted tier) can slot in without unwinding git assumptions across 20+ files. Not launch-blocking. Git remains backend #1 indefinitely; "every brain is a clonable git repo" stays a product feature.

- [ ] Define `StorageBackend` interface — required ops: `commit(files[], message, metadata)`, `getAtRevision(path, rev)`, `listHistory(path, limit)`, `atomicMultiFile(mutations)`, `isClean()`, `repoSizeBytes()`
- [ ] Refactor write path to route through the interface — no direct `git` shell-outs outside `GitBackend`
- [ ] Extract current git logic into `GitBackend` as reference implementation — behavior unchanged, 476+ tests pass
- [ ] Spec doc: migration guidance for future candidates (libgit2/isomorphic-git for perf, Postgres + audit table for enterprise query scale, object store + metadata DB for cloud-native)
- [ ] Document the commit-as-transaction-boundary guarantee — any future backend MUST preserve it or re-solve 0.4.1's mutex/idempotency/stale-lock-recovery
- [ ] Scope out: actual alternative backend implementations (post-1.0 if product demands); local dev and self-hosted deployments stay on `GitBackend`

### 0.9.0 — Remote MCP Hardening

Was 0.8.5 (token → role line moved to 0.6.0). Promote remote transport from "minimal" to "operator-grade" based on real 0.5.0 usage signal.

- [ ] Configurable rate limit policy per token or tier (builds on 0.6.0 token metadata)
- [ ] Backpressure / queue depth thresholds with tunable 429 response
- [ ] Mutex timeout with `WRITE_TIMEOUT` error path (replaces infinite block from 0.4.1)
- [ ] Full concurrency stress test suite
- [ ] Metrics export (Prometheus or OTEL)
- [ ] `git gc` automation / scheduled maintenance

### 0.9.5 — Query Power

Was 0.9.0. Make the index smarter.

- [ ] Full-text search via SQLite FTS5
- [ ] Fuzzy entity matching (typo-tolerant search)
- [ ] Compound filters (AND/OR in `maad_query`)
- [ ] Sort by any indexed field
- [ ] Cursor-based pagination tokens

### 0.9.7 — Object Attributes

Was 0.9.5. User-defined metadata on extracted objects.

- [ ] Attribute definitions in `_registry/object_types.yaml`
- [ ] Attribute assignments in `_registry/object_tags.yaml`
- [ ] SQLite `object_attributes` table, rebuilt on reindex
- [ ] Query support: filter objects by attribute values
- [ ] CLI/MCP commands to read/write attributes (writes go to YAML + git commit)

### 1.0.0 — Stable Release

- [ ] API locked — no breaking changes after this
- [ ] npm package published and documented
- [ ] Full test coverage across all MCP tools
- [ ] Migration guide from pre-1.0 projects

---

## Future (unscoped)

These are ideas, not commitments. They'll get scoped when the time comes.

**Schema evolution** — migration tooling (v1 → v2 field mapping), backwards-compatible field additions, schema diffing

**Writer enhancements** — section-level body updates, partial reindex after frontmatter-only changes

**Advanced extraction** — LLM-assisted inference extraction, confidence scoring, extraction review workflow

**Vector search** — embeddings for markdown body content, semantic search alongside structured queries, hybrid retrieval

**Ecosystem** — VS Code extension, web UI for browsing/querying, agent SDK bindings

**Enterprise** — immutable document versions, queryable audit event store, role-based access control on documents, multi-tenant isolation, encryption at rest
