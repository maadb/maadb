# MAADB — Markdown As A Database

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/typescript-strict-blue.svg)](tsconfig.json)
[![Tests](https://img.shields.io/badge/tests-575%20passing-brightgreen.svg)](tests)
[![Version](https://img.shields.io/badge/version-0.6.8-purple.svg)](Version.md)

> **Your data stays in markdown. The engine makes it queryable.**

MAADB treats markdown files as the canonical data store, not the presentation layer. YAML frontmatter defines structure, inline annotations extract entities, headings create addressable sections, and the engine builds a queryable pointer-only index over the lot — then serves everything to LLM agents through MCP.

Designed for document-centric data where structured fields and narrative context need to live together in the same record.

## Why MAADB

- **Markdown is canonical.** No impedance mismatch between your records and your view of them. Open any file in any editor — everything is human-readable.
- **Git is the audit trail.** Every write is a commit. `maad_history` shows full provenance for any document.
- **LLM-native.** MCP server ships with 22+ tools for discovery, read, write, and maintenance. Designed for agent workflows from the ground up.
- **Schema-enforced, not schema-heavy.** YAML schemas declare types, relationships, and precision contracts. Enforcement fires on write, never on read — historical data stays untouched when contracts tighten.
- **Pointer-only index.** SQLite stores file pointers and extracted object references. Content always reads from markdown. Index is rebuildable from source; never load-bearing.
- **Concurrent-safe.** FIFO write mutex, idempotency keys, stale-lock recovery, rate limiting, graceful shutdown. Production-hardened.

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

See [FRAMEWORK.md](FRAMEWORK.md) for data doctrine, tier model, and engine design principles.

## Quick start

```bash
git clone https://github.com/maadb/maadb.git
cd maadb
npm install && npm run build
```

Create a project directory anywhere, then wire up MCP in your agent.

**Claude Code** (`.mcp.json` in the project directory):

```json
{
  "mcpServers": {
    "maad": {
      "command": "node",
      "args": [
        "/absolute/path/to/maadb/dist/cli.js",
        "--project", "/absolute/path/to/my-project",
        "serve",
        "--role", "admin"
      ]
    }
  }
}
```

Same shape for Claude Desktop (`claude_desktop_config.json`) and OpenClaw. Any MCP-compatible agent works — stdio is the default, HTTP/SSE is available since 0.5.0.

Restart your agent. The agent detects an empty project and enters **Architect mode** to design the schema based on your goal:

> *"Set up a CRM for my law firm."*
> *"Index my research papers for querying."*
> *"Create a persistent memory store for this agent."*

The Architect skill handles type discovery, schema design, registry creation, and deployment. From there, any agent with an MCP connection can read and write records.

## Remote / hosted deployment

MAADB serves over HTTP/SSE for multi-session hosted deployments. One process handles many concurrent client sessions with bearer-token auth at the handshake, concurrent reads, polling delta ([`maad_changes_since`](docs/change-feed.md)), and an unauthenticated `/healthz` liveness probe. TLS terminated upstream at a reverse proxy.

```bash
MAAD_AUTH_TOKEN=$(openssl rand -base64 48 | tr -d '=' | tr '+/' '-_') \
node dist/cli.js --instance /path/to/instance.yaml serve \
  --transport http --http-host 127.0.0.1 --http-port 7733
```

Deployment guides:

- [systemd + nginx (bare metal)](docs/deploy/systemd.md)
- [Docker + traefik](docs/deploy/docker.md)
- [Change feed — polling patterns + cadence](docs/change-feed.md)

## Access roles

MCP roles control what tools an agent can use. Set via `--role` at server startup, or in `instance.yaml` per project.

| Role | Tools | Use case |
|------|-------|----------|
| `reader` (default) | scan, summary, describe, get, query, search, related, schema, aggregate, join, verify, changes_since, history, audit | Read-only agents, reporting, analysis |
| `writer` | reader + create, update, validate, bulk_create, bulk_update | Standard agents that read and write records |
| `admin` | writer + delete, reindex, reload, health | Project setup, schema changes, maintenance |

Under stdio, roles are trust-based — agents with filesystem access can bypass MCP. Under HTTP transport, the bearer token authenticates the caller and the role attached to the project binding governs the visible tool set. Per-token role tiers are on the roadmap (0.6.0).

## Project layout

```
my-project/
  _registry/                      # Type definitions (YAML)
    object_types.yaml
  _schema/                        # Field schemas per type (YAML)
    client.v1.yaml
  _backend/                       # Derived index — gitignored, rebuildable
    maad.db
  _inbox/                         # Raw files for import — drop zone
  _skills/                        # Agent skill files (architect, import, etc.)
  data/                           # All records live here
    clients/                      #   One folder per registered type
      cli-acme.md
    cases/
      cas-2026-001.md
  MAAD.md                         # Generated: agent operating instructions
```

**Convention:** `_` prefix = engine-managed. `data/` = your records. Records never live at the project root.

## Project archetypes

MAADB supports different project patterns. The Architect skill guides schema design based on the archetype.

| Archetype | Data flow | Examples |
|-----------|-----------|---------|
| **Living database** | Read + write, ongoing records | CRM, job tracker, case management |
| **Static catalog** | Import once, query often | Research papers, book collection, product catalog |
| **Accumulation log** | Append-heavy, time-series | Expense tracker, meeting notes, daily logs |
| **Analysis project** | Import + cross-reference | Historical records, competitive research, audit corpus |
| **Agent memory** | Agent-written, agent-read | Preferences, learned patterns, project context |

## MCP tools

All tools return `{ ok: true, data: {...} }` or `{ ok: false, errors: [...] }`. Call `maad_schema <type>` for full field definitions before writing.

**Discover:** `maad_scan`, `maad_summary`, `maad_describe`, `maad_schema`
**Read:** `maad_get`, `maad_query`, `maad_search`, `maad_related`, `maad_aggregate`, `maad_join`, `maad_verify`, `maad_changes_since`
**Write:** `maad_create`, `maad_update`, `maad_bulk_create`, `maad_bulk_update`, `maad_validate`
**Maintain:** `maad_delete`, `maad_reindex`, `maad_reload`, `maad_health`, `maad_history`, `maad_audit`

In multi-project mode, session tools are always available pre-bind: `maad_projects`, `maad_use_project`, `maad_use_projects`, `maad_current_session`.

## Agent boot flow

1. Agent reads `MAAD.md` → stable operating instructions
2. Agent runs `maad_summary` → live project snapshot
3. If empty project → reads `_skills/architect-core.md`, enters Architect mode
4. If live project → uses MCP tools for normal operations

## Current state

**v0.6.8 — Gateway Session Pinning.** HTTP transport honors a new `X-Maad-Pin-Project: <name>` header at MCP `initialize` — the session is bound to the named project synchronously before any tool call reaches a handler, and any subsequent `maad_use_project` / `maad_use_projects` attempt rejects with a new `SESSION_PINNED` error. Enables trusted-gateway multi-tenant hosting patterns (per-user sub-projects under one engine process) without requiring the gateway to parse MCP JSON-RPC. Fail-safe: absent header = identical behavior to 0.6.7; stdio is untouched. Builds on the 0.6.7 precision contract and the 0.5.0 remote transport. 575 tests passing.

See [Version.md](Version.md) for full release history and [ROADMAP.md](ROADMAP.md) for the path to 1.0.

## Stack

- TypeScript strict, Node.js 22+ (tested on v24)
- 6 production dependencies: `better-sqlite3`, `gray-matter`, `js-yaml`, `simple-git`, `@modelcontextprotocol/sdk`, `pino`
- 575 tests, Vitest
- MIT license, pre-1.0, actively developed

## License

MIT — see [LICENSE](LICENSE).
