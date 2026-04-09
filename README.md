# MAAD — Markdown As A Database

A lightweight engine that treats markdown files as the canonical data store, builds a queryable index, and gives LLMs deterministic read/write access. SQLite is a rebuildable index — delete it and reconstruct from markdown in one pass.

## Why

Traditional databases capture fragments — enough to run a query or generate a report, but not enough to explain *why* something happened. Markdown carries the full narrative: who, what, when, where, how, and why. MAAD indexes it so LLMs can query structure first and open full context second.

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
git clone https://github.com/patchnetluis/maad.git
cd maad
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

**Any MCP-compatible agent** — MAAD uses stdio transport. The command is:

```bash
node /path/to/maad/dist/cli.js --project /path/to/project serve --role <reader|writer|admin>
```

**Environment variables** — useful for container deployments and OpenClaw SecretRefs:

| Variable | Equivalent flag | Example |
|----------|----------------|---------|
| `MAAD_PROJECT` | `--project` | `/data/my-project` |
| `MAAD_ROLE` | `--role` | `admin` |
| `MAAD_PROV` | `--prov` | `on` |

Flags take precedence over env vars. Env vars take precedence over defaults.

### Step 4 — Connect and build

After wiring MCP, restart your agent session. The agent will see `maad.*` tools. From there:

1. Agent reads `MAAD.md` → sees this is a MAAD project
2. Agent runs `maad.summary` → detects empty project
3. Agent reads `_skills/architect-core.md` → enters Architect mode
4. Agent designs schema based on your goal, deploys the database

Tell the agent what you want: *"Set up a CRM for my law firm"*, *"Index my research papers for querying"*, *"Create a persistent memory store for this agent."* The Architect handles the rest.

## Access Roles

MCP roles control what tools an agent can use. Set via `--role` flag at server startup.

| Role | Tools | Use case |
|------|-------|----------|
| `reader` (default) | scan, summary, describe, get, query, search, related, schema, aggregate, join, history, audit | Read-only agents, reporting, analysis |
| `writer` | reader + create, update, validate, bulk_create, bulk_update | Standard agents that read and write records |
| `admin` | writer + delete, reindex, reload, health | Project setup, schema changes, maintenance |

### Recommended workflow

The MCP `--role` flag maps to a typical admin/user split. For initial setup, use `--role admin`. After the project is operational, connect additional agents with scoped roles (`reader` or `writer`).

Today this is trust-based — roles control which tools are visible, but agents with filesystem access can bypass MCP. True enforcement comes with remote MCP transport (roadmap 0.9.0).

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

Each project gets its own MCP server. No cross-project routing — projects are independent.

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
| `maad.scan` | Analyze raw markdown — no registry needed |
| `maad.summary` | **Start here.** Types, counts, sample IDs, object inventory |
| `maad.describe` | Project overview: types, doc counts, primitives |
| `maad.schema` | Field definitions for a type |

### Read
| Tool | What it does |
|------|-------------|
| `maad.get` | Read a record (hot/warm/cold/full tiers) |
| `maad.query` | Find documents by type, filters, and field projection |
| `maad.search` | Cross-document object search |
| `maad.related` | Connected documents via ref traversal |
| `maad.aggregate` | Count/sum/avg/min/max grouped by field |
| `maad.join` | Query + follow refs + project fields from both sides |

### Write
| Tool | What it does |
|------|-------------|
| `maad.create` | Create a new record |
| `maad.update` | Modify fields or append to body |
| `maad.bulk_create` | Create multiple records in one call |
| `maad.bulk_update` | Update multiple records in one call |
| `maad.validate` | Check record(s) against schema |

### Maintain
| Tool | What it does |
|------|-------------|
| `maad.delete` | Remove a record |
| `maad.reindex` | Rebuild index from markdown |
| `maad.reload` | Reload registry + schemas without restart |
| `maad.health` | Engine status and diagnostics |
| `maad.history` | Git history for a document |
| `maad.audit` | Project-wide activity log |

## Agent Boot Flow

1. Agent reads `MAAD.md` → stable operating instructions
2. Agent runs `maad.summary` → live project snapshot
3. If empty project → reads `_skills/architect-core.md`, enters Architect mode
4. If live project → uses MCP tools for normal operations

## Stack

- TypeScript strict, Node.js 22+ (tested on v24)
- 4 production dependencies: `better-sqlite3`, `gray-matter`, `simple-git`, `@modelcontextprotocol/sdk`
- 266 tests, Vitest
- See [FRAMEWORK.md](FRAMEWORK.md) for data doctrine, tier model, and engine design principles

## Current State

**v0.2.10** — MCP server live, query projection, aggregation, cross-ref joins, bulk ops, provenance flag, read-back verification, summary warnings, env var config. 266 tests passing.

## Roadmap

| Version | What |
|---------|------|
| ~~0.2.x~~ | ~~MCP server, production hardening, read path improvements~~ — **shipped** |
| 0.3.0 | LLM evaluation — benchmarks, multi-model testing |
| 0.3.5 | Deployment workflow — deploy skill, scaffolding, MCP config generation |
| 0.4.0 | Import workflow — inbox pattern, duplicate detection, readonly types |
| 0.5.0 | Provenance + admin tooling |
| 0.6.0 | Query power — FTS5, fuzzy entity matching |
| 0.7.0 | Object attributes — user-defined tags, YAML-stored |
| 0.8.0 | npm package prep |
| 0.9.0 | Remote MCP — HTTP/SSE transport, per-connection roles, hosted deployment |
| 1.0.0 | Stable release — API locked, npm published |

## License

MIT
