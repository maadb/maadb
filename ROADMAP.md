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

## Current: v0.2.12

Engine is stable, public, and feature-complete for single-project MCP use. Recent additions: version tracking on reads, query sort, list field index fix, summary warnings, validation messages, bulk_update batching, read-back verification, `maad_verify` fact-checking tool, grounding rules, env var config, dynamic server version. 13 reader / 18 writer / 22 admin tools.

---

## Planned

### 0.3.0 — LLM Evaluation

Prove the engine works across models and use cases with real data.

- [ ] Multi-model testing (Claude, GPT, Gemini) against maadb-demo
- [ ] Identify friction points in tool usage, schema design, and boot flow
- [ ] Document what works and what breaks per model
- [ ] Benchmark: token usage, call count, accuracy on structured tasks
- [ ] Test the Architect skill end-to-end: vague prompt → working database

### 0.3.5 — Deployment Workflow

Zero-to-operational in one agent session.

- [ ] `_skills/deploy.md` — agent-guided project setup (prerequisites, scaffolding, MCP config, Architect handoff)
- [ ] README deployment section validated against fresh installs
- [ ] Platform-specific MCP config generation (Claude Code, Claude Desktop, generic stdio)
- [ ] `maad init-project` CLI command (creates directory structure without MCP)
- [ ] Verify deploy → architect → operational flow end-to-end

### 0.4.0 — Multi-Project Routing

One MCP server, multiple projects, session-bound mode. Foundation for everything multi-project. Inherits the 0.2.13 empty-project bootstrap: each pooled engine self-heals via `engine.init()` and `ensureProjectSkills()` runs per project on first bind, so `maad_use_project` works against empty directories without any manual init step.

- [ ] `instance.yaml` — declares projects with name, path, role, description
- [ ] `EnginePool` — lazy-loads engines per session, no eviction in v1
- [ ] `SessionState` — per-connection mode + active project + whitelist
- [ ] `maad_use_project <name>` — bind session to single mode (locked to one project)
- [ ] `maad_use_projects [names]` — bind session to multi mode (whitelist + explicit `project=` required on every call)
- [ ] `maad_projects` — list available projects (works pre-session)
- [ ] `maad_current_session` — debug session state
- [ ] `withSession()` wrapper on every project-level tool — routes to correct engine, enforces mode
- [ ] No mid-session mode switching (end and reconnect)
- [ ] Backward compat: `--project <path>` still works, auto-binds session to single mode
- [ ] `--instance <path>` and `MAAD_INSTANCE` env var
- [ ] Tool count: 4 new instance-level tools, all 22 existing tools become routable

### 0.5.0 — Import Workflow

Recurring import of raw files into MAADB projects. Built on multi-project routing from day one.

- [ ] `_inbox/` directory convention (drop zone for raw files)
- [ ] `_skills/import-workflow.md` — agent-guided inbox processing
- [ ] Source tracking fields (`source_file`, `source_hash`) as schema convention
- [ ] Duplicate detection via `source_hash` query before create
- [ ] Readonly type flag — engine rejects updates on readonly types
- [ ] Delete source from `_inbox/` after successful import
- [ ] Test with static catalog archetype (research papers, book collection)

### 0.5.5 — Provenance + Admin Tooling

Better visibility into what happened and why.

- [ ] Provenance refinement — cleaner source attribution in responses
- [ ] Admin dashboard tool — project health, index stats, schema drift detection
- [ ] `maad_export` — dump project data in portable format
- [ ] Improved error messages with actionable guidance

### 0.6.0 — Query Power

Make the index smarter.

- [ ] Full-text search via SQLite FTS5
- [ ] Fuzzy entity matching (typo-tolerant search)
- [ ] Compound filters (AND/OR in `maad_query`)
- [ ] Sort by any indexed field
- [ ] Cursor-based pagination tokens

### 0.7.0 — Object Attributes

User-defined metadata on extracted objects.

- [ ] Attribute definitions in `_registry/object_types.yaml`
- [ ] Attribute assignments in `_registry/object_tags.yaml`
- [ ] SQLite `object_attributes` table, rebuilt on reindex
- [ ] Query support: filter objects by attribute values
- [ ] CLI/MCP commands to read/write attributes (writes go to YAML + git commit)

### 0.8.0 — npm Package Prep

Make MAAD installable.

- [ ] Clean up public API surface
- [ ] `npx maad serve` works without cloning the repo
- [ ] Package published to npm
- [ ] MCP configs simplify to `npx maad` instead of absolute paths
- [ ] Getting started guide for new users

### 0.9.0 — Remote MCP

Hosted deployment with enforced access control. Reuses the `SessionState` model built in 0.4.0 — same routing logic, keyed by HTTP session ID instead of stdio process.

- [ ] HTTP/SSE transport (`StreamableHTTPServerTransport` from MCP SDK)
- [ ] Per-connection roles (endpoint-based or token-based)
- [ ] Concurrent read access (multiple agents, one instance)
- [ ] Deployment guide for Docker / Azure Functions / VM
- [ ] Roles enforced by architecture — agents can't bypass MCP when connecting over network
- [ ] Session whitelist enables workload-aware routing at scale

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
