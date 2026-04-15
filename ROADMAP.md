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

---

## Current: v0.4.0

Multi-project routing shipped. One MCP server serves multiple MAAD projects via `instance.yaml` with session-bound mode (single or multi), per-project roles, and session-level role downgrade. `EnginePool` lazy-loads engines with an eviction seam (policy deferred). `SessionRegistry` keyed by MCP-SDK session IDs (HTTP/SSE-ready for remote transport). 4 instance-level tools, backward-compatible `--project`/`--role` single-project mode. 13 reader / 18 writer / 22 admin tools, all routable. 323 tests passing.

---

## Planned

### 0.4.1 — Production Hardening

Harden the write path and operational surface before exposing the engine over a network transport. Everything here is internal — no tool-surface changes beyond a handful of new error codes and extended `maad_health` fields.

- [ ] Write concurrency spec — `docs/specs/0.4.1-write-concurrency.md` covering mutex shape, FIFO ordering, timeout policy, stale `.git/index.lock` recovery, error codes, test plan
- [ ] Per-engine write mutex (FIFO, blocking) — serializes all mutating operations per project engine
- [ ] Stale git lock recovery on engine `init()` — detect and clear orphaned `.git/index.lock` from crashed prior process
- [ ] Idempotency keys on writes — optional client-supplied UUID deduplicated within a TTL window; prevents duplicate records on retry
- [ ] Rate limiting — per-session token bucket (starting: 10 writes/sec burst, 60/min sustained, 5 concurrent in-flight, 1MB max payload); tunable via env
- [ ] Structured JSON logging — pino-based, `request_id` / `session_id` / `project` / `tool` / `role` / `payload_size` / `latency_ms` / `result` / `error_code` on every MCP call; token redaction
- [ ] Separate audit log channel — writes only, with before/after version, suitable for compliance review
- [ ] Per-request timeouts + graceful shutdown — SIGTERM flushes in-flight writes, closes SQLite cleanly, releases git lock
- [ ] `maad_health` extensions — queue depth, last-write timestamp, repo size on disk, git clean flag, disk headroom
- [ ] Concurrency smoke tests — two-writer race, N-writer flood, writer + concurrent readers, stale lock recovery
- [ ] New error codes — `WRITE_CONFLICT`, `WRITE_TIMEOUT`, `RATE_LIMITED`, `IDEMPOTENCY_REPLAY`, `SHUTTING_DOWN`

### 0.5.0 — Remote MCP Transport

Pulled forward from 0.9.0. Reuses the `SessionRegistry` model built in 0.4.0 — same routing logic keyed by HTTP session ID instead of stdio process. Lands on the hardened engine from 0.4.1.

- [ ] HTTP/SSE transport via `StreamableHTTPServerTransport` from the MCP SDK
- [ ] Token-based auth at MCP handshake — bearer token maps to role
- [ ] Single role tier at launch (authenticated = effective role); per-connection role refinement deferred
- [ ] Concurrent read access (multiple agents, one instance)
- [ ] `maad_changes_since <timestamp|version>` polling delta endpoint — cheap "what changed" for agents that want freshness between calls
- [ ] Deployment guide for Docker / Azure Functions / VM
- [ ] TLS terminated at reverse proxy (documented, not enforced in-engine)

### 0.5.1 — Deployment Workflow

Zero-to-operational in one agent session. Builds on 0.4.0 multi-project mode and the 0.4.1 hardened engine.

- [ ] `_skills/deploy.md` — agent-guided instance setup (prerequisites, scaffolding, `instance.yaml`, MCP config, Architect handoff per project)
- [ ] README deployment section validated against fresh installs (instance-first)
- [ ] Platform-specific MCP config generation (Claude Code, Claude Desktop, generic stdio + HTTP) — emits instance-mode configs by default
- [ ] `maad init-instance` CLI command — scaffolds `instance.yaml` and directory layout
- [ ] `maad add-project <name> <path>` CLI command — appends to `instance.yaml`, creates project dir if missing
- [ ] Verify deploy → `maad_use_project` → architect → operational flow end-to-end

### 0.6.0 — npm Package Prep

Pulled forward from 0.8.0. Makes the engine trivially installable into container images and remote deployments.

- [ ] Clean up public API surface
- [ ] `npx maad serve` works without cloning the repo
- [ ] Package published to npm
- [ ] MCP configs simplify to `npx maad` instead of absolute paths
- [ ] Getting started guide for new users

### 0.7.0 — Import Workflow

Recurring import of raw files into MAADB projects.

- [ ] `_inbox/` directory convention (drop zone for raw files)
- [ ] `_skills/import-workflow.md` — agent-guided inbox processing
- [ ] Source tracking fields (`source_file`, `source_hash`) as schema convention
- [ ] Duplicate detection via `source_hash` query before create
- [ ] Readonly type flag — engine rejects updates on readonly types
- [ ] Delete source from `_inbox/` after successful import
- [ ] Test with static catalog archetype

### 0.7.5 — LLM Evaluation

Prove the engine works across models and use cases with real data. Deferred from 0.3.0 slot — production hardening and remote transport took priority.

- [ ] Multi-model testing (Claude, GPT, Gemini) against maadb-demo
- [ ] Identify friction points in tool usage, schema design, and boot flow
- [ ] Document what works and what breaks per model
- [ ] Benchmark: token usage, call count, accuracy on structured tasks
- [ ] Test the Architect skill end-to-end: vague prompt → working database

### 0.8.0 — Provenance + Admin Tooling

Better visibility into what happened and why.

- [ ] Provenance refinement — cleaner source attribution in responses
- [ ] Admin dashboard tool — project health, index stats, schema drift detection
- [ ] `maad_export` — dump project data in portable format
- [ ] Improved error messages with actionable guidance

### 0.8.5 — Remote MCP Hardening

Promote remote transport from "minimal" to "operator-grade" based on real 0.5.0 usage signal.

- [ ] Per-connection role tiers (reader / writer / admin) with token → role mapping
- [ ] Configurable rate limit policy per token or tier
- [ ] Backpressure / queue depth thresholds with tunable 429 response
- [ ] Mutex timeout with `WRITE_TIMEOUT` error path (replaces infinite block from 0.4.1)
- [ ] Full concurrency stress test suite
- [ ] Metrics export (Prometheus or OTEL)
- [ ] `git gc` automation / scheduled maintenance

### 0.9.0 — Query Power

Make the index smarter.

- [ ] Full-text search via SQLite FTS5
- [ ] Fuzzy entity matching (typo-tolerant search)
- [ ] Compound filters (AND/OR in `maad_query`)
- [ ] Sort by any indexed field
- [ ] Cursor-based pagination tokens

### 0.9.5 — Object Attributes

User-defined metadata on extracted objects.

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
