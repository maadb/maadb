---
name: maadb
description: Work with records in a MAADB project (Markdown As A Database) through the maad_* MCP tools. Use when the user asks to look up, query, create, update or delete records, design or inspect a schema, or explore a MAADB project.
---

# Working with a MAADB project

MAADB stores records as markdown files with typed frontmatter, indexes them in SQLite, and commits every write to git. The `maad_*` tools are the only way to read and write. Do not edit the project's markdown files directly.

Every tool returns `{ ok: true, data }` or `{ ok: false, errors }`. Read the error `code` before retrying.

## 1. Bind a project (multi-project engines only)

If `maad_summary` or another data tool fails with a binding error, the engine serves several projects:

1. `maad_projects` lists them.
2. `maad_use_project` binds this session to one. `maad_use_projects` binds several; then every call passes `project`.

Binding is one-shot for the session. Pick the project before binding.

## 2. Orient

- `maad_summary` gives the live snapshot: types, counts and recent activity. An empty project means the schema has not been designed yet; ask the user what they want to track before creating types.
- `maad_describe` and `maad_schema` show types and fields. Call `maad_schema` for a type before you create or update records of that type.

## 3. Read

- `maad_query` finds records by type and field filters. Pass `fields` to get values inline, and `depth: "cold"` to get bodies inline instead of one `maad_get` per row. Check `filterWarnings`: a filter on an undeclared or unindexed field matches nothing.
- `maad_get` reads one record at `hot` (frontmatter), `warm` (one block), `cold` (full body) or `full` (resolved references).
- `maad_search` finds extracted objects (people, dates, amounts and so on). `maad_semantic_search` searches body text when the engine has it enabled.
- `maad_related`, `maad_relationship_paths` and `maad_join` follow references between records.
- `maad_aggregate` counts and totals. Use it for numbers instead of adding up query rows.

## 4. Write

- `maad_create` and `maad_bulk_create` add records. Field names and types must match `maad_schema`.
- `maad_update` and `maad_bulk_update` change records. Show the user what will change first.
- `maad_delete` removes one record; soft delete is the default.
- Cleanup tools (`maad_bulk_delete`, `maad_delete_where`, `maad_repair_where`, `maad_purge_soft_deleted`) are dry runs unless `confirm: true` is passed. Run the dry run, show the user the result, and pass `confirm: true` only after they agree.

Writes are serialized and committed to git, so `maad_history` and `maad_audit` show who changed what.

## 5. When something looks wrong

- `maad_health` reports engine and index state.
- `maad_verify` with `mode: "integrity"` compares the markdown on disk with the index.
- A role error means the session's role does not allow the tool. Tell the user which role is needed rather than retrying.
