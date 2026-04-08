# MAAD — Markdown As A Database

A lightweight engine that treats markdown files as the canonical data store, builds a queryable index, and gives LLMs deterministic read/write access.

Markdown is the source of truth. YAML is the interface language. SQLite is a rebuildable index — delete it and reconstruct from markdown in one pass. Nothing is lost.

## Why

Traditional databases capture fragments — enough to run a query or generate a report, but not enough to explain *why* something happened. Markdown carries the full narrative: who, what, when, where, how, and why. MAAD indexes it so LLMs can query structure first and open full context second.

## How it works

```
Markdown files (canonical records)
  -> YAML registry + schemas (structure definitions)
  -> 6-stage pipeline (parse, validate, extract, materialize)
  -> SQLite index (pointer-only — no data stored, just pointers)
  -> CLI + MCP server (12 reader / 17 writer / 21 admin tools)
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

Frontmatter = structured fields. Headings = addressable sections. `[[type:value|label]]` = inline annotations extracted and indexed by the engine. 11 extraction primitives: `entity`, `date`, `duration`, `amount`, `measure`, `quantity`, `percentage`, `location`, `identifier`, `contact`, `media`.

## Setup

```bash
npm install && npm run build
```

### Create a project

```bash
maad init my-project
```

Creates: `_registry/`, `_schema/`, `_backend/`, `_import/`, `.gitignore`, `MAAD.md`

### Connect an LLM agent

**Claude Desktop / VS Code** — add to MCP settings:
```json
{
  "mcpServers": {
    "maad": {
      "command": "node",
      "args": ["/path/to/maad/dist/cli.js", "--project", "/path/to/project", "serve", "--role", "writer"]
    }
  }
}
```

**CLI** (testing / debugging):
```bash
maad serve --project ./my-project --role writer
```

### Onboarding data

The agent handles everything after files are staged in `_import/`:

```
1. Files placed in _import/       (by agent, API, human, or any source)
2. Agent: scan _import/            → corpus patterns, document families
3. Agent: creates _registry + _schema from scan output
4. Agent: adds frontmatter, moves files to type folders
5. Agent: reindex --force          → index built
6. Agent: summary                  → oriented, ready to work
```

`scan` works at two levels:
- **`scan <file.md>`** — structural read of one document
- **`scan <dir/>`** — corpus-level patterns (recurring fields, headings, document families)

## Project layout

```
my-project/
  _registry/                      # Engine config: type definitions
    object_types.yaml
  _schema/                        # Engine config: field schemas per type
    client.v1.yaml
  _backend/                       # Derived index (gitignored)
    maad.db
  _import/                        # Staging area for raw files (gitignored)

  clients/                        # Records — one folder per registered type
    cli-acme.md
  cases/
    cas-2026-001.md

  MAAD.md                         # Generated: LLM operating instructions
  SCHEMA.md                       # Generated: data reference
```

**Convention:** `_` prefix = engine-managed. No prefix = your data. Root `.md` = generated docs.

## Commands

### Discover
| Command | What it does |
|---------|-------------|
| `scan <file\|dir>` | Analyze raw markdown — no registry needed |
| `summary` | **Start here.** Types, counts, sample IDs, object inventory |
| `describe` | Project overview: types, doc counts, primitives |

### Read
| Command | What it does |
|---------|-------------|
| `get <id> hot` | Frontmatter only (cheapest read) |
| `get <id> warm <block>` | Frontmatter + one section |
| `get <id> cold` | Full document body (expensive) |
| `get <id> full` | Resolved record: refs, objects, related docs |
| `query <type> [--filter k=v]` | Find documents by type and filters |
| `search <primitive> [--doc id]` | Cross-document object search |
| `related <id> [direction]` | Connected documents |
| `schema <type>` | Field definitions for a type |

### Write
| Command | What it does |
|---------|-------------|
| `create <type> --field k=v` | Create a new record |
| `update <id> --field k=v` | Update frontmatter fields |
| `update <id> --append "text"` | Append to document body |

### Maintain
| Command | What it does |
|---------|-------------|
| `validate [id]` | Validate against schemas |
| `reindex [--force]` | Rebuild index from markdown |
| `history <id>` | Git history for a document |
| `audit [--since date]` | Project-wide activity |

## MCP Server

Native LLM tool access via Model Context Protocol. Role-based access, stdio transport. Provenance mode (`--prov on|detail`) for source attribution.

| Role | Tools | Count |
|------|-------|-------|
| reader (default) | scan, summary, describe, get, query, search, related, schema, aggregate, join, history, audit | 12 |
| writer | reader + create, update, validate, bulk_create, bulk_update | 17 |
| admin | writer + delete, reindex, reload, health | 21 |

All tools return `{ ok: true, data: {...} }` or `{ ok: false, errors: [...] }`.

## LLM boot flow

1. Read `MAAD.md` — stable operating instructions
2. Run `summary` — live project snapshot
3. Use commands as needed

## Stack

- TypeScript strict, Node.js 18+
- 4 production dependencies: `better-sqlite3`, `gray-matter`, `simple-git`, `@modelcontextprotocol/sdk`
- 211 tests, Vitest
- See [FRAMEWORK.md](FRAMEWORK.md) for data doctrine, tier model, and engine design principles

## Current state

**v0.2.5** — Read path improvements, query projection, aggregation, cross-ref joins, bulk ops, provenance flag. 21 admin / 17 writer / 12 reader tools. 260 tests.

## Roadmap

| Version | What |
|---------|------|
| ~~0.2.x~~ | ~~MCP server, production hardening, read path improvements~~ — **shipped** |
| 0.3.0 | LLM evaluation + bulk ops — maadb-demo, benchmarks |
| 0.4.0 | Provenance + admin tooling |
| 0.5.0 | Query power — FTS5, fuzzy entity matching |
| 0.6.0 | Object attributes — user-defined tags, YAML-stored |
| 0.7.0 | Multi-project MCP |
| 1.0.0 | Stable release — API locked, npm published |

## License

MIT
