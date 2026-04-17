# MAADB — Markdown As A Database

A database engine that treats markdown files as canonical records and provides deterministic read/write access through a structured interface.

Markdown remains the source of truth, while schemas and indexing make records queryable, linkable, and easier to work with programmatically.

It is designed for document-centric data where structured fields and narrative context need to live together in the same record.

## How it works

```
Markdown files (your data)
  -> YAML registry + schemas (define structure)
  -> Engine (parse, validate, extract, index)
  -> SQLite (pointer-only query index)
  -> MCP server (LLM agent interface)
```

### Record format

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

Three layers: frontmatter for structured fields, headings for addressable sections, `[[type:value|label]]` annotations for inline entities extracted and indexed by the engine.

## Deployment

MAAD is designed for LLM agents. The typical deployment is: clone the engine, create a project, wire up MCP, and let an agent build and operate the database.

### Prerequisites

- Node.js 22+ (tested on v24)
- npm
- Git (required — MAAD uses git for audit trail)

### Step 1 — Install the engine

```bash
git clone https://github.com/patchnetluis/maadb.git
cd maadb
npm install && npm run build
```

### Step 2 — Create a project

A project is a directory with a `--project` path passed to the MCP server. It can live anywhere. You only need to create the directory — the agent handles the internal structure (`_registry/`, `_schema/`, `data/`, etc.) via the Architect skill after MCP is connected.

```bash
mkdir my-project
```

### Step 3 — Wire up MCP

The MCP server connects an LLM agent to your project. Configuration depends on your platform.

**Claude Code** — add to `.mcp.json` in the project directory:

```json
{
  "mcpServers": {
    "maad": {
      "command": "node",
      "args": [
        "/absolute/path/to/maad/dist/cli.js",
        "--project", "/absolute/path/to/my-project",
        "serve",
        "--role", "admin"
      ]
    }
  }
}
```

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "maad": {
      "command": "node",
      "args": [
        "/absolute/path/to/maad/dist/cli.js",
        "--project", "/absolute/path/to/my-project",
        "serve",
        "--role", "admin"
      ]
    }
  }
}
```

**OpenClaw** — register as an MCP server:

```bash
openclaw mcp set maad '{"command":"node","args":["/path/to/maad/dist/cli.js","--project","/path/to/my-project","serve","--role","admin"]}'
```

**Any MCP-compatible agent** — MAAD supports both stdio (default) and HTTP/SSE transports. The stdio command is:

```bash
node /path/to/maad/dist/cli.js --project /path/to/project serve --role <reader|writer|admin>
```

**Environment variables** — useful for container deployments and OpenClaw SecretRefs:

| Variable | Equivalent flag | Example |
|----------|----------------|---------|
| `MAAD_PROJECT` | `--project` | `/data/my-project` |
| `MAAD_INSTANCE` | `--instance` | `/data/instance.yaml` |
| `MAAD_ROLE` | `--role` | `admin` |
| `MAAD_PROV` | `--prov` | `on` |

Flags take precedence over env vars. Env vars take precedence over defaults.

### Remote MCP (HTTP/SSE)

Since 0.5.0 the engine also serves over HTTP. One process handles many concurrent client sessions with bearer-token auth at the handshake, concurrent reads, and a polling delta tool (`maad_changes_since`). stdio remains the default for local use.

```bash
MAAD_AUTH_TOKEN=$(openssl rand -base64 48 | tr -d '=' | tr '+/' '-_') \
node dist/cli.js --instance /path/to/instance.yaml serve \
  --transport http --http-host 127.0.0.1 --http-port 7733
```

Flags (all mirror `MAAD_*` env vars):

| Flag | Default | Purpose |
|------|---------|---------|
| `--transport <stdio\|http>` | `stdio` | Transport selection |
| `--http-host <host>` | `127.0.0.1` | Bind address (loopback = proxy-fronted) |
| `--http-port <port>` | `7733` | Bind port |
| `--auth-token <token>` | *required for http* | Bearer token (≥32 bytes recommended) |
| `--session-idle-ms <ms>` | `1800000` (30 min) | Idle session eviction threshold |
| `--http-max-body <bytes>` | `1048576` (1 MiB) | Max request body |
| `--trust-proxy` | `false` | Trust `X-Forwarded-For` first hop |
| `--http-headers-timeout <ms>` | `10000` | `node:http` headers timeout |
| `--http-request-timeout <ms>` | `60000` | `node:http` request timeout |
| `--http-keepalive-timeout <ms>` | `5000` | `node:http` keep-alive timeout |

Every request carries `Authorization: Bearer <token>`, validated constant-time. Missing/wrong token returns `401 UNAUTHORIZED` before any session state is created — unauthenticated callers cannot enumerate session IDs.

Unauthenticated `GET /healthz` returns `{ok:true}` when live, `{ok:false, errors:[{code:"SHUTTING_DOWN"}]}` with HTTP 503 during drain. Rich health (project names, doc counts, session telemetry) lives in the authenticated `maad_health` MCP tool — liveness ≠ health.

TLS is expected at a reverse proxy in front of the engine, not inside the process.

**Deployment guides:**
- [systemd + nginx (bare metal)](docs/deploy/systemd.md)
- [Docker + traefik](docs/deploy/docker.md)

### Step 4 — Connect and build

After wiring MCP, restart your agent session. The agent will see `maad_*` tools. From there:

1. Agent reads `MAAD.md` → sees this is a MAAD project
2. Agent runs `maad_summary` → detects empty project
3. Agent reads `_skills/architect-core.md` → enters Architect mode
4. Agent designs schema based on your goal, deploys the database

Tell the agent what you want: *"Set up a CRM for my law firm"*, *"Index my research papers for querying"*, *"Create a persistent memory store for this agent."* The Architect handles the rest.

## Access Roles

MCP roles control what tools an agent can use. Set via `--role` flag at server startup.

| Role | Tools | Use case |
|------|-------|----------|
| `reader` (default) | scan, summary, describe, get, query, search, related, schema, aggregate, join, verify, history, audit | Read-only agents, reporting, analysis |
| `writer` | reader + create, update, validate, bulk_create, bulk_update | Standard agents that read and write records |
| `admin` | writer + delete, reindex, reload, health | Project setup, schema changes, maintenance |

In multi-project mode (`--instance`), 4 additional session tools are always available pre-bind: `maad_projects`, `maad_use_project`, `maad_use_projects`, `maad_current_session`.

### Recommended workflow

The MCP `--role` flag maps to a typical admin/user split. For initial setup, use `--role admin`. After the project is operational, connect additional agents with scoped roles (`reader` or `writer`).

Under stdio, roles are trust-based — agents with filesystem access can bypass MCP. Under HTTP transport (since 0.5.0), the bearer token authenticates the caller and the role attached to the project binding governs the visible tool set. Per-connection role tiers driven by the token itself are on the roadmap (0.8.5).

### Multiple agents, one project

Each agent gets its own MCP config pointing at the same project with the appropriate role:

```json
{
  "mcpServers": {
    "maad-admin": {
      "command": "node",
      "args": ["...", "serve", "--role", "admin"]
    },
    "maad-user": {
      "command": "node",
      "args": ["...", "serve", "--role", "writer"]
    }
  }
}
```

### Multiple projects

Two options. Single-project: one MCP server per project (works today). Multi-project: one server, many projects, session-bound routing via `instance.yaml` (since 0.4.0).

**Single-project (per project, scoped role):**

```json
{
  "mcpServers": {
    "maad-crm": {
      "command": "node",
      "args": ["...", "--project", "/path/to/crm", "serve", "--role", "admin"]
    },
    "maad-research": {
      "command": "node",
      "args": ["...", "--project", "/path/to/research", "serve", "--role", "writer"]
    }
  }
}
```

**Multi-project (one server, whitelist per session):**

```yaml
# instance.yaml
name: my-instance
projects:
  - { name: crm,      path: /path/to/crm,      role: admin }
  - { name: research, path: /path/to/research, role: writer }
```

```json
{
  "mcpServers": {
    "maad": {
      "command": "node",
      "args": ["...", "--instance", "/path/to/instance.yaml", "serve"]
    }
  }
}
```

Agents call `maad_use_project <name>` (single mode) or `maad_use_projects [names...]` (multi mode) once per session before other tools.

## Project Layout

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

## Project Archetypes

MAAD supports different project patterns. The Architect skill (`_skills/architect-core.md`) guides schema design based on the archetype.

| Archetype | Data flow | Examples |
|-----------|-----------|---------|
| **Living database** | Read + write, ongoing records | CRM, job tracker, case management |
| **Static catalog** | Import once, query often | Research papers, book collection, product catalog |
| **Accumulation log** | Append-heavy, time-series | Expense tracker, meeting notes, daily logs |
| **Analysis project** | Import + cross-reference | Historical records, competitive research, audit corpus |
| **Agent memory** | Agent-written, agent-read | Preferences, learned patterns, project context |

## MCP Tools

All tools return `{ ok: true, data: {...} }` or `{ ok: false, errors: [...] }`.

### Discover
| Tool | What it does |
|------|-------------|
| `maad_scan` | Analyze raw markdown — no registry needed |
| `maad_summary` | **Start here.** Types, counts, sample IDs, object inventory |
| `maad_describe` | Project overview: types, doc counts, primitives |
| `maad_schema` | Field definitions for a type |

### Read
| Tool | What it does |
|------|-------------|
| `maad_get` | Read a record (hot/warm/cold/full tiers) |
| `maad_query` | Find documents by type, filters, and field projection |
| `maad_search` | Cross-document object search |
| `maad_related` | Connected documents via ref traversal |
| `maad_aggregate` | Count/sum/avg/min/max grouped by field |
| `maad_join` | Query + follow refs + project fields from both sides |
| `maad_verify` | Fact-check a field value or document count against the database |

### Write
| Tool | What it does |
|------|-------------|
| `maad_create` | Create a new record |
| `maad_update` | Modify fields or append to body |
| `maad_bulk_create` | Create multiple records in one call |
| `maad_bulk_update` | Update multiple records in one call |
| `maad_validate` | Check record(s) against schema |

### Maintain
| Tool | What it does |
|------|-------------|
| `maad_delete` | Remove a record |
| `maad_reindex` | Rebuild index from markdown |
| `maad_reload` | Reload registry + schemas without restart |
| `maad_health` | Engine status and diagnostics |
| `maad_history` | Git history for a document |
| `maad_audit` | Project-wide activity log |

## Agent Boot Flow

1. Agent reads `MAAD.md` → stable operating instructions
2. Agent runs `maad_summary` → live project snapshot
3. If empty project → reads `_skills/architect-core.md`, enters Architect mode
4. If live project → uses MCP tools for normal operations

## Stack

- TypeScript strict, Node.js 22+ (tested on v24)
- 5 production dependencies: `better-sqlite3`, `gray-matter`, `simple-git`, `@modelcontextprotocol/sdk`, `pino`
- 554 tests, Vitest
- See [FRAMEWORK.md](FRAMEWORK.md) for data doctrine, tier model, and engine design principles

## Current State

**v0.6.7** — Schema Precision Hints. Date fields can declare `store_precision` (engine-enforced minimum on write) and `display_precision` (consumer rendering hint). Enforcement fires at write-time only — reads, reindex, and audit paths never judge historical data. Non-breaking by default: `on_coarser: warn` surfaces drift via response `_meta.warnings[]` and ops log without blocking the write; `on_coarser: error` opts into strict rejection. `maad_validate includePrecision: true` scans historical records for precision drift without counting them invalid. Builds on the 0.5.0 remote MCP transport and 0.4.1 hardened engine. 554 tests passing.

## Roadmap

| Version | What |
|---------|------|
| ~~0.2.x~~ | ~~MCP server, production hardening, read path improvements~~ — **shipped** |
| ~~0.4.0~~ | ~~Multi-project routing — one MCP, many projects, session-bound mode~~ — **shipped** |
| ~~0.4.1~~ | ~~Production hardening — write mutex, idempotency, rate limit, logging, lifecycle, health~~ — **shipped** |
| ~~0.5.0~~ | ~~Remote MCP — HTTP/SSE transport, bearer auth, concurrent reads, `maad_changes_since`, deploy guides~~ — **shipped** |
| ~~0.6.7~~ | ~~Schema precision hints — `store_precision`/`display_precision`, warn-or-error contract, round-trip preservation, `maad_validate includePrecision`~~ — **shipped** |
| 0.5.1 | Deployment workflow — `_skills/deploy.md`, `maad init-instance`, platform-specific MCP config generation |
| 0.6.0 | Scoped auth & identity — per-token roles, token registry, audit identity attribution |
| 0.6.5 | Live notifications — `maad_subscribe`, SSE push on writes |
| 0.7.0 | npm package prep — `npx maad serve`, published to npm |
| 0.7.5 | Import workflow — `_inbox/`, duplicate detection, readonly types |
| 0.8.0 | LLM evaluation — multi-model testing, friction inventory, benchmarks |
| 0.8.5 | Provenance refinement + admin dashboard + `maad_export` |
| 0.8.7 | Storage backend abstraction (prep) — `StorageBackend` interface, extract git as `GitBackend` |
| 0.9.0 | Remote MCP hardening — per-token rate-limit policy, stress suite, metrics export |
| 0.9.5 | Query power — FTS5, fuzzy entity matching, compound filters |
| 0.9.7 | Object attributes — user-defined tags on extracted objects |
| 1.0.0 | Stable release — API locked, npm published |

## License

MIT
