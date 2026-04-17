# MAADB Framework

## What MAAD Is

A database engine that treats markdown files as canonical records and provides deterministic read/write access through a structured interface.

Markdown remains the source of truth, while schemas and indexing make records queryable, linkable, and easier to work with programmatically. It is designed for document-centric data where structured fields and narrative context need to live together in the same record.

## Data Doctrine

1. **Markdown is canonical.** The markdown file is the record — structured fields in frontmatter, addressable sections via headings, narrative in the body.

2. **The parser is interpretive, not authoritative.** The engine reads and indexes what the markdown says. It does not decide what the markdown should say.

3. **All writes go through the engine.** No direct file edits. This preserves validation, indexing, and the git audit trail.

4. **YAML is the interface language.** Registry, schemas, and configuration are YAML. YAML syntax, MAAD semantics.

## Extraction Primitives

The engine recognizes 11 built-in primitives for inline annotation extraction (`[[type:value|label]]`). These are the atomic categories for classifying extracted objects.

| Primitive | What it captures | Example annotation |
|-----------|-----------------|-------------------|
| `entity` | People, organizations, things | `[[entity:Jane Smith\|Jane]]` |
| `date` | Dates and timestamps | `[[date:2026-03-28\|March 28]]` |
| `duration` | Time spans | `[[duration:6 months\|half a year]]` |
| `amount` | Money / currency values | `[[amount:1250000 USD\|$1.25M]]` |
| `measure` | Measurements with units | `[[measure:42 kg\|weight]]` |
| `quantity` | Counts and numbers | `[[quantity:150\|headcount]]` |
| `percentage` | Percent values | `[[percentage:12.5%\|growth rate]]` |
| `location` | Places, addresses | `[[location:Austin, TX\|office]]` |
| `identifier` | IDs, codes, reference numbers | `[[identifier:INV-2026-0042\|invoice]]` |
| `contact` | Email, phone | `[[contact:jane@acme.com\|email]]` |
| `media` | File references, URLs | `[[media:report.pdf\|attachment]]` |

### Extensibility via subtypes

The 11 primitives are fixed — they cover the general case and each has a deterministic normalizer. Domain-specific categories extend via custom subtypes in the registry's `extraction.subtypes` config, not by adding new primitives.

```yaml
# _registry/object_types.yaml
extraction:
  subtypes:
    attorney: entity
    filing_date: date
    equation: entity
    chemical_formula: entity
```

This gives projects domain-specific tagging and search (`[[entity:equation|E = mc²]]`) without engine changes. A new primitive is only justified when there's a distinct normalization path that subtypes can't cover.

## Tier Model

The engine is lean. The LLM is smart. Push composition up, keep primitives down.

### Tier 1 — Primitive Engine

Single deterministic pass. One input, one output. No composition, no judgment.

**Test:** Can this operation complete with one backend query or one file read? If yes, it belongs here.

| Command | Operation |
|---------|-----------|
| `scan` | Structural analysis of raw markdown (no registry needed) |
| `summary` | Index-backed project snapshot + warnings (broken refs, validation errors) |
| `describe` | Project overview from registry + stats |
| `get hot` | Read frontmatter + version + updatedAt from file |
| `get warm` | Read frontmatter + one block via line pointers |
| `get cold` | Read full file body |
| `query` | Find documents by type + field filters + projection + sort |
| `search` | Find extracted objects by primitive/subtype/value |
| `related` | Graph traversal — outgoing/incoming/both |
| `schema` | Field definitions, ID prefix, format hints |
| `aggregate` | Group by field + optional metric (count/sum/avg/min/max) |
| `join` | Query + follow refs + project fields from both sides |
| `verify` | Fact-check a field value or document count — grounded/not-grounded + source |
| `create` | Write new record + index + git commit |
| `update` | Modify record + reindex + git commit (frontmatter guarded) |
| `delete` | Remove record (soft/hard) + git commit |
| `bulk_create` | Create multiple records + single git commit + read-back verification |
| `bulk_update` | Update multiple records + single git commit + read-back verification |
| `validate` | Check record(s) against schema |
| `reindex` | Rebuild index from markdown |
| `reload` | Reload registry + schemas without restart |
| `health` | Engine status, recovery actions, provenance mode |
| `parse` | Parse one file, return structure |
| `history` | Git log for one document |
| `audit` | Git log for project (date-inclusive) |
| `changes_since` | Opaque-cursor delta feed — records modified since a cursor point, ordered on `(updated_at, doc_id)` |

### Tier 2 — Deterministic Composite

Bundled convenience operations. Multiple internal calls, zero judgment. Exists to reduce LLM tool chatter when the composition pattern is common and the result is always the same.

**Test:** Is it deterministic composition with no reasoning? Does it measurably reduce call count for a common pattern?

Composites are **provisional** until validated by real MCP usage data. They earn their place; they are not assumed.

| Command | Composition | Status |
|---------|-------------|--------|
| `get full` | get hot + related + search + resolve refs | Provisional — evaluate after MCP |

### Tier 3 — Agent Workflow

Multi-step reasoning, cross-document analysis, conditional logic. The LLM orchestrates primitives. These live in skill files, workflow configs, or agent prompts — never in the engine.

**Test:** Does it require judgment, branching, or context-dependent decisions? If yes, the LLM composes it.

**Examples:**
- "Review all open cases and summarize risk" — multi-doc reasoning
- "Inspect a document" — compose: get hot + validate + related + search
- "Onboard this folder of files" — compose: scan dir + propose types + create registry + add frontmatter + reindex
- "Tag all person entities as confidential" — policy application across records

**Composition patterns** are documented in MAAD.md so the LLM knows how to build these from primitives.

## Engine Design Principles

1. **Lean.** Minimal dependencies. No frameworks. Every engine operation should be fast enough that the LLM doesn't notice latency.

2. **Fast.** Synchronous SQLite reads. File reads via line pointers. No hidden reindex or git walks in read paths.

3. **Scalable.** One project, one index, one process. Horizontal scale comes from running multiple instances, not from engine complexity.

4. **Deterministic.** Same input, same output. No inference, no heuristics, no LLM calls inside the engine. The engine is a tool, not a thinker.

5. **Composable.** Primitives are small enough that the LLM can combine them. Convenience composites are provisional and must justify their existence with usage data.

## Adding New Commands

Before adding a command to the engine, apply these criteria:

1. **Single-pass test.** Can it complete in one deterministic operation? If yes, it's a primitive.
2. **Composition test.** Is it a common pattern of 3+ primitives with no judgment? Candidate for provisional composite. Require usage data before promoting.
3. **Judgment test.** Does it require reasoning, branching, or context? Agent workflow. Document the composition pattern. Don't build it into the engine.

When in doubt, leave it out. The LLM can compose. The engine cannot uncommit complexity.

## Offloading Model

The engine handles the fast path. Everything else pushes up.

| Concern | Where it lives |
|---------|---------------|
| Parse, index, CRUD, search, validate | Engine (Tier 1) |
| Common bundled reads | Engine composite (Tier 2, provisional) |
| Multi-step reasoning, analysis, reporting | Agent skill files / prompts (Tier 3) |
| Microsoft 365, email, calendar, APIs | External bridges (separate repos) |
| Workflow rules ("when X, do Y") | Agent layer, not engine |
| Object attributes / tagging policies | Engine when built, applied via engine tools |

The engine is the data layer. The agent is the reasoning layer. They do not cross.
