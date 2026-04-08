// ============================================================================
// Skill Files — detailed workflow guides generated on init
// Loaded by the LLM when performing specific tasks.
// ============================================================================

export function generateSchemaGuide(): string {
  return `# Schema Guide

## Overview

Every MAAD record type needs two things:
1. A type entry in \`_registry/object_types.yaml\`
2. A schema file in \`_schema/<type>.v<version>.yaml\`

## Master vs Transaction Records

Before designing schemas, classify each type:

| Pattern | Description | File strategy | Examples |
|---------|-------------|---------------|----------|
| **Master** | Created once, updated occasionally. Low volume. Standalone identity. | One file per record | Clients, contacts, cases, products, accounts |
| **Transaction** | Created constantly, rarely updated. High volume. Belongs to a parent. | Append blocks to parent file | Notes, logs, events, audit entries, messages |

**Why this matters:** 100 sales agents x 10 notes/day x 365 days = 365,000 files if each note is a file. That kills the file system, git, and reindex. Instead, group transaction records into one file per parent — notes for client X go in one file, appended as headed blocks.

### Master record example (one file per record)
\`\`\`
clients/
  cli-001.md          ← Apex Industrial Supply Co.
  cli-002.md          ← BlueLine Logistics LLC
\`\`\`

### Transaction record example (append to parent file)
\`\`\`
case-notes/
  notes-cli-001.md    ← all notes for client 001 (appended over time)
  notes-cli-002.md    ← all notes for client 002
\`\`\`

Each note is a headed block inside the file:
\`\`\`markdown
## 2024-03-05 — Mediation Session {#note-010}

Day-long mediation with Judge Vasquez. No resolution. Opposing at $950K.
\`\`\`

The engine indexes each block with line pointers. Individual notes are addressable via \`get warm <doc_id> <block_id>\`.

### Decision rule

Ask: **Will this type generate more than 1,000 records per year?**
- No → Master pattern (one file per record, use \`maad.create\`)
- Yes → Transaction pattern (append to parent file, use \`maad.update --append\`)

## Registry entry

\`\`\`yaml
types:
  client:
    path: clients/          # directory for this type's records
    id_prefix: cli           # prefix for auto-generated IDs
    schema: client.v1        # schema file reference
\`\`\`

## Schema file

\`\`\`yaml
# _schema/client.v1.yaml
type: client
required:
  - doc_id
  - name
  - status
fields:
  name:
    type: string
    index: true
  status:
    type: enum
    index: true
    values: [active, inactive, prospect]
  industry:
    type: string
    index: true
  primary_contact:
    type: ref
    index: true
    target: contact
  email:
    type: string
    index: true
  phone:
    type: string
    index: false
  since:
    type: date
    index: true
  tags:
    type: list
    index: false
    itemType: string
\`\`\`

## Field types

| Type | Description | Index behavior |
|------|-------------|---------------|
| \`string\` | Plain text | Exact match, contains |
| \`number\` | Numeric value | Range queries (gt, lt, gte, lte) |
| \`date\` | ISO date (YYYY-MM-DD) | Lexicographic range |
| \`enum\` | Constrained values | Exact match. Requires \`values\` list. |
| \`ref\` | Reference to another record | Exact match. Requires \`target\` type. Creates relationship edges. |
| \`boolean\` | true/false | Exact match |
| \`list\` | Array of values | Requires \`itemType\`. Use \`target\` for list-of-ref. |
| \`amount\` | Currency value (e.g. "1250000 USD") | Numeric range on extracted value |

## Required fields

Every schema must require \`doc_id\`. Add other required fields that every record of this type must have.

## Index flag

\`index: true\` means the field is stored in the field_index table for fast queries. Only index fields you need to filter or search on.

## Ref fields

\`type: ref\` creates a relationship edge between documents. The \`target\` must be a registered type. Example:

\`\`\`yaml
client:
  type: ref
  index: true
  target: client    # points to records of type "client"
\`\`\`

## Template headings (optional)

Add heading structure that \`maad.create\` will generate for new records:

\`\`\`yaml
template:
  - level: 1
    text: "{{title}}"
  - level: 2
    text: Background
  - level: 2
    text: Notes
\`\`\`

## Schema versioning

Schema refs use \`<type>.v<number>\` format. When changing a schema, create a new version file and update the registry reference.

## After creating schemas

1. Call \`maad.reload\` to pick up new registry and schemas
2. Call \`maad.summary\` or \`maad.schema <type>\` to verify
`;
}

export function generateImportGuide(): string {
  return `# Import Guide

## Overview

Importing raw data into MAAD:
1. Analyze the source data
2. Classify each type as master or transaction
3. Design the type registry and schemas
4. Create records
5. Reindex to build the search index

## Step 1 — Analyze source data

Read the raw files. Identify:
- What types of records exist (clients, cases, contacts, notes, etc.)
- What fields each type has
- What relationships exist between types (client → contact, case → client)
- What field types to use (string, date, enum, ref, amount)

Use \`maad.scan\` on the source directory for structural patterns if helpful.

## Step 2 — Classify master vs transaction

For each type, ask: **Will it generate more than 1,000 records per year?**

| Type | Volume | Pattern | File strategy |
|------|--------|---------|---------------|
| Clients | Low (tens to hundreds) | Master | One file per client |
| Cases | Low to medium (hundreds) | Master | One file per case |
| Contacts | Low (hundreds) | Master | One file per contact |
| Case notes | **High (thousands+)** | **Transaction** | One file per case, notes appended as blocks |
| Activity logs | **High (tens of thousands)** | **Transaction** | One file per entity, entries appended |
| Invoices | Medium to high | Master if <1K/yr, Transaction if more | Depends on volume |

## Step 3 — Design registry and schemas

Create \`_registry/object_types.yaml\`:

\`\`\`yaml
types:
  client:
    path: clients/
    id_prefix: cli
    schema: client.v1
  case:
    path: cases/
    id_prefix: cas
    schema: case.v1
  case_note:
    path: case-notes/
    id_prefix: note
    schema: case_note.v1
\`\`\`

Create schema files in \`_schema/\` for each type. See schema-guide.md for field type reference.

After writing registry and schemas, call \`maad.reload\` to pick them up.

## Step 4 — Create records

### Master records (one file per record)

For each record, use \`maad.create\`:

\`\`\`
maad.create({
  docType: "client",
  fields: {
    name: "Apex Industrial Supply Co.",
    status: "active",
    industry: "Manufacturing",
    primary_contact: "con-ron-stafford",
    email: "r.stafford@apexind.com"
  }
})
\`\`\`

For bulk imports (10+ records), use \`maad.bulk_create\` instead — accepts an array, returns per-record results, single git commit:

\`\`\`
maad.bulk_create({
  records: [
    { docType: "client", fields: { name: "Acme Corp", status: "active" } },
    { docType: "client", fields: { name: "Beta Inc", status: "prospect" } },
    ...
  ]
})
\`\`\`

**Important:** Execute individual creates sequentially, not in parallel. Use bulk_create for batch operations.

### Transaction records (append to parent file)

First create the parent file, then append entries:

\`\`\`
maad.create({
  docType: "case_note",
  docId: "notes-cas-001",
  fields: { case: "cas-001", doc_type: "case_note" },
  body: "## 2024-03-05 — Mediation Session {#note-010}\\n\\nDay-long mediation. No resolution."
})
\`\`\`

For subsequent notes, append to the same file:

\`\`\`
maad.update({
  docId: "notes-cas-001",
  appendBody: "## 2024-04-15 — Settlement Call {#note-011}\\n\\nClient agreed to $1.8M floor."
})
\`\`\`

Each headed block becomes an indexed block with a block_id. Retrieve individual notes with \`maad.get\` at warm depth.

## Handling tabular data

If source data is in markdown tables (rows = records):
- Classify: is each row a master record or a transaction entry?
- Master rows: each row becomes one \`maad.create\` call
- Transaction rows: group by parent, create one file per parent, append rows as headed blocks
- Column headers map to frontmatter field names

## Handling narrative documents

If source data is unstructured text (articles, reports, filings):
- Create one record per document
- Put key facts in frontmatter fields (who, what, when, where)
- The body stays as-is — the original text is preserved unchanged
- Frontmatter IS the annotation layer — the LLM's understanding of the document

## Step 5 — Reindex and verify

After creating all records:

1. \`maad.reindex({ force: true })\` — rebuild the full index
2. \`maad.summary\` — verify counts and types
3. \`maad.query\` — spot-check a few records
4. \`maad.search\` — verify extracted objects

## Tips

- Call \`maad.schema <type>\` before creating records to verify field names
- Use \`maad.reload\` after any registry or schema changes
- Execute write operations sequentially — do not parallelize
- If a create fails validation, check the error message — it tells you which field is wrong
- For bulk imports, work through one type at a time: all clients, then all cases, then notes
`;
}
