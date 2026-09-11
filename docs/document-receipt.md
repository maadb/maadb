# Exact document receipt

`maad_document_receipt` exposes the fixed `document-persistence-v1` contract. It reads one document from an already-bound session and an already-loaded, ready engine. Reader access is sufficient, including a read-only engine when committed history is available. It never loads, initializes, repairs, reindexes, commits, flushes, or changes project policy to obtain evidence. Existing read and write tools retain their contracts.

```json
{
  "contract": "document-persistence-v1",
  "project": "example",
  "docType": "note",
  "docId": "n-1",
  "expectedContentDigest": "b7e51ca832ac1a9946494df57efd3172879b3dff5ba25e31ecf81c1843edfe3c"
}
```

The input is strict: unknown keys are rejected. `project` is optional in a single-project session and required in a multi-project session. An explicit different project in a single-project session is rejected. Neither a filesystem path nor a Git ref is accepted. `docType` is a registered type name, at most 256 UTF-8 bytes, using letters, numbers, underscore, and hyphen. `docId` uses the existing stricter safe-ID grammar and 128-character limit. The optional digest is exactly 64 lowercase hexadecimal characters.

The session must already be bound, even in single-project legacy mode. Current project and token access are checked before reading and immediately before returning. Revocation, expiration, removal, or lost project access returns an error without content. Engine references remain protected until the actual handler terminates, even after the request timeout. Reload and eviction fence new receipt references and wait for retained references before closing an engine.

## Meaning and response fields

All receipt fields are inside the normal success envelope's `data`. The TypeScript data definition is in [document-receipt-types.ts](../src/engine/document-receipt-types.ts).

`committed_content_available` means that a strict immutable Git payload was readable locally at observation time. `git_commit_visible` does not prove operation completion, attribution correctness, business intent, remote backup or push, fsync durability, power-loss survival, or a transaction with a consumer's processing ledger. No receipt, error, mismatch, missing index, or absent blob authorizes create replay.

The response echoes `contract`, `engineVersion`, canonical backend `project`, `docId`, `docType`, UTC `observedAt`, `effectiveHistoryMode`, `projection`, and `expectedContentDigest` (null when omitted). `observedAt` is an observation timestamp, not a durability deadline.

`committed`, when present, includes:

- `evidenceKind: "git_commit_visible"`, `objectFormat: "sha1" | "sha256"`, and full `commitOid`, `treeOid`, and `blobOid`.
- `rawSha256`, `byteLength`, and exact valid-UTF-8 `rawMarkdown`, including any BOM and original newline bytes.
- Complete typed `frontmatter`, canonical `body`, and `contentDigest`. No stored field is omitted to force a match.

`index.state` is `present`, `missing`, or `identity_mismatch`. `workingTree` has a separately labelled state, raw SHA-256, and semantic digest. Hashes remain null when that stage has not produced them. Formatting-only differences can produce matching semantic digests and different raw hashes.

`expectedDigestMatch` is null when no digest was supplied or committed evidence is unavailable. Otherwise it compares the supplied digest with the complete semantic digest. A false comparison still permits `committed_content_available`: the returned evidence exists, but does not match that digest. Even a true comparison is not intent or provenance proof.

Consumers must independently compare the frozen complete intended fields, explicit canonical body, schema identity, and trusted provenance against the returned document. Retain additional engine-generated fields. Freeze attribution before dispatch, and validate serialization round trips for intended types. An omitted create body may select a schema template and is outside an intent contract requiring an explicit body, including `""`.

## Deterministic observation matrix

Checks run in this order; the first failed prerequisite determines the outcome. This implementation conservatively returns `committed: null` on every unverified outcome.

| Prerequisite or observation | Status | Reason | Working state |
|---|---|---|---|
| No index row | `unverified` | `index_missing` | `not_checked` |
| Index identity, schema, or canonical path disagrees | `unverified` | `index_identity_mismatch` | `not_checked` |
| No available history runtime/Git layer, or feed policy | `unverified` | `history_unavailable` | `not_checked` |
| Exact regular blob absent from the pinned current tree | `unverified` | `uncommitted` | `not_checked` |
| Working path absent | `unverified` | `working_tree_missing` | `missing` |
| Working read denied | `unverified` | `working_tree_unreadable` | `unreadable` |
| Working handle/path identity, size, or change metadata changes | `unverified` | `working_tree_changed` | `changed` |
| Working and committed semantic digests differ | `unverified` | `working_tree_diverged` | `diverged` |
| Every prerequisite passes | `committed_content_available` | null | `matches_committed` |

`committed_payload_mismatch` is reserved by the contract; this implementation rejects malformed or identity-conflicting payloads with `RECEIPT_CONTENT_INVALID`. A caller-supplied digest mismatch uses `expectedDigestMatch: false` and reason null.

Pending batch/snapshot content that is not in the pinned tree is `uncommitted`; pending changes to an existing committed document can be `working_tree_diverged`. Feed mode does not expose old Git content. Read mode can read existing committed storage but cannot make unavailable storage available. Current-tree absence does not establish historical noncreation.

## Capture, bounds, and errors

The engine operation mutex prevents local engine writes during capture. Its receipt entry point does not reload schemas or update write telemetry. HEAD is resolved once to a full commit ID. Subsequent tree and blob reads use immutable IDs, not moving refs. Only exact regular Git entries are accepted; symlinks and submodules are rejected. The reader verifies blob type, size, and Git object hash before decoding. Subprocesses use argument arrays without a shell, disable replacement objects and lazy fetching, bound stdout/stderr, and terminate on cancellation or timeout. The total Git observation has a 30-second ceiling in addition to the request deadline.

Working content uses a contained, regular-file handle, no-follow flags where supported, and pathname/handle identity checks before and after bounded consumption. External writers are not serialized by the engine mutex. These checks do not constitute a distributed lock or guarantee that content stays unchanged after observation. SQLite's existing reader coordination may update its WAL shared-memory read mark; receipt code issues no database writes.

Raw committed and working bytes are each limited to 256 KiB. Canonical content has depth, node, and expansion bounds. The complete MCP result uses the independent `MAAD_CONTRACT_RESPONSE_MAX_BYTES` allowance (128 KiB default, 1 MiB hard ceiling). Oversized legacy responses are rejected, never truncated. Optional lossless bounded delivery also covers large receipts; see [complete delivery](complete-delivery.md) for retrieval and configuration migration.

Invalid UTF-8, YAML, duplicate keys, missing or conflicting identity, unsupported JSON values, nonfinite numbers, cyclic values, and unsupported object prototypes produce `RECEIPT_CONTENT_INVALID`. Oversize input/content/output produces `RESPONSE_TOO_LARGE`. Unexpected filesystem/Git failures produce `RECEIPT_STORAGE_ERROR`, not absence. Index/configuration changes or stale configuration produce `RECEIPT_OBSERVATION_CHANGED`. An unloaded, closing, or unavailable engine produces `RECEIPT_ENGINE_NOT_READY`. Existing binding, authorization, safe-path, and timeout errors apply. Every error preserves uncertainty.

## document-content-v1 conformance vectors

Hash UTF-8 canonical JSON of exactly `{docId,docType,frontmatter,body}`, with that fixed outer order. Sort every nested object's keys by JavaScript UTF-16 code-unit order, including integer-like keys. Keep array order and exact strings; preserve null, boolean, and finite-number types. Use JSON number/string encoding. The canonical body removes one document-leading BOM for parsing, recognizes LF/CRLF frontmatter delimiters, normalizes body CRLF to LF, then applies ECMAScript `trim()`.

Vector A's exact canonical JSON, with `\n` representing JSON escape characters:

```json
{"docId":"n-1","docType":"note","frontmatter":{"doc_id":"n-1","doc_type":"note","extra":{"a":"é","z":[null,true,2,"2"]},"schema":"note.v1"},"body":"Hello\nworld"}
```

| Vector | Body | SHA-256 semantic digest |
|---|---|---|
| A | `Hello\nworld` | `b7e51ca832ac1a9946494df57efd3172879b3dff5ba25e31ecf81c1843edfe3c` |
| B, same complete frontmatter | Empty string | `46f9e3ef1f549437f099541239a4172cbec097fd1dc018e6f7d9f4b7d83877cc` |

The following raw document uses LF and ends in one LF:

```markdown
---
doc_id: n-1
doc_type: note
schema: note.v1
extra:
  z: [null, true, 2, "2"]
  a: é
---

Hello
world
```

Its 105 UTF-8 bytes hash to `519bc953fcb54e75b160f28f69bc6a0ff27aa513fa4e87a99deafc44fc4e5942`. Prefix one UTF-8 BOM, replace every LF with CRLF, and append `" \r\n"`: those 122 bytes hash to `04b14d25fae9123d52044e4ae4d29e18a450f4a44b5410b1b78c2a854b93b475`. Both parse to vector A's semantic digest.

Key-order vector: `{"2":2,"10":10,"\uE000":"bmp","😀":"pair"}` serializes with keys in the order `"10"`, `"2"`, `"😀"`, `"\uE000"`. This uses UTF-16 ordering rather than Unicode code-point or locale ordering. The tests contain fixed semantic digests and raw-byte vectors for consumer conformance.
