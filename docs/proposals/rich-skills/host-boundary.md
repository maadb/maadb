# Host boundary — visualization, reports, and UIs

**Status:** proposal / draft
**Audience:** agents (and the humans configuring them) building visual or
report-shaped output on top of MAADB
**Engine baseline:** `@maadb/core` 0.14.0
**Placement:** **host-only.** Nothing in this document is proposed as a managed
skill shipped by the engine, and nothing here is proposed as engine source.

---

## 1. Purpose

MAADB is a data layer. Agents increasingly want to *see* the data — a graph
picture of how records connect, a rendered report, a dashboard someone can open
in a browser. That demand is legitimate. The mistake would be answering it
inside `@maadb/core`.

This document draws the line: what the engine owes a visual host, what the host
must build for itself, and what happens when a host tries to shortcut the
boundary by reading the engine's SQLite file directly.

The short version:

> The engine emits **stable, already-graph-shaped JSON** over MCP. Rendering,
> layout, styling, interaction, hosting, and persistence of rendered artifacts
> are the host's job. No new engine API is required for a v1 visualization or
> reporting host.

### When to load this skill

Load it when the request is any of:

- "draw / diagram / visualize the relationships between these records"
- "build me a dashboard / viewer / web UI over this project"
- "export this project as a graph" (Mermaid, DOT, Cytoscape, GraphML, …)
- "generate a report from this data" with formatting or charts implied
- someone proposes adding a render, chart, layout, or HTML-emitting command to
  the engine

Do **not** load it for ordinary reads, schema work, or corpus exploration —
those are covered by the graph/ontology and corpus-explorer skills.

---

## 2. What must never enter the engine repo

The tier model in `docs/framework.md` already forbids judgment inside the
engine. Visualization adds a second axis of exclusion: **presentation**. Both
must stay out.

| Category | Examples | Why it stays out |
|---|---|---|
| **Renderers** | Mermaid/Graphviz/D3/Cytoscape bundling, SVG or PNG emitters, headless-browser screenshotting | Presentation is not deterministic data. Pulls a render toolchain and native/browser deps into a lean engine. |
| **Layout engines** | Force-directed layout, dagre, ELK, any node-positioning algorithm | Layout is aesthetic judgment with tuned heuristics. Tier 3 by the judgment test. |
| **Web servers for humans** | Admin UI, HTML dashboard routes, static asset pipeline, React/Next app | The engine already serves one protocol surface (MCP). A second, human-facing one doubles the auth, CSP, session, and hardening burden on the wrong repo. |
| **Chart/report formatting** | Chart specs, PDF/DOCX/XLSX writers, theming, CSS, templating engines | Formatting is host preference. The engine returns values; how they look is not its call. |
| **Graph query languages** | Cypher, SPARQL, Gremlin, a triple store | Explicitly out of scope (accepted decisions). `maad_relationship_paths` is the bounded traversal contract. |
| **Front-end state** | Saved views, pinned layouts, user preferences, per-viewer bookmarks | Host state. If a *project* genuinely needs to remember a view, it is a record — created through `maad_create`, governed by a schema, like any other record. |
| **Render caches** | Image caches, thumbnail dirs, scratch/output dirs | New write paths are the highest-risk change class in this repo. A render cache is a write path with no data-doctrine justification. |
| **Egress for rendering** | Calling an external diagram-rendering service | The engine must not move project content off the machine. See §6. |

Two repo-safety rules apply to any of the above if someone is tempted anyway:

- Never default a new output path to `process.cwd()` or the engine install
  directory. Rendered artifacts belong to the host, at a path the host chose.
- Never point a host renderer's `--project` at the engine checkout itself.

### The one thing that *could* eventually be managed

Nothing in §4. But a short **"export contracts"** reference — the field-by-field
mapping in §3, with no renderer attached — is a plausible future managed skill
or `_skills/local` overlay, because it is pure data documentation. Recommend
deferring that until at least one real host consumer exists; writing an export
contract with no consumer is how speculative surface area gets locked in.
Placement details belong to the architecture / managed-surface proposals; this
document only asserts that **§4 host skill shapes are never managed.**

---

## 3. Export contracts — no new engine APIs for v1

Every shape a visualization or reporting host needs is already returned by a
shipped tool. Treat the following as the v1 export contracts.

### 3.1 `maad_relationship_paths` — the graph contract

This is the primary export. It already returns a node/edge list; a host does
not need to assemble a graph, only to render one.

```
{
  contractVersion: 1,
  start:  { docId, docType, state: "present" },
  target: { docId, docType|null, state, reached } | null,
  direction: "outgoing" | "incoming" | "both",
  filters: { fieldLabels: string[]|null, extractionKinds: ("ref"|"mention")[] },
  limits: { maxDepth, maxNodes, maxEdges, maxPaths },
  nodes: [ { docId, docType|null, distance, state: "present"|"missing" } ],
  edges: [ { edgeId, sourceDocId, targetDocId, fieldLabel,
             extractionKind, evidence, targetState } ],
  paths: [ { pathId, targetDocId, nodeIds[], edgeIds[] } ],
  truncation: { truncated: boolean, limitsReached: string[] }
}
```

Rendering rules a host must honor:

- **`docId` is the only identity.** It is stable; array position is not.
  Generate synthetic render ids (`n0`, `n1`, …) for formats with restrictive id
  grammars, and keep a docId↔render-id map.
- **`state: "missing"` nodes are data, not errors.** They are broken refs that
  survived traversal deliberately. Render them distinctly (dashed outline,
  muted fill) — never drop them. Dropping them makes a corpus look healthier
  than it is.
- **`extractionKind` is a visual dimension.** `ref` edges are declared
  structure; `mention` edges are inline prose annotations and are opt-in via
  `extractionKinds`. Render them differently (solid vs dotted) or the picture
  overstates how structured the corpus is.
- **`truncation.truncated` must reach the viewer.** A truncated graph rendered
  without a banner is a false claim of completeness. Show
  `limitsReached` and the effective `limits`.
- **`evidence` is `{ sourceLine, sourceBlockId, origin: { kind, name } | null }`.**
  Members may be `null` — frontmatter refs legitimately have no line/block, and
  databases predating the evidence columns return nulls until a reindex rebuilds
  them. Render evidence as optional detail (tooltip / edge inspector); never
  make it a required field in the host's model.
- **No titles, no bodies, no file paths.** The tool deliberately returns none.
  See §3.5 for how to get labels.

Bounds are hard: `maxDepth` 2/cap 4, `maxNodes` 50/cap 100, `maxEdges` 100/cap
200, `maxPaths` 25/cap 50. Over-cap values are rejected, not clamped. A host
that wants a wider picture must **fan out from multiple start documents and
merge on `docId`**, not argue with the caps.

### 3.2 `maad_related` — the 1-hop contract

```
{ docId, outgoing: [ { docId, docType, field } ],
          incoming: [ { docId, docType, field } ] }
```

Cheaper and simpler than paths, but it carries **no evidence, no distance, and
no truncation signal**. Use it for a neighbor panel or a hover card. Do **not**
loop it to fake multi-hop traversal — that loses cycle-safety, determinism, and
the truncation contract that makes a rendered graph honest.

### 3.3 `maad_join` — the table contract

```
{ total, results: [ { docId,
                      fields: { name: value },
                      refs: { refName: { docId, fields } | null } } ] }
```

The natural feed for a report table or a denormalized grid. One trap:
**`refs[name]` is `null` when the ref is missing or broken.** Render it as an
explicit "missing" cell. A host that silently drops null-ref rows produces a
report whose row count disagrees with `total` — and quietly hides exactly the
records someone needed to see.

### 3.4 `maad_aggregate` — the chart contract

```
{ groups: [ { value, count, metric? } ], total, totalMetric?, limitClamped? }
```

Directly chartable: `value` is the category axis, `count` or `metric` the
measure. Ref-chain `groupBy` (`client->industry`) gives cross-type rollups
without a client-side join.

Unlike `relationship_paths`, aggregate **clamps silently** — an over-large
`limit` is applied at the cap and reported via `limitClamped` on the result and
`_meta.limit_clamped` on the MCP response. A chart host must check it and
annotate the chart ("top 50 of N groups"), because the clamp is invisible in the
data itself.

### 3.5 `maad_search`, `maad_get`, `maad_schema` — labels and enrichment

Graph and path responses carry ids and types, not human labels. To label nodes:

- `maad_get` with `depth: "hot"` per node — frontmatter only, no body. Correct
  for a small selected set (an inspector panel), wasteful for a whole graph.
- `maad_join` on the docType, projecting the title/name field — **one call for
  many nodes**, which is the right choice for bulk labeling.
- `maad_schema` to discover *which* field is the label for a type, instead of
  hardcoding `name` or `title`.
- `maad_search` for annotation-driven overlays (color nodes by an
  `[[entity:…]]` value, filter to records mentioning a location).

### 3.6 Feature detection and refresh

- `maad_describe` advertises `capabilities.relationshipPaths` — tool name,
  contract version, defaults, hard caps, default extraction kinds. A host should
  read this at startup rather than assuming a build, and should degrade to
  `maad_related` if paths are absent.
- `maad_summary` gives project counts and warnings (broken refs, validation
  errors) — the right source for a dashboard health strip.
- `maad_changes_since` is an opaque-cursor delta feed ordered on
  `(updated_at, doc_id)`. **This is the supported way to keep a viewer fresh.**
  Pass `nextCursor` back verbatim; honor `hasMore`. Do not watch the filesystem,
  and do not poll the SQLite file (§6).

### 3.7 Two transports, unequal coverage

| Transport | Covers | Notes |
|---|---|---|
| **MCP** (recommended) | All of the above | Full read surface. Respects project binding, auth, read-only mode, and the response-byte guard. |
| **CLI stdout** | `get`, `query`, `search`, `semantic-search`, `related`, `schema` | Each prints JSON to stdout — usable for offline/batch export. **No CLI command exists for `relationship_paths`, `join`, or `aggregate`.** |
| **Library** (`MaadEngine` from `@maadb/core`) | All of the above | In-process. Appropriate only for a host that owns the project directory; still goes through the engine, so the doctrine holds. |

That CLI gap is real and worth flagging to Master (§7) — a batch graph export
today requires MCP or the library, not a shell pipeline.

### 3.8 Response size

`maad_query`, `maad_aggregate`, `maad_relationship_paths`, and
`maad_semantic_search` pass through a response-byte guard. A host must treat a
size rejection as **"narrow the request"** — lower the limits, add `fieldLabels`
or `extractionKinds` filters, scope the docType — not as an engine defect and
not as a reason to reach past MCP.

---

## 4. Recommended host skill shapes

Three shapes, ordered by cost. Each is a **host skill** — it lives in the host
tool's own skill directory or in a sibling product repo, never in this repo and
never in a managed `_skills` artifact.

### Shape A — Graph export skill (recommended first)

**What it is:** a pure function from a `maad_relationship_paths` response to
diagram source text. No layout code, no rendering, no dependencies — the
downstream tool (Mermaid in a markdown viewer, `dot`, a Cytoscape app) does the
drawing.

**Recipe:**

1. `maad_describe` → confirm `capabilities.relationshipPaths`.
2. `maad_relationship_paths` from the anchor doc. Start at defaults
   (`maxDepth: 2`, `direction: "outgoing"`, `ref` only). Widen deliberately:
   `direction: "both"` for a neighborhood, `extractionKinds: ["ref","mention"]`
   only when prose links are the point.
3. Optionally `maad_join` on the dominant docType to fetch display labels for
   the returned `docId`s in one call.
4. Emit diagram source. Deterministic mapping:
   - node → `n<i>` with label `"<label or docId>\n<docType>"`
   - `state: "missing"` → a distinct class (dashed, muted)
   - edge → arrow labeled `fieldLabel`; `mention` edges dotted
   - direction of the arrow follows `sourceDocId → targetDocId`, always, even
     when traversal ran `incoming`
5. If `truncation.truncated`, emit a caption listing `limitsReached` and the
   effective limits. Non-optional.

**Why this one first:** it is a few dozen lines, has no runtime dependencies,
degrades to plain text, and exercises the whole export contract. If it feels
awkward to write, the contract has a gap worth reporting before anyone builds
Shape C on top of it.

### Shape B — Report composer skill

**What it is:** `maad_join` + `maad_aggregate` + `maad_summary` composed into a
markdown or CSV report. Tier 3 by the framework's own test — multi-step, with
judgment about what to include.

**Recipe:**

1. `maad_schema` on the target type → learn real field names; never guess them.
2. `maad_aggregate` for the rollups (counts by status, sums by category,
   ref-chain rollups like `client->industry`).
3. `maad_join` for the detail table, projecting only the fields the report
   shows.
4. `maad_summary` and/or `maad_find_orphans` for a data-quality footer — a
   report that hides broken refs is a report that will be trusted wrongly.
5. Assemble markdown. Carry through `limitClamped` and any truncation as
   visible notes.

**Where the output goes** — the rule that matters most here:

- Ephemeral output (an answer in chat, a file in the host's own workspace) is
  fine anywhere the host owns.
- Output that belongs *in the project* must be created with `maad_create` /
  `maad_update` against a real docType. Writing markdown into the project tree
  by hand violates the data doctrine ("all writes go through the engine") and
  skips validation, indexing, and the git audit trail.
- Never write report artifacts into the engine checkout or a path derived from
  the engine's install directory.

### Shape C — Web viewer (sibling product repo, optional)

**What it is:** a small app — graph canvas, record inspector, saved views —
that speaks MCP to a MAADB instance. **A separate repo with its own release
cycle**, depending on `@maadb/core` at most as a typed client would, and
preferably not at all.

Constraints if it gets built:

- **MCP or nothing.** No direct SQLite reads (§6), no vendored copy of the
  engine's backend module.
- Refresh via `maad_changes_since` cursors, not file watching or polling
  `_backend/`.
- Feature-detect through `maad_describe`; degrade rather than assume.
- Its own auth story for its own users. The engine's MCP auth governs the
  engine's surface; it is not a login system for a web app.
- Viewer state (layouts, saved views, pins) lives in the viewer. If a saved view
  must be shared and durable, it is a MAADB *record* with a schema — not a blob
  smuggled into the index.
- Treat the caps in §3.1 as the interaction budget. "Expand this node" is a new
  bounded `maad_relationship_paths` call merged on `docId` — the correct
  incremental-exploration pattern, and the reason the caps are not a limitation.

**Recommendation:** do not start Shape C until Shapes A and B are in real use.
Almost every "we need a graph UI" request is satisfied by a Mermaid block, and
the ones that are not will have told you exactly what the UI must do.

---

## 5. Placement summary

| Thing | Placement | Rationale |
|---|---|---|
| Export-contract reference (§3, data only) | Candidate `_skills/local` overlay; managed only after a real consumer exists | Pure data documentation, no presentation |
| Graph export skill (Shape A) | **Host** | Emits presentation syntax |
| Report composer (Shape B) | **Host** | Formatting + judgment; Tier 3 |
| Web viewer (Shape C) | **Sibling product repo** | Separate product, separate release cycle, own auth |
| Renderers, layout, charts, caches, HTML | **Never in this repo** | §2 |

---

## 6. Failure modes — treating `_backend/` as source of truth

`_backend/` is the engine's derived SQLite index. It is gitignored, it is
rebuilt by `maad reindex`, and **markdown is canonical**. A host that opens that
file directly is not taking a shortcut; it is adopting a different, worse
database with none of the guarantees. Concretely:

1. **The schema is not a contract.** The SQLite table layout is internal and
   changes between engine versions with no deprecation cycle. A host reading it
   breaks on a patch release, at runtime, in production.
2. **It is derived — and can be legitimately empty.** A fresh clone, a
   volume-restore, or a wiped `_backend/` leaves markdown intact and the index
   absent. The engine detects exactly this (markdown on disk, empty index) and
   refuses to serve stale emptiness, telling the operator to reindex. A direct
   SQLite reader gets a successful query returning zero rows and renders an
   empty graph as fact.
3. **Legacy rows lie by omission.** Relationship evidence columns return null
   for rows written before evidence existed, until a reindex rebuilds them from
   markdown. The engine documents this; a raw reader silently renders
   evidence-free edges as if evidence were genuinely absent from the source.
4. **No bounds, no guard.** `maxDepth`/`maxNodes`/`maxEdges`/`maxPaths`, the
   cycle-safe simple-path rule, the deterministic BFS ordering, and the
   response-byte guard all live in the engine. A recursive CTE written by a host
   has none of them — one cyclic corpus and the viewer hangs or OOMs.
5. **No auth, no project binding, no read-only mode.** MCP auth, session-level
   project binding, and read-only enforcement are engine concerns. Filesystem
   access to the index bypasses every one, so a viewer with read access to a
   directory has full read access to all of it.
6. **Locking and concurrency.** The engine owns the connection lifecycle. An
   external reader opening the same file concurrently invites lock contention
   and reads torn across an in-flight reindex or bulk write.
7. **Writes are unrecoverable.** A host that writes to `_backend/` writes to a
   cache. The next `maad reindex` erases it, markdown never learns about it,
   there is no git commit, and no validation ran. This is data loss that looks
   like success until the rebuild.
8. **The audit trail disappears.** Writes through the engine produce git
   commits; that trail is the project's history. Side-channel writes are
   invisible to `maad_history` and `maad_audit`.

**Rule:** if a host needs data the MCP surface does not expose, that is a
request to Master for an engine read primitive — a Tier 1 primitive, argued on
the framework's own criteria. It is never a license to open the SQLite file.

### Egress

One more failure mode, orthogonal to `_backend/`: rendering by uploading. Some
diagram pipelines render by POSTing the diagram source to a hosted service.
Diagram source built from a corpus **contains that corpus's record ids, field
labels, and often names**. A host skill must render locally by default, and must
require explicit operator consent before sending any generated diagram source or
report to an external service. The engine never does this; a host must not do it
accidentally on the engine's behalf.

---

## 7. Non-goals

- No new MCP tools, no changes to traversal or path algorithms
- No renderer, layout engine, chart library, or HTML surface in this repo
- No graph query language, triple store, or second index
- No proposal to build Shape C in this repo, in any wave
- No version bump, tag, or publish from this work

---

## 8. Open questions for Master

1. **CLI export gap (§3.7).** `relationship_paths`, `join`, and `aggregate` have
   no CLI command, so batch/offline export requires MCP or the library. Is a
   read-only, JSON-to-stdout CLI command for those three in scope as a Tier 1
   addition, or is MCP-only the intended posture?
2. **Labels in path responses.** Every renderer needs a display label and must
   currently make a second `maad_join` call to get one. Is an optional
   projected-label field on `relationship_paths` nodes worth considering later,
   or is the second call the correct cost of keeping the tool bodiless?
3. **Managed vs overlay for the export contract (§2).** Does the §3 contract
   reference eventually become a managed skill, an `_skills/local` template, or
   stay entirely in host documentation?
4. **Sibling repo for Shape C.** If a viewer is ever wanted, does it get its own
   repo up front, or start as a host skill emitting a self-contained HTML file
   with no server?
5. **Saved views as records.** If viewer state should be durable and shared, it
   implies a schema for it. Is that a MAADB-side schema-pack concern or purely
   the viewer's own storage?
