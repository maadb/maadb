# Rich Skills Pack — Proposal

Status: **proposal / draft-only**. Nothing in this directory ships with the
engine yet. No `src/**` changes are proposed for this wave.

## Problem

MAADB already has the primitives of a typed information graph:

- `ref` / `list[ref]` schema fields → explicit relationship edges
- inline `[[type:value|label]]` annotations → extracted objects and `mention` edges
- `maad_related` (1-hop), `maad_relationship_paths` (bounded multi-hop with
  evidence, since 0.13.0), `maad_join`, ref-chain `maad_aggregate`
- integrity surfaces (`maad_verify mode=integrity`, `maad_find_orphans`)

But the shipped skill files (`MAAD.md`, `_skills/architect-core.md`,
`_skills/schema-guide.md`, `_skills/import-guide.md`) teach agents how to
**operate and build** a project — not how to **explore** one they didn't
build, or how to **densify** a loosely-linked corpus into a typed graph.
Agents that don't know the composition patterns fall back on repeated
`maad_related` calls, raw `maad_get cold` sweeps, or — worse — asking for
engine features (query languages, graph views) that the Tier model
deliberately keeps out of core.

## What this pack is

A set of **Tier 3 agent workflow skills** (per `docs/framework.md`, the
Offloading Model): judgment and composition live in skill files; the engine
stays lean. Every recipe in this pack composes **existing** MCP tools —
no new engine commands, no query language, no visualization in `@maadb/core`.

## Documents in this pack

| Doc | What it covers |
|---|---|
| [`architecture.md`](architecture.md) | Placement matrix — managed vs `_skills/local/` overlay vs host-only; stamp/refresh implications; phased delivery recommendation |
| [`graph-ontology-skill.md`](graph-ontology-skill.md) | Agent-facing skill draft: treat the project as a typed graph — typed refs, promoting prose mentions to structure, choosing among `maad_related` / `maad_relationship_paths` / `maad_join` / ref-chain `maad_aggregate` |
| [`corpus-explorer-skill.md`](corpus-explorer-skill.md) | Agent-facing skill draft: map an unfamiliar project — summary → schema → samples → related/paths → orphans → written typed map |
| [`managed-surface.md`](managed-surface.md) | Companion analysis of the managed-instruction surface (generator/lifecycle detail) |
| [`host-boundary.md`](host-boundary.md) | Companion analysis: what stays host-side — visualization, UIs, report publishing |

The two skill drafts are written **as the skill text agents would load**, each
with a proposal preamble (purpose, placement intent, open questions) that
would be dropped at promotion time.

## Goals

1. Agents can build denser information structures (typed graphs, light
   ontologies, corpus maps, cross-type reports) on top of MAADB using only
   the current tool surface.
2. A clear, unambiguous placement rule for every future skill: shipped with
   the engine (managed + stamped), owned by the project (`_skills/local/`),
   or owned by the host environment (never in this repo).
3. No engine bloat: anything requiring judgment stays in skills; anything
   requiring pixels stays in the host.

## Non-goals

- New MCP tools or changes to relationship-path traversal
- Cypher/SPARQL-style query languages, admin UIs, or graph renderers in core
- Version bump or release work — this wave is proposal markdown only

## How the pieces fit

```
docs/framework.md (Tier model)        ← doctrine: what may live where
        │
architecture.md                       ← placement decisions + delivery phases
        │
        ├── graph-ontology-skill.md   ← densify: prose → typed structure
        ├── corpus-explorer-skill.md  ← orient: unfamiliar project → typed map
        ├── managed-surface.md        ← how promotion to managed would work
        └── host-boundary.md          ← what is explicitly out of scope for core
```

The two skills are complementary and cross-reference each other: the corpus
explorer ends where the graph/ontology skill begins (a typed map surfaces the
gaps; the graph skill closes them). Both hand schema *changes* to the existing
Architect skill (`_skills/architect-core.md`) rather than duplicating it.

## Review questions for the maintainer

1. Do the placement calls in `architecture.md` match the intended scope of
   `MANAGED_ARTIFACTS` (currently four artifacts, all fully static)?
2. Are the two skill drafts the right *first two*? (Report/view composition
   is folded into both as recipes rather than a third standalone skill —
   see `architecture.md` § Report composition.)
3. Is the phased path (overlay validation → managed generator promotion)
   acceptable, or should promotion be immediate in the next wave?
