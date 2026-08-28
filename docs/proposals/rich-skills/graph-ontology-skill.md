# Graph / Ontology Skill — Draft

> **Proposal archive** (shipped 0.15.0): managed path `_skills/graph-ontology.md`,
> artifact name `graph-ontology`. Runtime source of truth is
> `src/skills/graph-ontology.ts`. Content below is the design draft retained
> for history; prefer the generator when they diverge.

---

# Working the Project as a Typed Graph

## Purpose

You are an agent operating on a MAADB project. This skill teaches you to
treat the project as a **typed information graph**: to read structure that
already exists, to choose the right traversal tool for each question, and to
**densify** the graph — promoting links that live only in prose into typed,
queryable structure. The engine gives you bounded graph primitives; you are
the query planner and the ontologist.

Audience: any agent with at least reader access. Densification recipes
(Recipes 4–5) additionally need writer access and — for schema changes — the
Architect channel described in `_skills/architect-core.md`.

## When to load this skill

- You need to answer connection questions: "how is X related to Y?",
  "what depends on this record?", "walk the chain from case to industry."
- You are building a report or view that spans record types.
- You notice the project is **link-poor**: records reference each other in
  body text but `maad_related` returns little — structure exists in prose
  but not in the graph.
- You are establishing or extending naming/linking conventions for a project
  (light ontology work).

For first-contact orientation in a project you don't know at all, load
`_skills/corpus-explorer.md` first — it ends where this skill begins.

## The graph model — what an edge is

The engine derives edges from markdown; SQLite rows are derived data and
reindex rebuilds them. There are exactly two edge kinds:

1. **`ref` edges** — frontmatter fields of type `ref` (or `list` with
   `item_type: ref`). Typed by the **field name** (`client`, `parent_case`,
   `assigned_attorney`). This is the *intentional* graph: schema-declared,
   validated, queryable, joinable. Evidence origin is the field; source
   line/block evidence is null.
2. **`mention` edges** — inline annotations `[[type:value|label]]` whose
   value is a doc ID with a registered prefix (e.g.
   `[[identifier:cli-001|the client]]`). This is the *observed* graph:
   extracted from prose, carrying line and block evidence, but not schema-
   validated. Plain prose that names a record without an annotation creates
   **no edge at all**.

The density gradient — prose → annotated mention → typed ref — is the core
of this skill. Each promotion step makes a link more queryable and more
verifiable.

## Choosing the traversal tool

| Question shape | Tool | Why |
|---|---|---|
| "What touches this one record?" (1 hop) | `maad_related` | Cheapest neighborhood read; direction `outgoing` / `incoming` / `both` (default `both`) |
| "How does A connect to B?" / "what's within N hops?" / "show me the evidence" | `maad_relationship_paths` | Bounded multi-hop BFS, deterministic, cycle-safe, returns per-edge evidence and per-node distance |
| "Give me these fields from many records *and* their ref targets" | `maad_join` | One call instead of query → get → get (N+1) chains |
| "Roll up a metric across a ref hop" ("cases per client industry") | `maad_aggregate` with a ref-chain `groupBy` (`"client->industry"`) | Group-by resolves refs at query time; never iterate records to count |
| "Where is this record *mentioned* in prose?" | `maad_search` (scoped `value=<docId>`) or `maad_relationship_paths` with `extractionKinds: ["ref","mention"]` | Mentions are opt-in on path traversal; search finds the raw extracted objects |

Two defaults that will bite you if unexamined:

- `maad_related` defaults to direction `both`; `maad_relationship_paths`
  defaults to `outgoing`. When a path result looks mysteriously empty, check
  direction first — dependency questions ("what refs this?") need
  `incoming` or `both`.
- `maad_relationship_paths` traverses **`ref` edges only by default**.
  Mentions are opt-in via `extractionKinds: ["ref", "mention"]`. If you are
  probing the *observed* graph, you must opt in.

Bounds (validated, over-cap values are rejected, not clamped): `maxDepth`
default 2, cap 4 · `maxNodes` 50/100 · `maxEdges` 100/200 · `maxPaths`
25/50. If a response trips the byte-size guard, narrow with `fieldLabels`
or `extractionKinds`, or lower the limits — don't retry as-is.

## Recipes

### Recipe 1 — Typed neighborhood of one record

Goal: everything structurally connected to `cas-012`, with meaning.

1. `maad_get cas-012 hot` — its own typed fields.
2. `maad_related docId=cas-012 direction=both` — 1-hop adjacency; note the
   **field names** on each edge (they are your edge types).
3. Where you need target detail for several neighbors of the same type,
   don't loop `maad_get` — use `maad_join` on the source type with
   `refFields` (Recipe 6).
4. Only escalate to `maad_relationship_paths` if 1 hop is insufficient.

### Recipe 2 — Connection between two specific records

Goal: does `cas-012` connect to `con-007`, and through what?

```
maad_relationship_paths
  startDocId: cas-012
  targetDocId: con-007
  direction: both
  maxDepth: 3
```

Read the result as claims with proof: each edge carries `fieldLabel`,
extraction kind, and canonical evidence (source line + block for mentions;
field origin for refs). When you report the connection, cite the doc IDs on
the path — and for mention-backed hops, treat the link as *observed, not
validated* and say so.

A `state: missing` node on a path is a **broken ref** — the edge exists but
the target doesn't. Report it (and see Recipe 7); missing targets are
terminal, so real connectivity may be wider than what a broken hop shows.

### Recipe 3 — Bounded exploration outward from a hub

Goal: the working set within 2 hops of a central record.

```
maad_relationship_paths
  startDocId: cli-001
  direction: both
  maxDepth: 2
  fieldLabels: [client, parent_case]     # optional: only these edge types
```

Use `nodes[].distance` to organize the result into rings. Check
`truncation.truncated` and `limitsReached` **before** summarizing — a
truncated traversal is a lower bound, not a census, and your summary must
say which limit was hit if one was.

### Recipe 4 — Promote prose links to typed structure (densification)

Goal: links that exist only in narrative become schema-typed refs.

1. **Find candidates.** Probe the observed graph:
   `maad_relationship_paths` from key records with
   `extractionKinds: ["ref","mention"]`, `maxDepth: 1` — every `mention`
   edge is a candidate. Corpus-wide, `maad_search` with `value=<docId>`
   scoped per hub record inventories where it's mentioned. (Prose links with
   no annotation at all are invisible to tools — surfacing those is judgment
   work while reading `cold` bodies.)
2. **Decide if the link is structural.** Promote when the relationship is:
   queried or filtered on; needed in joins/aggregates; integrity-relevant
   (should break loudly if the target vanishes); or cardinality-stable
   (every case has a client). Leave as mention/prose when it's incidental
   commentary.
3. **Type it.** If a suitable `ref` field exists in the schema, done. If
   not, this is a schema change — an **additive** new `ref` field (with
   `target` and `index: true`) via the Architect channel
   (`_skills/architect-core.md`): registry/schema edits go through the
   deployment's approved channel, then `maad_reload`. Never write schema
   files through record tools.
4. **Set the field.** `maad_update` per record (sequential; pass
   `expectedVersion` when you hold a read), or `maad_bulk_update` for a
   genuine batch. Keep the prose mention — you are adding structure, not
   rewriting narrative.
5. **Verify.** `maad_related` on a sample now shows the edge with the new
   field label; `maad_find_orphans docType=<type>` catches typo'd targets
   immediately.
6. **Record the convention** in `_skills/local/ontology.md` (Recipe 5) so
   the next agent types new records the same way.

### Recipe 5 — Light ontology, MAADB-style

An ontology here is **conventions, not a reasoner**:

- **Classes** = registered doc types.
- **Typed predicates** = `ref` field names. Name them as relations
  (`parent_case`, `assigned_attorney`), not generically (`link1`, `related`).
  The field name is the only edge label the graph has — spend it well.
- **Controlled vocabularies** = `enum` fields.
- **Annotation vocabulary** = the 11 fixed primitives plus registry
  `extraction.subtypes` (e.g. `attorney: entity`). Subtypes make
  `maad_search` domain-aware without engine changes.

The ontology's *documentation* lives in `_skills/local/ontology.md` — a
project-owned overlay file you create and maintain (it survives engine
refreshes). Keep it short and normative: one table of types, one table of
ref fields with their meaning and cardinality, the subtype vocabulary, and
the annotation policy ("always annotate doc-ID mentions in prose as
`[[identifier:<docId>|label]]`" is the single highest-leverage rule, because
it feeds Recipe 4's candidate pipeline).

Schema *changes* implied by ontology work are Architect work — hand off to
`_skills/architect-core.md`; do not duplicate its channel rules here.

### Recipe 6 — Cross-type reports and views

Row-level view ("open cases with client name and industry"):

```
maad_join
  docType: case
  filters: { status: open }
  refs: [client]
  fields: [title, status, opened_at]
  refFields: { client: [name, industry] }
```

Rollup ("case count by client industry"):

```
maad_aggregate
  docType: case
  groupBy: "client->industry"
  filters: { status: open }
```

Compose the two into a markdown report (summary table from `aggregate`,
detail table from `join`) and — if the report should persist — write it as a
record via `maad_create` in a report-ish doc type if the project has one.
Ground every number you state: `maad_verify mode=count` (or `mode=field`)
before presenting totals as fact. Rendering to anything richer than
markdown, and publishing anywhere, is host work (see Non-goals).

### Recipe 7 — Graph hygiene

Run before *and* after densification passes:

- `maad_find_orphans` — records whose ref fields point at nonexistent
  targets (broken refs, per-record detail).
- `maad_verify mode=integrity` — the broader sweep (index drift, schema
  drift, broken refs) after pulls or external edits.
- `maad_validate` after any schema evolution — see `_skills/schema-guide.md`
  § versioning for the migrate-or-grandfather discipline.

A densification pass that introduces broken refs has made the graph *worse*
— typed-but-wrong beats untyped only if you catch it, which is why Recipe 4
ends in `maad_find_orphans`.

## Non-goals / hand off to the host

- **No visualization here.** Emitting a small inline Mermaid/DOT sketch in
  chat from path output is fine as ordinary agent output; anything
  interactive, rendered, served, or saved as an artifact belongs to
  host-side skills (see the pack's `host-boundary.md`).
- **No query language.** You compose bounded primitives; there is no Cypher
  and none is coming.
- **No inference engine.** Do not invent transitive/derived edges and
  present them as data — a multi-hop path is evidence of connection, not a
  new fact. If a derived relationship matters, promote it explicitly
  (Recipe 4) so it becomes a real, validated edge.
- **No schema writes through record tools** — Architect channel only.

---

## Open questions for the maintainer (dropped at promotion)

1. Recipe 4 step 1 notes that un-annotated prose links are tool-invisible.
   Is a corpus-wide "annotation debt" sweep worth specifying (agent reads
   `cold` bodies batch-wise), or is that acceptable to leave as judgment?
2. Should the "always annotate doc-ID mentions" rule be promoted from
   overlay guidance into managed `MAAD.md` itself? It's cheap, universal,
   and feeds every graph feature — but it edits an existing artifact.
3. Cardinality documentation (one-vs-many on ref fields) currently lives
   only in the overlay ontology doc. Worth a schema-DSL hint someday, or
   deliberately out of scope? (Engine change — flagging, not proposing.)
