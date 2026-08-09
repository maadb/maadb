// ============================================================================
// Corpus Explorer skill — managed instruction generator (fully static).
// ============================================================================

export function generateCorpusExplorerSkill(): string {
  return `# Mapping an Unfamiliar Project

> Managed by the MAADb engine — do not edit (changes block future refreshes).
> Project-specific corpus maps belong in \`_skills/local/corpus-map.md\`.
> Never append session notes to this skill file.

## Purpose

You are an agent landing in a MAADB project you did not build and do not
know. This skill is a staged exploration protocol that takes you from zero
to a **written, typed map of the corpus** — what the record types are, how
they connect, how dense the graph is, where it is broken — using cheap,
bounded reads. The protocol front-loads index-backed tools and defers
full-body reads to the end, so orientation cost stays flat even on large
corpora.

Audience: any agent with reader access. The final stage writes one overlay
file, which needs writer access (skippable — report the map in chat instead).

## When to load this skill

- First session in a project whose \`maad_summary\` you have never seen.
- You've been handed a task referencing types or records you can't place.
- Before proposing schema or convention changes to an inherited corpus —
  map first, judge second.
- Periodically on long-lived projects, to refresh a stale corpus map.

If \`maad_summary\` shows an **empty** project, stop — this skill maps
existing data. Enter Architect mode instead (\`_skills/architect-core.md\`).

## Ground rules

- **Never** map a corpus by listing or reading files directly — all reads go
  through MCP tools, and the index is faster than you.
- Match read shape to need (\`hot\` → fields, \`warm\` → one section, \`cold\` →
  full body). In this protocol, \`cold\` appears only in Stage 3, on a
  handful of records.
- Everything you write into the map must be grounded in a tool result from
  **this** session; counts you intend to publish go through
  \`maad_verify mode=count\` first.
- Watch \`_meta.warnings[]\` on every response — orientation is exactly when
  you want to notice degraded subsystems or drift signals early.

## The protocol

Six stages. Each produces a section of the final map; you can stop early
and still hold a partial map (that's a feature — Stage 6 records what was
*not* explored, and a truncated map that says so is still trustworthy).

### Stage 0 — Bind and capabilities

On multi-project servers: \`maad_projects\`, then \`maad_use_project\` (bindings
are fixed per session). Then \`maad_describe\`: project overview, stats, and
\`capabilities\` — notably whether relationship paths and semantic search are
available in this deployment, which decides your Stage 4 toolkit.

### Stage 1 — Summary: the shape

\`maad_summary\` once. Extract into notes:

- Type inventory with counts — your candidate class list.
- Sample doc IDs per type — seeds for Stages 3–4.
- Warnings: broken refs and validation errors reported here are your first
  hygiene signal; carry them to Stage 5, don't chase them yet.

Skim \`MAAD.md\` and list \`_skills/\` — an existing \`_skills/local/\` overlay
(prior conventions, an earlier corpus map) changes your job from *mapping*
to *verifying and updating a map*.

### Stage 2 — Schema: the intended graph

For each type from Stage 1: \`maad_schema <type>\`. Build two tables as you
go:

1. **Type table** — required fields, enums (the project's controlled
   vocabularies), indexed fields (what the project's builders expected to
   query — intent fossilized in config).
2. **Edge table** — every \`ref\` / \`list[ref]\` field: source type, field
   name, target type. This is the **intended** graph, before you've looked
   at a single record.

Note the file-strategy signal: types whose records are few but block-heavy
are transaction-pattern (entries appended under parents — see
\`_skills/schema-guide.md\`); their real "record count" is blocks, not files,
and their parent ref is usually the corpus's highest-volume edge.

### Stage 3 — Samples: the actual records

Per type, cheapest first:

- \`maad_get <sample-id> hot\` on 1–2 samples — do real records fill the
  schema's fields? Sparse optional fields here foreshadow a sparse graph.
- \`maad_query\` with a projection of 3–4 key fields, small limit — the
  spread, not just the sample (status distributions, date ranges).
- \`maad_get <id> cold\` on **one or two** records total, for narrative
  texture: are bodies annotated (\`[[type:value|label]]\`)? Do they name
  other records in prose?
- \`maad_search primitive=entity limit=20\` (then other primitives that the
  domain suggests) — is the annotation layer in active use, and with which
  subtypes? Remember frontmatter string fields index as \`primitive=entity,
  subtype=<field-name>\`, so search results mix field values and body
  annotations; the subtype tells you which.
- Where \`maad_describe\` said semantic search is enabled,
  \`maad_semantic_search\` with 2–3 domain phrases is a cheap probe for
  themes the schema doesn't capture. Degraded responses say so — fall back
  without guessing.

### Stage 4 — Related and paths: the realized graph

Now compare the intended graph (Stage 2) with reality.

1. **Measure edge usage with aggregates, not iteration.** For each edge in
   the Stage 2 table: \`maad_aggregate docType=<source> groupBy=<ref-field>\`.
   Group count ≈ how many distinct targets are actually referenced; a
   near-empty result means a declared-but-unused edge. This also hands you
   the **hubs** — target IDs with the largest groups.
2. **Walk the hubs.** For the top 2–3 hubs: \`maad_related direction=both\`,
   then

   \`\`\`
   maad_relationship_paths
     startDocId: <hub>
     direction: both
     maxDepth: 2
   \`\`\`

   Organize by \`nodes[].distance\`. Check \`truncation.truncated\` /
   \`limitsReached\` before concluding anything about reach — a truncated
   traversal is a lower bound.
3. **Probe the observed-vs-intended gap.** Re-run one hub's paths with
   \`extractionKinds: ["ref", "mention"]\`. Many \`mention\` edges beyond the
   \`ref\` edges = structure living in prose = densification opportunity
   (that's the graph/ontology skill's Recipe 4 — record it, don't fix it
   mid-mapping). Few mentions *and* few refs on a corpus whose bodies
   clearly name other records (Stage 3) = links invisible to tooling
   entirely; note that too.
4. Cross-type detail questions that surface here ("which open cases belong
   to which client industry?") are \`maad_join\` / ref-chain
   \`maad_aggregate\` one-liners — use them to spot-check, resist per-record
   loops.

### Stage 5 — Integrity: where the graph is broken

- \`maad_find_orphans\` — per-record broken-ref inventory (which ref fields
  point at nonexistent targets).
- \`maad_verify mode=integrity\` — the wider sweep (index/document drift,
  schema drift) — cheap insurance that what you just mapped is what's
  actually on disk, especially if the project sees external edits.

Findings go **in the map**, not into ad-hoc repair: repair tools follow
dry-run-then-confirm contracts and deserve a deliberate pass, and on
read-only deployments mutation isn't yours to do (\`READ_ONLY\` — report,
don't retry).

### Stage 6 — Write the typed map

Deliverable: \`_skills/local/corpus-map.md\` — a project-owned overlay file
(engine refresh never touches it). Create or update; if one existed
(Stage 1), preserve its history notes and update the snapshot. Suggested
shape:

\`\`\`markdown
# Corpus Map — <project> (as of <date>)

## Types
| type | count* | pattern | purpose (one line) | key fields |

## Edges (intended vs realized)
| ref field | source → target | declared | usage (aggregate) | mention overflow? |

## Annotation practice
Primitives/subtypes in active use; whether doc-ID mentions are annotated.

## Hubs
Top hub records and what clusters around them (path-walk findings).

## Hygiene
Broken refs / orphans / drift found in Stage 5. Unfixed — inventory only.

## Not explored
Types sampled shallowly, truncated traversals, stages skipped.

## Open questions
Anything the corpus couldn't answer about itself.

*counts verified via maad_verify mode=count on <date>
\`\`\`

The map is a **snapshot of project truth, owned by the project** — exactly
what \`_skills/local/\` is for. It is not engine documentation; never put
engine-version facts in it (they rot — \`MAAD.md\` owns those).

If you lack writer access, deliver the same content as your session report.

## After the map — handoffs

- Sparse realized graph, rich mention/prose links → load the
  graph/ontology skill (\`_skills/graph-ontology.md\`) and run its
  densification recipe against the map's "mention overflow" column.
- Schema gaps or evolution needs → Architect mode
  (\`_skills/architect-core.md\` + \`_skills/schema-guide.md\`).
- Broken refs / drift → a deliberate hygiene pass with the repair tools'
  dry-run contracts; the map's Hygiene section is its worklist.

## Non-goals / hand off to the host

- No visualization: the map is markdown tables. Rendering it as an
  interactive graph or dashboard is host-side work — never engine core.
- No repair during mapping — inventory only (Stage 5).
- No schema edits during mapping — the map may *recommend*; Architect
  executes.
- No file-system spelunking — if a question can't be answered through the
  tool surface, that inability is itself a finding for the map.
`;
}