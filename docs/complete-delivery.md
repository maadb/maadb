# Complete contract and receipt delivery

Guarded writes remain enforced inside MAADB. A client verifies its complete
schema contract at setup, saves the approved `schemaDigest`, then supplies that
64-character expectation on each `guarded-create-v1` write. It does not need to
read the full contract before every write. A schema mismatch requires explicit
review and setup again; never automatically adopt the new digest.

## Response budgets and migration

| Setting | Default | Scope |
| --- | --- | --- |
| `MAAD_RESPONSE_MAX_BYTES` | 65,536 | Ordinary engine-bound MCP results |
| `MAAD_CONTRACT_RESPONSE_MAX_BYTES` | 131,072 | Create contracts, document receipts, guarded-create acknowledgements |

The contract setting has an unconditional 1,048,576-byte ceiling. Invalid or
nonpositive contract settings use the default. It is independent of the
ordinary response budget: deployments that previously used the shared setting
to constrain contracts must explicitly configure the new setting. To retain a
64 KiB limit for both categories, set both to `65536`. This is a configuration
behavior change, not a change to either v1 digest or the legacy result shape.

Size means UTF-8 bytes of the serialized **MCP result object**, including its
`content` wrapper, escaped JSON text, provenance and request metadata. JSON-RPC
framing, HTTP headers and transport framing are outside this budget. Previously,
ordinary list guards counted only their inner text. A response near the old
limit may now require smaller projections or pages. Final checks apply after
metadata to every engine-bound result; existing error responses are preserved.
These caps bound delivered results, not all query execution or allocation costs.

The operational target is a complete setup result below **100,000 bytes**.
The 128 KiB allowance is headroom, not a guaranteed maximum schema size or a
client completeness guarantee. Larger observations use bounded pages. The
schema snapshot's existing 256 KiB source and 512 KiB canonical bounds remain.

## Opt-in complete delivery

`maad_create_contract` and `maad_document_receipt` accept an optional `delivery`.
Omitting it preserves their existing complete v1 data shape.

```json
{
  "contract": "create-contract-v1",
  "docType": "note",
  "delivery": { "format": "compact-json-v1", "maxBytes": 65536 }
}
```

Use the normal receipt request with the same `delivery` option for large exact
document evidence. `maxBytes` is an integer from 8,192 to 1,048,576, clamped to
the server contract allowance; omission uses that allowance. It does not reserve
request capacity or change document size limits.

The returned `data` is a `complete-json-v1` delivery page:

| Field | Meaning |
| --- | --- |
| `encoding` | `shape-json-v1`, the lossless encoding below |
| `snapshotId` | Opaque identity for this complete observation |
| `digest` | SHA-256 of canonical JSON of the entire expanded v1 result data |
| `packedDigest` | SHA-256 of UTF-8 bytes of the concatenated packed JSON text |
| `totalBytes` | UTF-8 bytes of that packed JSON text |
| `totalCharacters` | Length of that text in UTF-16 code units |
| `offset`, `endOffset` | Half-open UTF-16 offsets of `chunk` |
| `expiresAt` | Unix time in milliseconds, five minutes from the initial observation |
| `complete` | True only on the terminal page |
| `nextCursor` | Opaque continuation, or null on the terminal page |
| `chunk` | Exact substring of the packed JSON text |

Repeat the same request with `delivery.cursor` set to `nextCursor`. Keep the
same engine, bound session, project, document parameters and page budget. Treat
the cursor as opaque. Read retries can return the same page; do not append a
duplicate. A terminal page alone is not complete evidence unless its offset
starts at zero or all earlier contiguous pages have already been collected.

Every page performs the usual live authorization, readiness and cancellation
checks. Contract continuations also freshly observe dependencies and history;
any complete observation change invalidates the retained snapshot. Receipt
continuations freshly compare all evidence except `observedAt`, which retains
the first observation's timestamp. Changing content, Git evidence, working-tree
state or policy requires a new read. Retained evidence never grants write access.

Unknown, expired, evicted, cross-session, cross-engine, mismatched or changed
cursors return `RECEIPT_OBSERVATION_CHANGED`. Discard the entire partial result
and restart the read. This can also happen during sustained competing setup
reads. Restarting or replacing an engine invalidates its pending delivery.

## Reconstruction and verification

Concatenate chunks only after checking matching identity, digests, lengths,
expiry and contiguous ordered offsets. Require exactly one terminal marker at
the end and no missing, duplicate or mixed pages. Verify total UTF-8 bytes,
total UTF-16 length and `packedDigest` before JSON parsing.

The packed JSON object contains `encoding`, `shapes` and `value`. Primitive JSON
values retain their value. Every original array becomes `[0, ...encodedItems]`.
Every object becomes `[1, shapeIndex, ...encodedValues]`. A shape contains two
arrays: ordered non-null property names and property names whose value is
exactly null. Match object arity exactly, reject duplicate shape keys, restore
null properties and decode values recursively. Use safe own-property creation;
names such as `__proto__` must not change a prototype. Empty arrays, objects,
null values, absent properties, strings and array order remain distinguishable.

After expansion, verify `digest` against canonical JSON of the **whole data**.
For a create contract, additionally recompute `schemaDigest` over
`schemaContract` using `create-schema-v1` canonicalization. Receipt content and
immutable Git evidence retain their existing independent checks. Neither the
delivery digest nor a cursor substitutes for a schema or document digest.

The package exports `assembleCompleteDelivery(pages)` as a bounded reference
assembler. Independent consumers should use conformance tests and validate the
result's expected v1 contract and identity before accepting it. A truncated or
incomplete setup must not update the caller's approved schema expectation.

## Resource and failure behavior

Packed snapshots are at most 1 MiB each. The process retains at most 16 pending
snapshots and approximately 8 MiB of serialized UTF-8 snapshot data, with at
most two per engine/session pair. UTF-16 string storage can be twice the byte
budget; object overhead and temporary bounded encoding allocations are extra.
Oldest entries are evicted at capacity. Expired or closed-engine entries are
pruned on the next delivery call, so expiry invalidates access immediately but
does not promise immediate memory erasure. Complete single-page observations
need no retained entry. No files, log streams or background timers are added.

Expanded delivery data permits 65,792 canonical nodes, depth 68 and 2 MiB of
serialized scalar content (including repeated keys). These bounded allowances
cover the fixed receipt/contract wrapper and raw content copies around already
validated v1 data. Original content and schema validation retain their existing
65,536-node/depth-64 limits. Shape-table metadata has a separate structural
budget; decoding charges every expanded key and null before allocation.

Each continuation rechecks a bounded observation and uses a bounded binary
search to fit the serialized page. Existing concurrency and timeout controls
apply. Clients must bound retries and total work, and stop on expiry or change.

Size errors identify `tool`, `observedBytes`, `capBytes` and recovery guidance
when delivery-boundary measurement is available. Oversized write
acknowledgements include `writeOutcome: unknown_reconcile`: the write may have
occurred. Reconcile using an exact document receipt and keep uncertainty pending
if evidence remains unavailable. Never infer non-publication from a response
size failure or replay a write automatically.

## Safe preparation reuse

Each engine retains one private parsed-schema preparation keyed by exact raw
dependency hashes, including registry, all schemas and templates. Same-size
edits with restored timestamps and BOM changes cannot hit an older entry.
Every observation still captures files through the safe reader, validates
paths, rereads for stability and constructs the complete v1 identity. Cache
hits return independent definition copies and current file metadata. Failure
never falls back to old validation. Reload and close clear preparation.

Authority, readiness, history policy and expected content are never cached.
Both schema checks around guarded preparation remain. This reduces parser work;
it does not remove filesystem checks or make writes depend on cached access.

## Small-reference assessment

The existing `expectedSchemaDigest` already provides a small per-write
reference. Reusing it after verified setup delivers the requested ownership
split without changing v1 independent verification. Application workflows,
mapping, deduplication and reconciliation remain with the consumer; MAADB owns
validation and final write admission.

A new engine-issued opaque reference that permits setup without exporting the
complete contract would change the trust protocol. It needs a separately
versioned agreement defining issuer/engine identity, approved expectation,
expiry, restart behavior and drift rejection. It should not be introduced as a
lossless-encoding optimization or automatically replace an approved expectation.
This implementation therefore preserves v1 and does not introduce such a token.

## Evidence and remaining client checks

The synthetic 24-type, 408-field fixture produces a 168,395-byte legacy MCP
result and an 80,139-byte compact result without optional request metadata.
Tests include request metadata, independent reconstruction and a successful
guarded create using the original v1 digest. This fixture is representative,
not a maximum or a production export. It also completes using 64 KiB pages.

A local Windows/Node 24.15.0 sample of 11 observations measured median uncached
preparation at 123.0 ms and warm-cache observation at 109.1 ms with the release
lockfile installed. Samples alternated uncached and cached observations after warmup. Filesystem checks
dominate this sample; do not treat it as a production throughput benchmark.

Protocol integration tests exercise real MCP schemas, handlers and transport
serialization, large receipt recovery and lost-response behavior. They do not
establish current Codex or Claude Code harness truncation/persistence behavior.
Before consumer rollout, record actual client versions/settings and test intact
delivery, explicit rejection, truncation and file persistence. Bytes, characters
and tokens differ. Configure per-tool client budgets where supported, while
keeping bounded retrieval and digest checks as the portable completeness path.
