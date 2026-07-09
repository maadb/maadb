# MAADb — Markdown As A Database

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A524-brightgreen.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-strict-blue.svg)](tsconfig.json)
[![Tests](https://img.shields.io/badge/tests-993%20passing-brightgreen.svg)](tests)
[![npm](https://img.shields.io/npm/v/@maadb/core.svg)](https://www.npmjs.com/package/@maadb/core)
[![Version](https://img.shields.io/badge/version-0.7.17-purple.svg)](Version.md)

> **Markdown is the database. The engine makes it queryable.**

MAADb stores records as markdown files with YAML frontmatter for structured fields and body content for narrative. The engine validates schemas, builds a lookup index, and serves the whole thing to LLM agents over MCP. Your data stays in files you can read, grep, and version-control — not behind an opaque database server.

## Why MAADb

- **Markdown is canonical.** Open any record in any text editor — your data is exactly what's on screen, no translation layer.
- **Git is the audit trail.** Every write is a commit. `maad_history` shows the full change history for any record.
- **LLM-native.** Ships with 30+ MCP tools for discovery, read, write, maintenance, and auth. Designed for agent workflows from the start.
- **Optional schemas.** Add YAML schemas when you want structure, skip them when you don't. Validation runs on writes, never on old records.
- **The index is a speed layer.** SQLite stores pointers into your markdown files. Delete it and `maad reindex` rebuilds it from the markdown — your data never depends on the index surviving.
- **Safe under concurrent writes.** Clean shutdown, lock recovery, rate limiting, retry-safe operations all built in.
- **Headless and lightweight by design.** No UI, no web server, no admin console — just an engine and an MCP interface. Six production dependencies. The navigator is your text editor, `git`, and the host app you build on top; browsing lives one layer up, not in the engine.

## Where MAADb fits

MAADb works as a context engine for AI agents — a place to hold the information they need to keep working, when that context still needs structure. Records are typed, relationships are queryable through MCP, and the data stays as readable markdown on disk. Common shapes: agent memory, project state, ongoing case files. For high-throughput transactional data or pure semantic retrieval at scale, purpose-built tools serve better.

## Quick example

A record lives as markdown with a schema-validated YAML header:

```markdown
---
doc_id: cas-2026-001
doc_type: case
schema: case.v1
title: Contract Review Dispute
client: cli-acme
status: open
opened_at: 2026-04-01
---

# Contract Review Dispute {#summary}

Dispute over delivery obligations and late change requests.

## Timeline {#timeline}

Initial issue raised on [[date:2026-03-28|March 28, 2026]].

## Parties {#parties}

[[person:Jane Smith|Jane]] representing [[org:Acme Corporation|Acme]].
```

Three addressable layers:

- **Frontmatter** — structured fields, schema-validated on write.
- **Headings** — individually-readable sections via line pointers.
- **Inline annotations** — `[[type:value|label]]` entities extracted and indexed cross-document.

## How it works

```
Markdown files (your data)
  -> YAML registry + schemas (define structure)
  -> Engine (parse, validate, extract, index)
  -> SQLite (pointer-only query index)
  -> MCP server (LLM agent interface)
```

See [docs/framework.md](docs/framework.md) for data doctrine, tier model, and engine design principles.

## Architecture

Runtime layout, client to storage:

```
┌─ Client (agent) ────────────────────────────────────────┐
│  stdio subprocess   or   HTTP/SSE client                │
└────────────────────────┬────────────────────────────────┘
                         │  MCP protocol
┌────────────────────────▼────────────────────────────────┐
│  MCP server (one process per instance)                  │
│    • SessionRegistry  — bind state, effective roles     │
│    • EnginePool       — one engine per bound project    │
│    • TokenStore       — HTTP transport only (0.7.0+)    │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  Instance                                               │
│    instance.yaml        — project declarations + roles  │
│    _auth/tokens.yaml    — per-agent tokens (HTTP only)  │
└────────────────────────┬────────────────────────────────┘
                         │  N projects per instance
┌────────────────────────▼────────────────────────────────┐
│  Project (each is a directory)                          │
│    _registry/   Type definitions                        │
│    _schema/     Field schemas per type                  │
│    _backend/    SQLite index (derived, gitignored)      │
│    _import/     Drop zone for raw imports               │
│    _skills/     Agent skill files                       │
│    MAAD.md      Generated agent operating instructions  │
│    <type-dirs>/ Records (paths declared in _registry/)  │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────┐
│  Engine (per project)                                   │
│    parse → validate → extract → index → git-commit      │
└─────────────────────────────────────────────────────────┘
```

**One instance, many projects.** The MCP server is instance-scoped; each bound session gets routed to the engine for its active project. Projects are filesystem-isolated — nothing in project A's engine touches project B.

**One engine, two interfaces.** The engine is the same whether you reach it over stdio (local subprocess, host user is the trust boundary) or HTTP/SSE (per-agent tokens, three-cap role composition).

**Two sources of truth on disk.** Markdown files are canonical — open any record in a text editor and you see exactly what the engine sees. SQLite is a rebuildable pointer index; delete `_backend/` and `maad reindex` rebuilds it from the markdown. A long-lived server can rebuild at boot with `MAAD_BOOT_REINDEX=1`; either way the engine refuses to serve an empty index over existing markdown rather than returning empty results.

## Quick start

### Install

Published on npm as [`@maadb/core`](https://www.npmjs.com/package/@maadb/core). No clone needed.

```bash
# Run directly without installing
npx @maadb/core --help

# Or install globally
npm install -g @maadb/core
maad --help

# Or add as a project dependency
npm install @maadb/core
```

To work on the engine itself, clone and build:

```bash
git clone https://github.com/maadb/maadb.git
cd maadb
npm install && npm run build
```

### Single-project (simplest)

Wire up MCP in your agent (`.mcp.json` in the project directory):

```json
{
  "mcpServers": {
    "maad": {
      "command": "npx",
      "args": [
        "-y", "@maadb/core",
        "--project", "/absolute/path/to/my-project",
        "serve",
        "--role", "admin"
      ]
    }
  }
}
```

(Or use `node /absolute/path/to/maadb/dist/cli.js ...` if running from a checkout.)

Same shape for Claude Desktop (`claude_desktop_config.json`) and OpenClaw. Any MCP-compatible agent works — stdio is the default, HTTP/SSE is available since 0.5.0.

Restart your agent. The agent detects an empty project and enters **Architect mode** to design the schema based on your goal:

> *"Set up a CRM for my law firm."*
> *"Index my research papers for querying."*
> *"Create a persistent memory store for this agent."*

The Architect skill handles type discovery, schema design, registry creation, and deployment. From there, any agent with an MCP connection can read and write records.

### Multi-project (one server, many projects)

When one MCP server should serve more than one project — or when deploying over HTTP — use an **instance config**. `instance.yaml` is a deployment artifact, hand-written once by the operator and updated whenever projects are added, removed, or have their role ceilings changed. No CLI scaffolder exists yet.

Write `instance.yaml`:

```yaml
name: my-instance
projects:
  - name: alpha
    path: /absolute/path/to/alpha
    role: admin                    # role ceiling for this project
    description: Primary project
  - name: beta
    path: ./beta                   # relative paths resolve against this file's directory
    role: reader
```

**Fields:**
- `name` (required) — instance label for logs/diagnostics
- `projects[]` (required, ≥1):
  - `name` — slug `[a-z][a-z0-9_-]*`, unique within the instance. This is the **bind key** agents pass to `maad_use_project(s)`.
  - `path` — absolute, or relative to the yaml file's directory.
  - `role` — `reader | writer | admin` (default `reader`). This is the project's **role ceiling** — the server-assigned maximum. No session can exceed it.
  - `description` — optional, surfaces in `maad_projects`.

Startup validates the file and fails fast on any error.

Serve:

```bash
node dist/cli.js --instance /path/to/instance.yaml serve
```

`--project` and `--instance` are mutually exclusive. `serve` with neither flag errors.

**Declaring new projects:** add another entry to `projects[]` and reload the server (`SIGHUP` / `systemctl reload maad` / `docker compose kill -s SIGHUP maad`). Projects not declared in `instance.yaml` are unreachable through MCP — there is no runtime add-project path.

### Session binding

Before any data-tool call, a session must bind to a project via an instance-level tool (always visible pre-bind):

| Tool | Effect |
|---|---|
| `maad_projects` | Lists declared projects — discover bind keys |
| `maad_use_project <name> [as=<role>]` | **Single mode** — `project=` auto-defaults on every subsequent call |
| `maad_use_projects [names...] [as=<role>]` | **Multi mode** — every subsequent call must pass `project=<name>` |
| `maad_current_session` | Inspect bind state |

**Binding is monotonic and terminal.** `maad_use_project(s)` is one-shot:
- Second call (including re-binding to the same project) returns `SESSION_ALREADY_BOUND`.
- You cannot escalate single → multi mid-session.
- Rebinding requires disconnect + reconnect.

Default to multi mode unless you are certain the session touches exactly one project.

### How roles are assigned

Roles are **server-assigned ceilings**. An agent never sets its own role — it can only accept a downgrade via `as=<role>` at bind time.

- **`instance.yaml` per-project `role:`** — set by the operator. This is the absolute ceiling for the project. Cannot be exceeded by any path.
- **`_auth/tokens.yaml` token caps** (HTTP only) — set by admin at token issuance. Per-token global role + per-project caps. Tokens are immutable; capability changes require revoke + reissue.
- **`as=<role>` at bind time** — agent-controlled, **downgrade only**. `as=admin` when the ceiling is `reader` fails `ROLE_UPGRADE_DENIED`.

**Effective role composition:**
- stdio: `min(project ceiling, as= requested)`
- HTTP: `min(project ceiling, token cap, as= requested)` — three-cap min rule, enforced on every tool call.

### Isolation & escalation

- `instance.yaml` and `_auth/tokens.yaml` are filesystem-only artifacts. No MCP tool can read or modify them.
- Admin-tier MCP tools (`maad_issue_token`, `maad_revoke_token`, `maad_rotate_token`) require admin on **every** bound project. Reader/writer sessions cannot reach them.
- An admin session cannot issue a token that exceeds the instance project ceiling.
- Token records are append-only with revocation — never upgraded in place.
- Under stdio, the host machine's filesystem permissions are the trust boundary (role enforcement is advisory). Under HTTP, the token registry is the trust boundary.

### Error taxonomy

| Code | When |
|---|---|
| `SESSION_UNBOUND` | data-tool call before any `maad_use_project(s)` |
| `SESSION_ALREADY_BOUND` | second `maad_use_project(s)` in the same session |
| `PROJECT_REQUIRED` | multi mode call missing `project=` |
| `PROJECT_NOT_WHITELISTED` | multi mode `project=` outside the whitelist |
| `PROJECT_UNKNOWN` | name not in `instance.yaml` |
| `INSUFFICIENT_ROLE` | tool requires higher role than session's effective role |
| `ROLE_UPGRADE_DENIED` | `as=` requests higher role than ceiling |
| `INSTANCE_CONFIG_INVALID` | startup-only; server refuses to start |
| `TOKEN_ROLE_ABOVE_GLOBAL` | token issuance: per-project role exceeds global |
| `TOKEN_PROJECT_FORBIDDEN` | token presented for a project outside its allowlist |

## Remote / hosted deployment

MAADb serves over HTTP/SSE for multi-session hosted deployments. One process handles many concurrent client sessions with per-agent token auth at the handshake, concurrent reads, polling delta ([`maad_changes_since`](docs/change-feed.md)), live push notifications, and an unauthenticated `/healthz` liveness probe. TLS terminated upstream at a reverse proxy.

Generate a token from the CLI (plaintext printed ONCE; server stores only the SHA-256 hash):

```bash
node dist/cli.js --instance /path/to/instance.yaml auth issue-token \
  --role=admin --name='primary-gateway' --projects='*' --agent=agt-gateway
# → maad_pat_<32hex> on stdout
```

Clients present that plaintext as `Authorization: Bearer <token>` on every HTTP request. Start the server:

```bash
node dist/cli.js --instance /path/to/instance.yaml serve \
  --transport http --http-host 127.0.0.1 --http-port 7733
```

Hot-reload tokens + instance config on edits: `sudo systemctl reload maad` (or `docker compose kill -s SIGHUP maad`). Rotate tokens via `maad auth rotate-token --id=tok-<id>`; revoke via `maad auth revoke-token --id=tok-<id>`. Full auth primitives: [`docs/archive/0.7.0-scoped-auth.md`](docs/archive/0.7.0-scoped-auth.md).

Deployment guides:

- [systemd + nginx (bare metal)](docs/deploy/systemd.md)
- [Docker + traefik](docs/deploy/docker.md)
- [Change feed — polling patterns + cadence](docs/change-feed.md)

## Access roles

MCP roles control what tools an agent can use. Ceiling set per project in `instance.yaml`; assignment mechanics and three-cap composition detailed in [How roles are assigned](#how-roles-are-assigned).

| Role | Tools | Use case |
|------|-------|----------|
| `reader` (default) | scan, summary, describe, get, query, search, related, schema, aggregate, join, verify, changes_since, history, audit | Read-only agents, reporting, analysis |
| `writer` | reader + create, update, validate, bulk_create, bulk_update | Standard agents that read and write records |
| `admin` | writer + delete, reindex, reload, health, backup, bulk_delete, delete_where, purge_soft_deleted, repair_where | Project setup, schema changes, maintenance, cleanup |

## Project layout

A MAADb project is a directory. `maad init <dir>` scaffolds the structure:

```
my-project/
  _registry/                      # Type definitions (YAML)
    object_types.yaml
  _schema/                        # Field schemas per type (YAML)
    case.v1.yaml
  _backend/                       # SQLite index — gitignored, rebuildable
    maad.db
  _import/                        # Drop zone for raw markdown imports
  _skills/                        # Agent skill files (architect, import, etc.)
  MAAD.md                         # Generated: stable agent operating instructions
  CLAUDE.md                       # Generated: MCP-first agent workflow guide
  <type-dirs>/                    # Record files — one directory per type
    cas-2026-001.md
```

**Convention:** `_` prefix = engine-managed (don't hand-edit unless you know what you're doing). Every other directory holds records.

**Record directories are type-declared, not hardcoded.** Each type in `_registry/object_types.yaml` declares its own `path:` — e.g. `cases/`, `clients/`, `data/cases/`, whatever you prefer. The architect skill picks a layout that fits the data shape.

## MCP tools

All tools return `{ ok: true, data: {...} }` or `{ ok: false, errors: [...] }`. Call `maad_schema <type>` for full field definitions before writing.

**Discover:** `maad_scan`, `maad_summary`, `maad_describe`, `maad_schema`
**Read:** `maad_get`, `maad_query`, `maad_search`, `maad_related`, `maad_aggregate`, `maad_join`, `maad_verify`, `maad_find_orphans`, `maad_changes_since`, `maad_semantic_search`
**Write:** `maad_create`, `maad_update`, `maad_bulk_create`, `maad_bulk_update`, `maad_validate`
**Maintain:** `maad_delete`, `maad_reindex`, `maad_reload`, `maad_health`, `maad_history`, `maad_audit`
**Recovery anchors (0.7.10+):** `maad_backup` — annotated git tags as snapshot points.
**Cleanup (0.7.10+ admin, confirm-contract governed):** `maad_bulk_delete`, `maad_delete_where`, `maad_repair_where`, `maad_purge_soft_deleted` — destructive ops are dry-run by default; pass `confirm: true` to mutate. `maxRecords` cap default 100 / ceiling 1000.
**Live updates (0.6.11+):** `maad_subscribe`, `maad_unsubscribe` — push notifications on durable writes.
**Instance admin:** `maad_instance_reload`, `maad_subscriptions`.
**Auth admin (0.7.0+):** `maad_issue_token`, `maad_revoke_token`, `maad_rotate_token`, `maad_list_tokens`, `maad_show_token`.

In multi-project mode, session tools are always available pre-bind: `maad_projects`, `maad_use_project`, `maad_use_projects`, `maad_current_session`.

### Semantic retrieval (0.8.0, opt-in)

`maad_semantic_search` adds meaning-based retrieval over record bodies, indexed per block, with a 3-mode dial:

- **`exact`** — lexical BM25 only. Deterministic, touches no model. Best for known-item lookup.
- **`semantic`** — vector KNN over embeddings. Best for free-form / exploratory research.
- **`hybrid`** — both legs fused via Reciprocal Rank Fusion (rank-based, scale-free). Balanced.

The agent selects the mode, and that choice lands in the audit trail — the engine never silently auto-fuses, preserving the determinism contract. Results roll up to documents (best-matching block + snippet); one ranked list out.

Off by default — set `MAAD_SEMANTIC_ENABLE=1`. Embeddings are derived and rebuildable (canonical source stays markdown), generated async-on-write so the deterministic write/commit path is unchanged. The embedding provider is pluggable: inject one from the host, or env-construct (`MAAD_EMBED_PROVIDER=openai`, `MAAD_EMBED_MODEL`, `MAAD_OPENAI_API_KEY`). With no provider, `semantic`/`hybrid` degrade to the lexical leg (flagged in `_meta.degraded`); `exact` always works. After enabling on an existing project, run `maad reindex --embeddings` to build the index. `maad_health.embeddings` reports provider/model/dim, queue depth, embedded vs indexed blocks, and failures.

The vector store is `sqlite-vec` (in the same SQLite file); the lexical leg is FTS5. `exact` needs neither a model nor a key.

## Agent boot flow

1. Agent reads `MAAD.md` → stable operating instructions
2. Agent runs `maad_summary` → live project snapshot
3. If empty project → reads `_skills/architect-core.md`, enters Architect mode
4. If live project → uses MCP tools for normal operations

## Current state

**Current:** v0.7.17 — read-path performance + validation correctness: covering indexes and a sort-index-driven query path keep filtered + sorted queries fast as the corpus grows, and per-document validity makes `maad_summary` / `maad_validate` an uncapped SQL count instead of a per-call file scan.

Recent shipped scope:
- **0.7.16** — Dependency security wave: simple-git 3.36.0 (high-severity advisory) with engine-side env hardening, js-yaml 4.2.0 version-independent serializer quoting, better-sqlite3 12.10.0; zero `npm audit` findings
- **0.7.15** — `maad version` command, CI on every push/PR (Ubuntu + Windows), LF line-ending enforcement, MAADb brand sweep, packaging hardening
- **0.7.14** — Correctness patch from a full engine audit: CRLF/BOM-tolerant writes, merged git child environment, numeric sort ordering, composite filters on join/verify, pagination guards, pathspec-scoped audit commits
- **0.7.13** — Per-document index-time memory guards (annotation cap + byte backstop) so one pathological document can't exhaust the engine process
- **0.7.12** — `maad_query` sort contract (`UNSUPPORTED_SORT_FIELD` instead of silent NULL ordering), engine-stamped `createdAt`, file-path canonicalization
- **0.7.11** — `maad_search` rejects unknown primitives up front (`INVALID_PRIMITIVE`)
- **0.7.10** — Integrity & cleanup: `maad_verify mode: 'integrity'`, `maad_backup` snapshots, destructive cleanup primitives under the confirm contract, memory-pressure observability, pino write-body redaction
- **0.7.5–0.7.8** — Unix socket transport, schema-cache coherence, write-path security hardening, Node 24 baseline
- **0.7.0–0.7.4** — Scoped auth & identity, agent-first aggregates, reindex schema-change detection

See [Version.md](Version.md) for the full release history and forward plan.

## Stack

- TypeScript strict, Node.js 24+ (current Active LTS)
- 6 production dependencies: `better-sqlite3`, `gray-matter`, `js-yaml`, `simple-git`, `@modelcontextprotocol/sdk`, `pino`. Plus one **optional** dependency `sqlite-vec` (semantic retrieval) — lazily loaded only when `MAAD_SEMANTIC_ENABLE` is on; absent or failed to load ⇒ semantic disabled, engine unaffected
- 1063 tests, Vitest — run on every push/PR across Ubuntu and Windows
- MIT license, pre-1.0, actively developed

## License

MIT — see [LICENSE](LICENSE).
