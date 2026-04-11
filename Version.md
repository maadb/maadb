---
enabled: true
current: 0.2.13
---

# Version History

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

- **0.2.6** — Bug fixes: ref field query filtering, aggregate totalMetric, `maad connect` CLI command, Architect requires admin role warning
- **0.3.0** — LLM evaluation: maadb-demo benchmark execution (MAAD vs Direct), evaluation framework
- **0.4.0** — Query power: FTS5, fuzzy entity matching with confidence scores
- **0.5.0** — Object attributes: user-defined tags on extracted objects, stored as YAML, indexed on reindex
- **0.6.0** — Multi-project MCP: single server routing to multiple MAAD projects, cross-project queries
- **0.7.0** — npm package prep: API surface decisions, exports, bin config, peer deps
- **1.0.0** — Stable release: API locked, npm published, documentation complete
