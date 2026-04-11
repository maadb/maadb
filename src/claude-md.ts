// ============================================================================
// CLAUDE.md Generator — Agent instructions for MCP-first MAAD workflow
// Generated on init. Tells the LLM how to work with this project.
// ============================================================================

export function generateClaudeMd(): string {
  return `# MAAD Project — Agent Instructions

## How to work with this project

This is a MAAD project. You have MCP tools for all data operations.

**Use MAAD MCP tools for everything.** Do not use bash, shell commands, or direct file reads for data access. If a tool fails, report the error — do not fall back to shell.

## Boot sequence

1. Run \`maad_summary\` to see what's in this project
2. If summary shows **zero types and zero documents** → this is an empty project. Read \`_skills/architect-core.md\` and enter Architect mode to design and deploy the database.
3. If summary shows existing types and documents → this is a live project. Proceed with normal operations below.
4. Use \`maad_schema <type>\` to understand record structure before writing
5. Use \`maad_health\` if something seems wrong

## Empty project → Architect mode

When this project has no types defined:
1. Read \`_skills/architect-core.md\` for the full Architect role specification
2. Read \`_skills/schema-guide.md\` for field type reference
3. Read \`_skills/import-guide.md\` if importing existing data
4. Follow the Architect workflow: discover requirements → design schema → present plan → build

The Architect role handles: schema design, registry creation, data import, troubleshooting, and handoff to normal operations.

## Live project → User mode

### Reading data

- \`maad_summary\` — project snapshot (start here)
- \`maad_get\` — read a record (hot/warm/cold/full)
- \`maad_query\` — find records by type, filters, and field projection
- \`maad_search\` — find extracted objects across all records
- \`maad_related\` — traverse relationships between records
- \`maad_aggregate\` — count/sum/avg/min/max grouped by a field
- \`maad_join\` — query + follow refs + project fields from both sides in one call

### Writing data

- **Always** call \`maad_schema <type>\` before creating or updating records
- \`maad_create\` — new record (engine validates against schema)
- \`maad_update\` — modify fields or body (use expectedVersion for safe writes)
- \`maad_bulk_create\` — create multiple records in one call (much faster for imports)
- \`maad_bulk_update\` — update multiple records in one call
- **Execute individual writes sequentially** — do not parallelize single create/update calls

### Importing raw data

When onboarding new data into this project:

1. Read the raw files to understand the data
2. Read \`_skills/architect-core.md\` for schema design guidance
3. Design the registry and schemas
4. Call \`maad_reload\` to pick up the new registry and schemas
5. Create records using \`maad_create\` (master) or \`maad_update --append\` (transaction)
6. Call \`maad_reindex\` after bulk creation
7. Call \`maad_summary\` to confirm

### Frontmatter format

Every markdown record must have a YAML frontmatter header:

\`\`\`yaml
---
doc_id: <unique-id>
doc_type: <registered-type>
schema: <type.version>
field1: value1
field2: value2
---
\`\`\`

### Server management

- \`maad_reload\` — reload registry and schemas after config changes (no restart needed)
- \`maad_health\` — check engine status
- \`maad_reindex\` — rebuild index after bulk file changes

## Rules

1. MCP tools only — no bash for data operations
2. Schema first — call \`maad_schema\` before writes
3. Reload after config changes — call \`maad_reload\` after editing registry or schemas
4. Sequential writes — never parallelize create/update/delete operations
5. Report errors — if a tool returns \`ok: false\`, report what happened
6. Empty project = Architect mode — read the skill files and design the database
`;
}
