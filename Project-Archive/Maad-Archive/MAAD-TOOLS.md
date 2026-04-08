# MAAD Tool Interface

> The primary interface for MAAD. Everything else is secondary.

MAAD is a tool for LLMs, not for humans. The markdown files are human-readable by design, but the operating interface — the way data gets created, queried, read, updated, and navigated — is the LLM tool surface. This document defines that surface as an MCP (Model Context Protocol) server specification.

The CLI (`maad init`, `maad parse`, etc.) exists for setup and debugging. The MCP server is how MAAD runs in production.

---

## MCP Server Identity

```json
{
  "name": "maad",
  "version": "0.1.0",
  "description": "Markdown Augmented Adaptive Database — treats markdown as the canonical database, builds a queryable index, and gives LLMs deterministic read/write access."
}
```

---

## Tool Categories

MAAD exposes five categories of tools:

| Category | Purpose | Tools |
|----------|---------|-------|
| **Discovery** | Understand what exists before acting | `describe`, `schema`, `inspect` |
| **CRUD** | Create, read, query, update, delete records | `create`, `get`, `find`, `update`, `delete` |
| **Navigation** | Traverse relationships and structure | `list_related`, `search_objects` |
| **Audit** | Version history, diffs, point-in-time reads | `history`, `diff`, `snapshot`, `audit` |
| **Maintenance** | Validate and rebuild | `validate`, `reindex` |

---

## Discovery Tools

These let the LLM understand the MAAD project before it starts working. An LLM should call `describe` first in any new session.

### maad.describe

Returns the full registry: all registered types, their schemas, and extraction primitives available.

```json
{
  "name": "maad.describe",
  "description": "List all registered document types, their schemas, and available extraction primitives. Call this first to understand what this MAAD project contains.",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "required": []
  }
}
```

**Response:**

```json
{
  "registry_types": [
    {
      "type": "client",
      "path": "clients/",
      "id_prefix": "cli",
      "schema": "client.v1",
      "doc_count": 12
    },
    {
      "type": "case",
      "path": "cases/",
      "id_prefix": "cas",
      "schema": "case.v1",
      "doc_count": 34
    }
  ],
  "extraction_primitives": ["entity", "date", "amount", "quantity", "location"],
  "total_documents": 87,
  "last_indexed": "2026-04-06T14:30:00Z"
}
```

### maad.schema

Returns the full schema definition for a registered type. The LLM uses this to know what fields are required, what formats are enforced, and what refs are valid before creating or updating a record.

```json
{
  "name": "maad.schema",
  "description": "Get the full schema definition for a registered document type. Returns required fields, field types, formats, enums, ref targets, and roles.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "doc_type": {
        "type": "string",
        "description": "The registered type name (e.g. 'client', 'case')"
      }
    },
    "required": ["doc_type"]
  }
}
```

**Response:**

```json
{
  "type": "case",
  "version": "v1",
  "required": ["doc_id", "title", "client", "status"],
  "fields": {
    "title": { "type": "string", "index": true },
    "client": { "type": "ref", "target": "client", "index": true },
    "primary_contact": { "type": "ref", "target": "contact", "index": true },
    "status": { "type": "enum", "values": ["open", "pending", "closed"], "index": true },
    "opened_at": { "type": "date", "role": "created_at", "format": "YYYY-MM-DD", "index": true },
    "priority": { "type": "enum", "values": ["low", "medium", "high"], "index": true }
  }
}
```

### maad.inspect

Returns engine record details for a single document — its extracted objects, block map, relationships, and validation state. This is a diagnostic/deep-read tool.

```json
{
  "name": "maad.inspect",
  "description": "Return engine internals for a document: extracted objects, block map, relationships, validation state, and file hash. Use for debugging or deep exploration.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "doc_id": {
        "type": "string",
        "description": "The document ID to inspect"
      }
    },
    "required": ["doc_id"]
  }
}
```

**Response:**

```json
{
  "doc_id": "cas-2026-001",
  "file_path": "cases/cas-2026-001.md",
  "file_hash": "a1b2c3d4",
  "doc_type": "case",
  "schema": "case.v1",
  "version": 3,
  "validation": { "valid": true, "errors": [] },
  "blocks": [
    { "id": "summary", "heading": "Contract Review Dispute", "lines": [14, 18] },
    { "id": "timeline", "heading": "Timeline", "lines": [20, 31] }
  ],
  "extracted_objects": [
    { "primitive": "date", "subtype": "date", "value": "2026-03-28", "label": "March 28, 2026", "source_line": 22 }
  ],
  "relationships": [
    { "type": "ref", "field": "client", "target": "cli-acme" },
    { "type": "ref", "field": "primary_contact", "target": "con-jane-smith" }
  ]
}
```

---

## CRUD Tools

### maad.create

Creates a new markdown file from schema rules. The engine generates the `doc_id`, writes the file with proper frontmatter and body, validates against the schema, and indexes immediately.

```json
{
  "name": "maad.create",
  "description": "Create a new markdown record. The engine assigns a doc_id, writes the file with YAML frontmatter and markdown body, validates against the schema, and indexes the document.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "doc_type": {
        "type": "string",
        "description": "A registered type from the registry (e.g. 'client', 'case')"
      },
      "fields": {
        "type": "object",
        "description": "Key-value pairs matching the schema's field definitions. Required fields must be present. Refs use target doc_ids. Enums must match allowed values."
      },
      "body": {
        "type": "string",
        "description": "Markdown body content. Can include [[type:value|label]] annotations and {{field}} value calls. If omitted, a default body is generated from the template."
      },
      "doc_id": {
        "type": "string",
        "description": "Optional. Override the auto-generated doc_id. Must use the correct id_prefix for the type."
      }
    },
    "required": ["doc_type", "fields"]
  }
}
```

**Response:**

```json
{
  "status": "created",
  "doc_id": "cli-acme",
  "file_path": "clients/cli-acme.md",
  "version": 1,
  "validation": { "valid": true, "errors": [] }
}
```

**Error (validation failure):**

```json
{
  "status": "rejected",
  "errors": [
    { "field": "status", "message": "Required field missing" },
    { "field": "priority", "message": "Value 'urgent' not in enum [low, medium, high]" }
  ]
}
```

### maad.get

Tiered read. The LLM specifies how deep it needs to go. Most queries should use `hot` or `warm` — `cold` is a full file read and costs the most tokens.

```json
{
  "name": "maad.get",
  "description": "Read a document at a specified depth. 'hot' returns frontmatter only (minimal tokens). 'warm' returns frontmatter plus a targeted block. 'cold' returns the full document.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "doc_id": {
        "type": "string",
        "description": "The document ID to read"
      },
      "depth": {
        "type": "string",
        "enum": ["hot", "warm", "cold"],
        "description": "Read depth. hot = frontmatter only. warm = frontmatter + targeted block. cold = full document."
      },
      "block": {
        "type": "string",
        "description": "Block ID or heading to retrieve (only used with depth 'warm'). Maps to a {#block_id} anchor or heading text."
      }
    },
    "required": ["doc_id", "depth"]
  }
}
```

**Response (hot):**

```json
{
  "doc_id": "cas-2026-001",
  "doc_type": "case",
  "depth": "hot",
  "frontmatter": {
    "title": "Contract Review Dispute",
    "client": "cli-acme",
    "primary_contact": "con-jane-smith",
    "status": "open",
    "opened_at": "2026-04-01",
    "priority": "high"
  }
}
```

**Response (warm):**

```json
{
  "doc_id": "cas-2026-001",
  "doc_type": "case",
  "depth": "warm",
  "frontmatter": { "..." : "..." },
  "block": {
    "id": "timeline",
    "heading": "Timeline",
    "content": "Initial issue raised on [[date:2026-03-28|March 28, 2026]].\n..."
  }
}
```

**Response (cold):**

```json
{
  "doc_id": "cas-2026-001",
  "doc_type": "case",
  "depth": "cold",
  "frontmatter": { "..." : "..." },
  "body": "# Contract Review Dispute\n\nDispute over delivery obligations...\n\n## Timeline\n\n..."
}
```

### maad.find

Queries the backend index. Returns document IDs and optionally hot-level metadata. Never reads raw markdown. This is the primary navigation tool — the LLM should `find` first, then `get` the specific documents it needs.

```json
{
  "name": "maad.find",
  "description": "Query the index for documents matching filters. Returns doc_ids and optionally frontmatter summaries. Never reads raw markdown files.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "doc_type": {
        "type": "string",
        "description": "Filter by registered type"
      },
      "filters": {
        "type": "object",
        "description": "Field-value conditions. Supports exact match for strings, refs, and enums. Supports range operators for dates and numbers: { 'opened_at': { 'gte': '2026-01-01', 'lt': '2026-04-01' } }"
      },
      "include_frontmatter": {
        "type": "boolean",
        "description": "If true, return hot-level frontmatter for each match. Default false (IDs only)."
      },
      "limit": {
        "type": "number",
        "description": "Max results to return. Default 50."
      },
      "offset": {
        "type": "number",
        "description": "Skip N results for pagination. Default 0."
      }
    },
    "required": []
  }
}
```

**Response (IDs only):**

```json
{
  "total": 3,
  "results": ["cas-2026-001", "cas-2026-003", "cas-2026-007"]
}
```

**Response (with frontmatter):**

```json
{
  "total": 3,
  "results": [
    {
      "doc_id": "cas-2026-001",
      "frontmatter": { "title": "Contract Review Dispute", "status": "open", "priority": "high" }
    },
    {
      "doc_id": "cas-2026-003",
      "frontmatter": { "title": "IP Licensing Review", "status": "open", "priority": "medium" }
    }
  ]
}
```

### maad.update

Updates fields and/or body of an existing document. Validates against the schema before writing. Reparses and reindexes after write.

```json
{
  "name": "maad.update",
  "description": "Update an existing document's frontmatter fields and/or markdown body. Validates against schema before writing. Reindexes after write.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "doc_id": {
        "type": "string",
        "description": "The document ID to update"
      },
      "fields": {
        "type": "object",
        "description": "Frontmatter fields to update. Only specified fields are changed; unspecified fields are preserved."
      },
      "body": {
        "type": "string",
        "description": "Replace the full markdown body. If omitted, the existing body is preserved."
      },
      "append_body": {
        "type": "string",
        "description": "Append markdown to the existing body instead of replacing it. Mutually exclusive with 'body'."
      },
      "version": {
        "type": "number",
        "description": "Optional. Expected current version for conflict detection. If provided and doesn't match, the write is rejected."
      }
    },
    "required": ["doc_id"]
  }
}
```

**Response:**

```json
{
  "status": "updated",
  "doc_id": "cas-2026-001",
  "version": 4,
  "changed_fields": ["status"],
  "validation": { "valid": true, "errors": [] }
}
```

**Error (version conflict):**

```json
{
  "status": "conflict",
  "doc_id": "cas-2026-001",
  "expected_version": 3,
  "actual_version": 4,
  "message": "Document was modified since last read. Re-read and retry."
}
```

### maad.delete

Soft delete by default — marks the document as deleted in the index and renames the file with a `_deleted` prefix. Hard delete removes the file entirely.

```json
{
  "name": "maad.delete",
  "description": "Delete a document. Soft delete (default) marks it deleted and renames the file. Hard delete removes the file.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "doc_id": {
        "type": "string",
        "description": "The document ID to delete"
      },
      "mode": {
        "type": "string",
        "enum": ["soft", "hard"],
        "description": "Deletion mode. Default 'soft'."
      }
    },
    "required": ["doc_id"]
  }
}
```

**Response:**

```json
{
  "status": "deleted",
  "doc_id": "note-2026-04-06-001",
  "mode": "soft",
  "file_path": "case-notes/_deleted_note-2026-04-06-001.md"
}
```

---

## Navigation Tools

### maad.list_related

Traverses relationships from a given document. Returns all documents linked by ref fields or inline mentions. The LLM uses this to walk the relationship graph without manually querying each type.

```json
{
  "name": "maad.list_related",
  "description": "List all documents related to a given document through ref fields, inline mentions, or reverse references. Optionally filter by relationship type.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "doc_id": {
        "type": "string",
        "description": "The document to find relationships for"
      },
      "relation_types": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Optional. Filter to specific doc_types (e.g. ['cases', 'contacts']). If omitted, returns all."
      },
      "direction": {
        "type": "string",
        "enum": ["outgoing", "incoming", "both"],
        "description": "Relationship direction. 'outgoing' = this doc references them. 'incoming' = they reference this doc. 'both' = all. Default 'both'."
      },
      "include_frontmatter": {
        "type": "boolean",
        "description": "If true, include hot-level frontmatter for each related doc. Default false."
      }
    },
    "required": ["doc_id"]
  }
}
```

**Response:**

```json
{
  "doc_id": "cli-acme",
  "related": {
    "outgoing": [
      { "doc_id": "con-jane-smith", "doc_type": "contact", "field": "primary_contact" }
    ],
    "incoming": [
      { "doc_id": "cas-2026-001", "doc_type": "case", "field": "client" },
      { "doc_id": "cas-2026-003", "doc_type": "case", "field": "client" },
      { "doc_id": "note-2026-04-06-001", "doc_type": "case_note", "via": "cas-2026-001" }
    ]
  }
}
```

### maad.search_objects

Searches the extracted object index directly. This queries across all documents for extraction primitives — entities, dates, amounts, locations — without knowing which documents they live in.

```json
{
  "name": "maad.search_objects",
  "description": "Search the extracted object index across all documents. Find all mentions of a person, date range, amount threshold, or location without knowing which documents contain them.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "primitive": {
        "type": "string",
        "enum": ["entity", "date", "amount", "quantity", "location"],
        "description": "The extraction primitive to search"
      },
      "subtype": {
        "type": "string",
        "description": "Optional subtype label filter (e.g. 'person', 'team', 'org')"
      },
      "value": {
        "type": "string",
        "description": "Exact value match (e.g. 'Officer Davis', '2026-03-28')"
      },
      "range": {
        "type": "object",
        "description": "Range filter for dates, amounts, quantities. { 'gte': '2026-01-01', 'lt': '2026-04-01' }"
      },
      "contains": {
        "type": "string",
        "description": "Substring match on value (e.g. 'Davis' matches 'Officer Davis')"
      },
      "limit": {
        "type": "number",
        "description": "Max results. Default 50."
      }
    },
    "required": ["primitive"]
  }
}
```

**Response:**

```json
{
  "total": 3,
  "results": [
    {
      "primitive": "entity",
      "subtype": "person",
      "value": "Officer Davis",
      "label": "Officer Davis",
      "doc_id": "report-investigation-001",
      "source_line": 16,
      "block": "summary"
    },
    {
      "primitive": "entity",
      "subtype": "person",
      "value": "Officer Davis",
      "label": "Davis",
      "doc_id": "report-investigation-001",
      "source_line": 22,
      "block": "summary"
    }
  ]
}
```

---

## Audit Tools

Git is the version control and audit layer. Every MAAD write auto-commits with a structured message. These tools give the LLM full traceability without raw git access.

### maad.history

Returns the commit history for a single document — every create, update, and delete, with structured metadata parsed from the commit messages.

```json
{
  "name": "maad.history",
  "description": "Get the version history for a document. Returns every change with action, fields modified, author, timestamp, and commit SHA. Backed by git log.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "doc_id": {
        "type": "string",
        "description": "The document ID to get history for"
      },
      "limit": {
        "type": "number",
        "description": "Max entries to return. Default 20."
      },
      "since": {
        "type": "string",
        "description": "Optional. ISO date or datetime. Only return history after this point."
      }
    },
    "required": ["doc_id"]
  }
}
```

**Response:**

```json
{
  "doc_id": "cas-2026-001",
  "total": 3,
  "history": [
    {
      "commit": "a1b2c3d",
      "action": "update",
      "detail": "fields:status",
      "summary": "status: open -> pending",
      "author": "system",
      "timestamp": "2026-04-06T15:00:00Z"
    },
    {
      "commit": "e4f5a6b",
      "action": "update",
      "detail": "body:append",
      "summary": "Added resolution block",
      "author": "system",
      "timestamp": "2026-04-05T11:30:00Z"
    },
    {
      "commit": "d4e5f6a",
      "action": "create",
      "detail": "",
      "summary": "Contract Review Dispute",
      "author": "system",
      "timestamp": "2026-04-01T09:00:00Z"
    }
  ]
}
```

### maad.diff

Shows what changed in a document between two versions. Returns structured frontmatter changes and a body diff.

```json
{
  "name": "maad.diff",
  "description": "Show what changed in a document between two commits. Returns structured frontmatter field changes and a unified body diff. Backed by git diff.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "doc_id": {
        "type": "string",
        "description": "The document ID to diff"
      },
      "from": {
        "type": "string",
        "description": "Starting commit SHA (older). Use a value from maad.history."
      },
      "to": {
        "type": "string",
        "description": "Ending commit SHA (newer). Defaults to current HEAD if omitted."
      }
    },
    "required": ["doc_id", "from"]
  }
}
```

**Response:**

```json
{
  "doc_id": "cas-2026-001",
  "from": "d4e5f6a",
  "to": "a1b2c3d",
  "frontmatter_changes": {
    "status": { "from": "open", "to": "pending" }
  },
  "body_diff": "@@ -14,3 +14,9 @@\n ## Timeline {#timeline}\n \n Initial issue raised on [[date:2026-03-28|March 28, 2026]].\n+\n+## Resolution {#resolution}\n+\n+Case closed on [[date:2026-03-15|March 15, 2026]] following client instruction.\n"
}
```

### maad.snapshot

Returns a document as it existed at a specific point in time. The LLM can reconstruct any prior state without modifying the current file.

```json
{
  "name": "maad.snapshot",
  "description": "Read a document as it existed at a specific commit or date. Returns the full document (frontmatter + body) from that point in time. Backed by git show.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "doc_id": {
        "type": "string",
        "description": "The document ID to read"
      },
      "at": {
        "type": "string",
        "description": "A commit SHA or ISO date. If a date, resolves to the last commit before that date."
      }
    },
    "required": ["doc_id", "at"]
  }
}
```

**Response:**

```json
{
  "doc_id": "cas-2026-001",
  "at": "2026-04-01T09:00:00Z",
  "commit": "d4e5f6a",
  "frontmatter": {
    "doc_id": "cas-2026-001",
    "doc_type": "case",
    "schema": "case.v1",
    "title": "Contract Review Dispute",
    "client": "cli-acme",
    "primary_contact": "con-jane-smith",
    "status": "open",
    "opened_at": "2026-04-01",
    "priority": "high"
  },
  "body": "# Contract Review Dispute {#summary}\n\nDispute over delivery obligations and late change requests.\n\n## Timeline {#timeline}\n\nInitial issue raised on [[date:2026-03-28|March 28, 2026]]."
}
```

### maad.audit

Returns a project-wide activity summary — which documents were changed, how many times, and by whom. The LLM uses this to understand recent activity without inspecting individual documents.

```json
{
  "name": "maad.audit",
  "description": "Get a project-wide activity summary. Returns which documents were changed, how many actions each had, and the last action details. Backed by git log with structured commit message parsing.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "since": {
        "type": "string",
        "description": "ISO date or datetime. Only include activity after this point."
      },
      "until": {
        "type": "string",
        "description": "Optional. ISO date or datetime. Only include activity before this point."
      },
      "doc_type": {
        "type": "string",
        "description": "Optional. Filter to a specific registered type."
      },
      "action": {
        "type": "string",
        "enum": ["create", "update", "delete"],
        "description": "Optional. Filter to a specific action type."
      },
      "limit": {
        "type": "number",
        "description": "Max documents to return. Default 50."
      }
    },
    "required": []
  }
}
```

**Response:**

```json
{
  "since": "2026-04-01T00:00:00Z",
  "total_actions": 14,
  "documents_affected": 6,
  "results": [
    {
      "doc_id": "cas-2026-001",
      "doc_type": "case",
      "actions": 3,
      "last_action": "update",
      "last_summary": "status: open -> pending",
      "last_author": "system",
      "last_timestamp": "2026-04-06T15:00:00Z"
    },
    {
      "doc_id": "cli-acme",
      "doc_type": "client",
      "actions": 1,
      "last_action": "create",
      "last_summary": "Acme Corporation",
      "last_author": "system",
      "last_timestamp": "2026-04-01T08:00:00Z"
    }
  ]
}
```

---

## Maintenance Tools

### maad.validate

Runs schema validation on a single document or all documents. Does not modify anything — read-only diagnostic.

```json
{
  "name": "maad.validate",
  "description": "Validate a document or all documents against their schemas. Returns validation results without modifying anything.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "doc_id": {
        "type": "string",
        "description": "Validate a single document. If omitted, validates all."
      }
    },
    "required": []
  }
}
```

**Response (single):**

```json
{
  "doc_id": "cas-2026-001",
  "valid": true,
  "errors": []
}
```

**Response (all):**

```json
{
  "total": 87,
  "valid": 85,
  "invalid": 2,
  "errors": [
    { "doc_id": "note-2026-04-02-003", "errors": [{ "field": "case", "message": "Ref target 'cas-9999' not found" }] },
    { "doc_id": "cli-orphan", "errors": [{ "field": "status", "message": "Required field missing" }] }
  ]
}
```

### maad.reindex

Force reparse and reindex. Use after manual file edits, bulk imports, or when the index seems stale.

```json
{
  "name": "maad.reindex",
  "description": "Force reparse and reindex of a document or all documents. Use after manual edits or bulk imports.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "doc_id": {
        "type": "string",
        "description": "Reindex a single document. If omitted, reindexes all."
      },
      "force": {
        "type": "boolean",
        "description": "If true, ignore file hash cache and reparse everything. Default false."
      }
    },
    "required": []
  }
}
```

**Response:**

```json
{
  "status": "complete",
  "documents_scanned": 87,
  "documents_reindexed": 12,
  "documents_skipped": 75,
  "errors": []
}
```

---

## Typical LLM Workflow

This is the expected tool call sequence for common tasks.

### First contact with a MAAD project

```
1. maad.describe()                           → learn what types and schemas exist
2. maad.schema({ doc_type: "case" })         → understand the case schema
3. maad.find({ doc_type: "case", filters: { status: "open" } })  → find open cases
4. maad.get({ doc_id: "cas-2026-001", depth: "hot" })            → quick read
5. maad.get({ doc_id: "cas-2026-001", depth: "warm", block: "timeline" })  → targeted read
```

### Creating a new record

```
1. maad.schema({ doc_type: "case_note" })    → check what fields are required
2. maad.create({                             → create with validated fields
     doc_type: "case_note",
     fields: { case: "cas-2026-001", author: "user", noted_at: "2026-04-06T15:00:00Z", note_type: "update" },
     body: "Client requested revised timeline.\n\nNew deadline: [[date:2026-04-20|April 20, 2026]]."
   })
```

### Investigating a question ("what happened with Acme?")

```
1. maad.find({ doc_type: "client", filters: { name: "Acme Corporation" } })   → find client
2. maad.list_related({ doc_id: "cli-acme", direction: "incoming", include_frontmatter: true })  → all related docs
3. maad.get({ doc_id: "cas-2026-001", depth: "warm", block: "resolution" })   → read the specific section
4. maad.search_objects({ primitive: "entity", subtype: "person", contains: "Park" })  → find who was involved
```

### Cross-document search ("all mentions of Officer Davis")

```
1. maad.search_objects({ primitive: "entity", subtype: "person", value: "Officer Davis" })
   → returns every document and line where Officer Davis is mentioned
2. maad.get({ doc_id: "report-investigation-001", depth: "warm", block: "summary" })
   → read the relevant section
```

### Auditing changes ("what happened this week?")

```
1. maad.audit({ since: "2026-03-31" })                            → project-wide activity summary
2. maad.history({ doc_id: "cas-2026-001" })                       → full history for a specific doc
3. maad.diff({ doc_id: "cas-2026-001", from: "d4e5f6a" })        → see exactly what changed
4. maad.snapshot({ doc_id: "cas-2026-001", at: "2026-04-01" })   → read the original version
```

### Reconstructing a timeline ("what did the case look like before resolution?")

```
1. maad.history({ doc_id: "cas-2026-001" })                       → find the commit before resolution was added
2. maad.snapshot({ doc_id: "cas-2026-001", at: "2026-04-04" })   → read the document as it was
3. maad.diff({ doc_id: "cas-2026-001", from: "e4f5a6b", to: "a1b2c3d" })  → see what the resolution added
```

---

## MCP Server Configuration

A MAAD MCP server points at a project root and exposes all tools.

```json
{
  "mcpServers": {
    "maad": {
      "command": "maad",
      "args": ["serve", "--project", "/path/to/my-project"],
      "env": {}
    }
  }
}
```

The `maad serve` command:
1. Validates the project is a git repo (or initializes one)
2. Loads the registry and schemas from the project root
3. Initializes the backend (creates `_backend/maad.db` if missing)
4. Runs an initial index pass
5. Exposes all 15 tools via MCP stdio transport

Write operations (`create`, `update`, `delete`) auto-commit to git with structured messages. Audit tools (`history`, `diff`, `snapshot`, `audit`) query git history and parse the structured commit messages.

---

## Tool Count Summary

| Category | Tools | Purpose |
|----------|-------|---------|
| Discovery | `describe`, `schema`, `inspect` | Understand the project before acting |
| CRUD | `create`, `get`, `find`, `update`, `delete` | Read and write records |
| Navigation | `list_related`, `search_objects` | Traverse relationships and search extracted objects |
| Audit | `history`, `diff`, `snapshot`, `audit` | Version history, change tracking, point-in-time reads |
| Maintenance | `validate`, `reindex` | Verify integrity and rebuild index |
| **Total** | **15 tools** | |

---

*This is the LLM-facing interface for MAAD. The CLI wraps some of these for human convenience, but the MCP server is the primary product. Every write is git-committed. Every change is auditable. The LLM has full traceability through the audit tools without needing raw git access.*
