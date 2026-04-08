---
enabled: true
current: 0.2.3
---

# Version History

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

- **0.2.0** — MCP server: 15 LLM tools via stdio transport (minor, new capability)
- **0.3.0** — Reverse import tooling: CSV/JSON/SQL converters (minor, new capability)
- **0.4.0** — Query enhancements: FTS5, compound filters, aggregations (minor, new capability)
- **1.0.0** — First stable release: API locked, npm published, documentation complete (major, stability declaration)
