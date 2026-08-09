// ============================================================================
// MAAD.md Generator — canonical project operating instructions for agents.
//
// FULLY STATIC since the instruction-lifecycle rework: no live counts, no
// machine paths, no project-state details. Live facts belong to tools
// (maad_summary, maad_schema); this file owns routing, safety, and workflow.
// Written stamped via the instructions manifest; refreshed only through
// `maad instructions refresh` — never rewritten by boot or reindex.
// ============================================================================

export function generateMaadMd(): string {
  return `# MAAD.md — Agent Operating Instructions

> Managed by the MAADb engine — do not edit (changes block future refreshes).
> Project-specific guidance belongs in your own overlay files, e.g. \`_skills/local/\`.

## What is this?

A **MAADb project** — a markdown-native database. Markdown files are the
records (canonical); a SQLite index provides structured access (derived).
Use **MAADb MCP tools for all data operations** — never shell commands or
direct file reads/writes for record data. Tool schemas are authoritative
for parameters; this file covers routing, safety, and workflow.

## Boot

1. **Bind if needed.** Multi-project servers: \`maad_projects\` to list, then
   \`maad_use_project\` (or \`maad_use_projects\`) to bind. Bindings are fixed
   for the session — rebinding fails with \`SESSION_PINNED\`/\`SESSION_ALREADY_BOUND\`;
   open a new session to switch. Hosted deployments may pre-pin the project.
2. **Orient.** \`maad_summary\` once per session: types, counts, sample IDs.
   Empty project → read \`_skills/architect-core.md\` and enter Architect mode.
3. Your **effective role** (reader/writer/admin) is set by token and binding.
   Tools above your role fail \`INSUFFICIENT_ROLE\`; request a lower role via
   \`as=\` when acting deliberately below your ceiling. On **read-only
   deployments** every mutation fails \`READ_ONLY\` — report it, don't retry.

## Reading — pick the shape that matches the need

- \`maad_get <id> hot\` — frontmatter fields only
- \`maad_get <id> warm <block>\` — frontmatter + one named section
- \`maad_get <id> cold\` — the raw markdown body
- \`maad_get <id> full\` — resolved refs, extracted objects, relationships

Different shapes, not an escalation ladder: field value → \`hot\`; one
section → \`warm\`; whole narrative → \`cold\`; graph context → \`full\`.

## Lookups — route by kind

- \`maad_query\` — structured frontmatter filters (eq/neq/gt/gte/lt/lte/in/contains), projection
- \`maad_search\` — extracted objects (people, dates, amounts annotated in text)
- \`maad_semantic_search\` — meaning-based retrieval (when enabled; degraded
  responses say so — fall back to query/search, don't guess)
- \`maad_related\` — relationship traversal (outgoing/incoming/both)
- \`maad_aggregate\` — group-by count/sum/avg/min/max; ref chains (\`a->b->c\`)
  for cross-type groupings. Use instead of iterating records.
- \`maad_join\` — query + follow refs + project both sides in one call.
  Use instead of query → get → get chains.

## Writing

1. \`maad_schema <type>\` first — field types, required fields, enum values.
2. **Identity is engine-owned**: never put \`doc_id\`, \`doc_type\`, or \`schema\`
   inside \`fields\` — rejected with \`FRONTMATTER_GUARD\`.
3. **Sequential mutations** — never parallelize create/update/delete from one
   caller. Use \`maad_bulk_create\` / \`maad_bulk_update\` for genuine batches.
4. **Safe updates**: pass \`expectedVersion\` on updates when you hold a prior
   read. On retry after a timeout, reuse the same \`idempotencyKey\` — the
   engine replays the original result instead of double-writing.
5. **Read the response**: \`_meta.warnings[]\` carries soft-validation signals
   (self-correct on warnings, not just errors). \`writeDurable: false\` or a
   \`commitFailure\` means the write landed but isn't durably committed —
   surface it to the operator rather than continuing silently.
6. **Destructive operations** (\`maad_delete\`, cleanup/repair tools) follow the
   dry-run-then-confirm contract where offered; prefer a \`maad_backup\` before
   high-risk repair or cleanup.

## Integrity and recovery

- \`maad_verify mode=field|count\` — ground a claimed value/count before reporting it.
- \`maad_verify mode=integrity\` — diagnoses index/document divergence and
  reports the specific recovery path. Run after git pulls, manual file edits,
  or schema changes.
- \`maad_reindex\` rebuilds derived index state only — it does not repair
  malformed markdown, invalid schemas, or git/filesystem problems.
- \`INDEX_EMPTY\` on a project that should have data = false-empty index; the
  sanctioned recovery is \`maad_reindex\` (multi-project mode) or the
  operator-run CLI path — do not improvise with file writes.

## Change awareness (multi-agent / hosted projects)

Live push: \`maad_subscribe\` (manage with \`maad_unsubscribe\` /
\`maad_subscriptions\`). Catch-up after reconnects or gaps:
\`maad_changes_since <cursor>\` — persist the cursor between calls.

## Grounding

Claims **about project records** (values, counts, IDs, relationships) must
come from current tool results — cite \`doc_id\` / \`block_id\` when
traceability matters, and use \`maad_verify\` for high-consequence assertions.
If a claim can't be grounded, say so.

## Extraction primitives

Inline \`[[type:value|label]]\` annotations in record bodies are extracted and
indexed: \`entity\`, \`date\`, \`duration\`, \`amount\`, \`measure\`, \`quantity\`,
\`percentage\`, \`location\`, \`identifier\`, \`contact\`, \`media\`.
Search them with \`maad_search <primitive>\`.

## Schema and config changes

Record data goes through MCP tools. Registry (\`_registry/\`) and schema
(\`_schema/\`) authoring uses an approved filesystem or host-application
channel, followed by \`maad_reload\` — see \`_skills/architect-core.md\`. If no
approved channel exists in this deployment, stop and ask the operator; do
not improvise direct writes. In shared or public projects, keep records free
of secrets and personal data you would not hand to every project member.

## Skills

- \`_skills/architect-core.md\` — design and deploy schemas (Architect mode)
- \`_skills/schema-guide.md\` — schema DSL reference and evolution
- \`_skills/import-guide.md\` — importing existing data
- \`_skills/graph-ontology.md\` — typed graph traversal and densification
- \`_skills/corpus-explorer.md\` — map an unfamiliar project to a typed corpus map
`;
}
