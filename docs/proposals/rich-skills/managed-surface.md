# Rich Skills Pack — Managed-Instruction Surface Plan

Status: proposal. Companion to [`README.md`](README.md) and
[`architecture.md`](architecture.md).

**Audience:** the maintainer deciding whether to promote the two skill drafts
into `MANAGED_ARTIFACTS`, and whoever implements that promotion later.

`architecture.md` decides *where each skill lives*. This document is the
mechanical follow-through: exactly which files a promotion PR touches, what
the manifest lifecycle does to existing projects the moment a new artifact is
registered, and what has to be true before that PR can merge.

**No code in this wave.** Everything below describes a *future* PR.

---

## 1. Promotion calls

| Draft / capability | Call | Artifact name | Path |
|---|---|---|---|
| Graph / ontology skill | **Promote to managed** (after Phase 1 overlay validation) | `graph-ontology` | `_skills/graph-ontology.md` |
| Corpus explorer skill | **Promote to managed** (after Phase 1) | `corpus-explorer` | `_skills/corpus-explorer.md` |
| Structure evolution (schema bumps under densification pressure) | **No new artifact** — extend `generateArchitectSkill()` and `generateSchemaGuide()` | — | — |
| Report / view composition (`maad_join` + `maad_aggregate` → markdown) | **No new artifact** — recipes inside the two promoted skills | — | — |
| Project ontology conventions | **Never managed** — agent-authored overlay | — | `_skills/local/ontology.md` |
| Corpus map / source-ID notes | **Never managed** — agent-authored overlay | — | `_skills/local/corpus-map.md` |
| Visualization, publishing, UIs | **Never in this repo** | — | see [`host-boundary.md`](host-boundary.md) |

Net effect of the promotion PR: `MANAGED_ARTIFACTS` goes from **4 to 6**
entries. Two existing generators grow. Nothing is renamed or removed.

### Why only two become managed

The managed set is the engine's *versioned pedagogy*: content that is a pure
function of the engine version and must move in lockstep with tool renames and
cap changes. Both promoted skills are exactly that — they teach the shape of
`maad_related` / `maad_relationship_paths` / `maad_join` / `maad_aggregate`
and nothing about any particular domain.

The two overlay files are the opposite: they are *outputs* of running the
skills against a specific corpus. Managing them would force an engine release
every time a project renamed a type. The engine ships the method; the project
owns the results.

Structure evolution and report composition are deliberately **not** third and
fourth artifacts. Both are small bodies of guidance that already have a home
(`architect-core` / `schema-guide` for evolution; the two new skills for
composition recipes). Every extra artifact is a permanent name, a permanent
stamp, a permanent line in every project's `_skills/` directory, and one more
file that goes `outdated` on every release. Fragmenting guidance across six
skill files is a worse outcome than two slightly longer ones.

---

## 2. Exact touch points

Line numbers are against base `b1806d30` (engine 0.14.0) and are pointers, not
promises — re-locate before editing.

### 2.1 Files that must change

| File | Change |
|---|---|
| `src/skills/graph-ontology.ts` *(new)* | `export function generateGraphOntologySkill(): string` — one template literal, fully static |
| `src/skills/corpus-explorer.ts` *(new)* | `export function generateCorpusExplorerSkill(): string` — same shape |
| `src/instructions/manifest.ts:26-28` | Add imports for the two new generators |
| `src/instructions/manifest.ts:55-60` | Add two `MANAGED_ARTIFACTS` entries |
| `src/maad-md.ts:119-123` | Add two bullets to the `## Skills` list |
| `src/architect.ts` | Fold in structure-evolution guidance (densification pressure → new ref fields) |
| `src/skill-files.ts` | Fold the matching schema-evolution detail into `generateSchemaGuide()` |
| `tests/instructions/lifecycle.test.ts:123` | **Breaks on the count change** — see §4.1 |
| `tests/instructions/generator-examples.test.ts:24-28` | Add both generators to the `GUIDES` map so the YAML + prose lints cover them |
| `README.md:372` | The `_skills/` tree comment ("architect, import, etc.") — extend or leave generic |
| `Version.md` | Entry at integration, minor bump (new managed artifacts are user-visible) |

**New modules rather than growing `src/skill-files.ts`.** That file is already
411 lines holding two unrelated guides; the existing split
(`maad-md.ts` / `architect.ts` / `skill-files.ts`) is by topic, not by
mechanism. A `src/skills/` directory with one file per generated skill is the
cleaner target, and the manifest is the only importer either way. If the
maintainer prefers not to add a directory, appending to `skill-files.ts` works
identically — this is a readability call, not a correctness one.

Sketch of the manifest edit:

```ts
// src/instructions/manifest.ts
import { generateGraphOntologySkill } from '../skills/graph-ontology.js';
import { generateCorpusExplorerSkill } from '../skills/corpus-explorer.js';

export const MANAGED_ARTIFACTS: readonly ManagedArtifact[] = [
  { name: 'maad-md',          relPath: 'MAAD.md',                     generate: generateMaadMd },
  { name: 'architect-core',   relPath: '_skills/architect-core.md',   generate: generateArchitectSkill },
  { name: 'schema-guide',     relPath: '_skills/schema-guide.md',     generate: generateSchemaGuide },
  { name: 'import-guide',     relPath: '_skills/import-guide.md',     generate: generateImportGuide },
  { name: 'graph-ontology',   relPath: '_skills/graph-ontology.md',   generate: generateGraphOntologySkill },
  { name: 'corpus-explorer',  relPath: '_skills/corpus-explorer.md',  generate: generateCorpusExplorerSkill },
];
```

Each generated body must open with the same header `MAAD.md` uses
(`src/maad-md.ts:14-15`) — "managed by the engine, do not edit; project
guidance goes in `_skills/local/`". That header is what keeps the file out of
the `modified` trap (§4.3).

### 2.2 Files that need **no** change (and why that matters)

Everything downstream of the manifest is registry-driven. Confirming this is
half the value of the plan — the promotion is a data change, not a machinery
change:

| Surface | Why it needs no edit |
|---|---|
| `src/skills-scaffold.ts:32` | Iterates `MANAGED_ARTIFACTS`; picks up new entries automatically |
| `src/instructions/manifest.ts` classify / plan / apply | Keyed on the artifact list, not on a fixed set of names |
| `src/cli/commands/maintain.ts:183-230` (`maad instructions check|refresh`) | Prints whatever `checkProject` / `planRefresh` return |
| `src/mcp/tools/maintain.ts:160+` (`maad_instructions`) | Same |
| `src/mcp/tools/discover.ts:98` (`maad_summary.instructionsStale`) | Same |
| `src/mcp/lifecycle.ts:40`, `src/instance/pool.ts:232` | Call `ensureProjectSkills`, which is registry-driven |
| `src/cli/commands/maintain.ts:158` (`maad reindex` staleness notice) | Same |

No manifest machinery change is required. The states, the force semantics, and
the boot-never-refreshes rule all handle new artifacts as-is.

---

## 3. Behavior that changes automatically on registration

These are *not* code edits — they are consequences of the two new entries, and
they are the part most likely to surprise a downstream project. Each one fires
the first time an existing project runs the new engine version.

1. **Scaffold writes the two new files on the next bind.**
   `ensureProjectSkills` is create-if-absent *per file*, not per project, and
   runs on MCP startup (`src/mcp/lifecycle.ts:40`) and on every pool bind
   (`src/instance/pool.ts:232`). A project that upgrades gets two new files
   written into its working tree without asking. See §4.2 — this is the
   sharpest migration risk in the set.
2. **`maad_summary` reports `instructionsStale`** for any project where the
   scaffold did not run (read-only deployments, `history_mode: read`,
   unwritable project dir). Agents see it in their normal boot call.
3. **`maad instructions check` exits 1** while the files are `missing`. Any
   downstream CI wired to that command fails on upgrade until a refresh lands.
4. **`instructions_outdated` fires in the ops log** on bind
   (`emitInstructionsAdvisory`, `src/skills-scaffold.ts:56`) for the same
   projects as (2).
5. **`MAAD.md` goes `outdated` everywhere**, because §2.1 edits its Skills
   list. So the release produces, per project: one `outdated` artifact and two
   `missing` ones. That is a normal, refreshable state — but it should be
   stated in the release notes rather than discovered.

---

## 4. Stamp / refresh migration risks

### 4.1 New artifacts classify `missing`, never `outdated`

`classifyContent` returns `missing` for an absent file
(`src/instructions/manifest.ts:101`), and `planRefresh` puts `missing` in the
refresh bucket alongside `outdated` (`:143-144`). So `maad instructions
refresh --apply` creates them with no `--force` needed. Correct behavior, but
it means the promotion cannot be made silent by any refresh-side flag: the
only way an existing project *doesn't* get the files is to never bind and
never refresh.

Concrete test breakage: `tests/instructions/lifecycle.test.ts:123` asserts
`expect(plan.current.length).toBe(2)` — a hard-coded count derived from
"4 artifacts, 2 made stale". It must become
`MANAGED_ARTIFACTS.length - 2` (or the test must construct its own artifact
list). This is a guaranteed red test in the promotion PR, not a maybe.

### 4.2 Scaffold-on-bind writes into a user's repo on upgrade

The documented promise is upgrade **inertness**:
`src/skills-scaffold.ts:9-12` — "an engine upgrade alone modifies zero files".
That promise is about *modification*, and it holds. But adding an artifact
means an engine upgrade **creates** two files in every writable project on the
next bind, unprompted, and the existing inertness test
(`lifecycle.test.ts:90`) only proves the case where every artifact is already
present — it cannot catch this.

Three options for the implementation PR, in order of preference:

- **(a) Accept and document.** Creating a skill file is additive, git-visible,
  and trivially revertible; the engine already does this for the initial four.
  Say so in the release notes and add a test that pins the behavior
  deliberately (§5) instead of leaving it implicit.
- **(b) Gate the scaffold to first-init only.** Scaffold only when *no*
  managed artifact exists; leave new artifacts in existing projects to
  `maad instructions refresh`. Cleaner consent story, at the cost of most
  projects never seeing the new skills, and a behavior change to a shipped
  path that is out of scope for a skills release.
- **(c) Per-artifact `scaffold: boolean`** on `ManagedArtifact` — a real
  manifest change, and the only option that adds machinery. Not worth it for
  two files.

**Recommendation: (a).** It preserves the existing contract exactly and adds
no machinery. But it should be a stated decision in the PR description, not an
accident — the difference between "creates" and "modifies" is precisely the
kind of nuance that gets flattened into "upgrades don't touch my files" by the
next reader.

### 4.3 The `modified` trap

Once a file classifies `modified` it is frozen: refresh skips it forever
without `--force` (`manifest.ts:145`). A skill that instructs agents to write
things is more exposed to this than a passive reference, because an agent
following the skill may "helpfully" append notes to the skill file itself.

Mitigations, all cheap:

- Open every generated body with the `MAAD.md`-style do-not-edit header.
- Have both skills state explicitly, in their own text, that project-specific
  findings go to `_skills/local/*.md` and that editing the skill file blocks
  future refreshes.
- Keep the recipes prescriptive about *where* agent-authored output lands
  (`_skills/local/ontology.md`, `_skills/local/corpus-map.md`), so there is
  never an ambiguous "write it down somewhere" instruction.

CRLF is already handled — `hashBody` normalizes line endings
(`manifest.ts:66-67`) — so a Windows checkout will not mass-`modified` the new
files.

### 4.4 Phase 1 overlay copies must live under `_skills/local/`

`architecture.md` Phase 1 hand-installs the drafts for validation. Where they
are installed decides how bad the Phase 2 collision is:

- Installed at **`_skills/local/graph-ontology.md`** (the specified path):
  no collision. The managed file lands at a different path. The tester deletes
  the stale copy when convenient; until then the only cost is duplicated
  guidance.
- Installed at **`_skills/graph-ontology.md`** (the eventual managed path):
  the file has no stamp, so it classifies `unmanaged`, and refresh **skips it
  without `--force`** (`manifest.ts:146-147`). The project silently keeps a
  pre-release draft while believing it is on the shipped skill.

So Phase 1 instructions must be explicit: **validation copies go under
`_skills/local/` only.** Worth stating in the release notes too, for anyone
who copied a draft out of this proposal directory.

### 4.5 Names freeze at promotion

The classifier keys on the stamp `name` (`manifest.ts:62`). Renaming
`graph-ontology` later leaves the old file on disk as `unmanaged` — invisible
to refresh, still readable by agents, and now wrong. Both artifact names and
both paths are settled at merge time.

Both chosen names are content-descriptive rather than version- or
vendor-scoped, which is what makes them survivable. Avoid anything like
`graph-v2` or a name tied to a specific tool.

### 4.6 The static-content contract

Managed generators take no arguments and read no project state — see
`ManagedArtifact.generate: () => string` (`manifest.ts:47`) and the `MAAD.md`
rationale (`maad-md.ts:4-8`). Any live count, path, or project fact in a
generated body would change the content hash per project and break
classification outright. The two drafts are written to this contract; the
promotion PR needs a test that keeps them there (§5).

### 4.7 Package and public exposure

Generators ship in the npm tarball. Both skill bodies are tracked source in a
public repo and go through the same review as any other tracked file: no
emails, no hostnames, no internal identifiers, no organization-internal
workflow names.

---

## 5. Tests to add later

Existing suites the PR must update:

| Test | Change |
|---|---|
| `tests/instructions/lifecycle.test.ts:123` | Replace the hard-coded `2` with a count derived from `MANAGED_ARTIFACTS.length` — otherwise red |
| `tests/instructions/generator-examples.test.ts:24-28` | Add both generators to `GUIDES`; the YAML-parse, real-loader, and prose lints then cover them for free |

New tests worth writing, highest value first:

1. **Tool-name drift guard.** Extract every `maad_[a-z_]+` token from each
   generated skill body and assert it is a tool the server actually registers.
   The name set can be scanned from `src/mcp/tools/*.ts` (`registerTool('…')`)
   at test time. This is the single test that justifies the managed placement:
   the whole argument for shipping these skills with the engine is that they
   stay in lockstep with the tool surface, and nothing enforces that today.
2. **Static-content guard for the new skills.** Mirror
   `generator-examples.test.ts:226` — no machine paths (`C:\`, `/tmp/`,
   `/home/`, `/Users/`), no engine invocation paths, no interpolated state.
3. **Skills-list drift guard.** Assert that every `MANAGED_ARTIFACTS` entry
   whose `relPath` starts with `_skills/` is named in the `## Skills` section
   of `generateMaadMd()`. Cheap, and it catches the most likely omission in
   this PR and in every future one.
4. **Placement-boundary guard.** Assert no `MANAGED_ARTIFACTS` entry has a
   `relPath` under `_skills/local/`. Encodes the architecture decision as a
   test rather than a convention.
5. **Steering assertions**, in the style of
   `tests/engine/agent-instruction-rules.test.ts`. At minimum: the graph skill
   mentions `maad_relationship_paths` (not just repeated `maad_related`); the
   corpus-explorer skill mentions `maad_summary`, `maad_schema`, and
   `maad_find_orphans`; both name `_skills/local/` as the destination for
   project-specific output.
6. **New-artifact scaffold behavior.** A project holding only the *original*
   four artifacts, then scaffolded: assert the two new files are created and
   the four existing ones are byte- and mtime-identical. Pins the §4.2
   decision explicitly instead of leaving it to be rediscovered.
7. **Refresh from a 4-artifact vintage.** `missing` → `refresh` bucket without
   `--force`; all six `current` afterward.

---

## 6. Acceptance checklist for the follow-on implementation PR

Copy into the PR description. No code lands in this wave.

**Scope**

- [ ] Phase 1 overlay validation ran in at least one real project, and the
      resulting friction is folded into the drafts
- [ ] Artifact names and paths confirmed final (§4.5) — they cannot be changed
      after release without orphaning files

**Implementation**

- [ ] Two generator modules added; both take no arguments and read no project
      state
- [ ] Both bodies open with the do-not-edit / `_skills/local/` header
- [ ] Two `MANAGED_ARTIFACTS` entries registered
- [ ] `MAAD.md` Skills list updated
- [ ] Structure-evolution guidance folded into `architect-core` /
      `schema-guide` in the same release
- [ ] Every tool name referenced in either skill exists in the shipped tool
      surface
- [ ] No engine machinery changed — diff touches generators, the manifest
      list, `MAAD.md`, and tests only

**Tests**

- [ ] `lifecycle.test.ts` count assertion fixed
- [ ] Both generators added to `generator-examples.test.ts` `GUIDES`
- [ ] Tests 1–7 from §5 added (or each one explicitly waived in the PR
      description with a reason)
- [ ] Full suite green

**Migration**

- [ ] §4.2 decision (accept scaffold-on-upgrade, or gate it) stated in the PR
      description
- [ ] Release notes cover: two new files appear on next bind; `MAAD.md` goes
      `outdated`; `maad instructions check` exits 1 until refresh; validation
      copies belong under `_skills/local/` only
- [ ] Read-only deployments noted — they will report `instructionsStale`
      persistently and cannot self-heal (§7, open question 2)

**Release**

- [ ] Minor version bump (new user-visible managed artifacts)
- [ ] `Version.md` entry
- [ ] Public-repo review of both generated bodies

---

## 7. Open questions for the maintainer

1. **Is scaffold-on-upgrade acceptable?** §4.2 recommends accepting it (two
   new files created, unprompted, on the next bind after upgrade) as the
   smallest, most consistent option. If unacceptable, the alternative is
   gating the scaffold to first-init — a behavior change to a shipped path
   that should be its own PR, not part of a skills release.
2. **Read-only deployments will never converge.** They cannot scaffold and
   cannot refresh, so `maad_summary.instructionsStale` reports `missing` for
   the new files permanently. Options: accept the noise; exclude `missing`
   from the `maad_summary` advisory on read-only deployments; or ship a
   distinct signal for "cannot be fixed here". Recommend accepting for now and
   revisiting only if it proves noisy in practice — but it is a real, new,
   permanent warning on those deployments.
3. **New modules or grow `skill-files.ts`?** §2.1 recommends
   `src/skills/<name>.ts`. Purely a readability call.
4. **Should the two overlay paths (`_skills/local/ontology.md`,
   `_skills/local/corpus-map.md`) be named in the managed skills?** Naming
   them makes agent output predictable across projects and makes the
   boundary teachable. The cost is that the engine now has an opinion about
   files it will never manage. Recommend naming them, as conventions rather
   than requirements.
5. **Does `MAAD.md` need more than two bullets?** The Skills list is a bare
   index today. If agents are expected to *choose* between six skills, a
   one-line "load this when…" per entry may be needed — which grows the file
   that is loaded on every boot. Deferred to the promotion PR.
