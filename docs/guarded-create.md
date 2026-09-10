# Guarded create

Guarded create admits a new document only when its complete schema contract,
effective history mode, supplied content, and current write authority agree with
the caller's frozen expectations. It uses the same engine mutex and exclusive
file creation pipeline as ordinary create. Existing `maad_create` and
`engine.createDocument()` retain their interfaces and legacy defaults.

## Versioned API

Both MCP operations require a session already bound through the normal project
selection API and an already-loaded, ready engine. They never initialize a
project, recover a journal, flush history, or reload the instance to satisfy a
precondition. In a multi-project session, supply `project`; in a single-project
session, an explicit `project` must match the binding. The corresponding engine
methods operate on the engine's explicitly configured project root.

### Read the create contract

`maad_create_contract` requires reader access:

```json
{"contract":"create-contract-v1","docType":"note"}
```

The engine equivalent is `engine.createContract(request, options?)`.
Its result contains:

| Property | Meaning |
| --- | --- |
| `contract` | `create-contract-v1` |
| `docType` | Exact canonical registry name requested; no aliases |
| `schemaProjection` | `create-schema-v1` |
| `schemaDigest` | Lowercase SHA-256 of canonical JSON of `schemaContract` |
| `schemaContract` | Complete source and effective schema material described below |
| `contentProjection` | `document-content-v1`, shared with document receipt |
| `effectiveHistoryMode` | Current `audit`, `batch`, `snapshot`, `feed`, or `read` |

The MCP response uses the standard `{ok, data}` / `{ok, errors}` envelope. Engine
methods return `Result<T>`. A contract is an observation, not a reservation or
permission to write. Reading a contract does not activate its schema in the
engine's cache.

### Submit a guarded create

`maad_create_guarded` requires writer access. Every property below is required:

```json
{
  "contract": "guarded-create-v1",
  "docType": "note",
  "docId": "nt-one",
  "fields": {"title": "Hello"},
  "body": "",
  "expectedSchemaDigest": "<64 lowercase hexadecimal characters from schemaDigest>",
  "expectedContentDigest": "a680267ffb809101d5d97c16b5fc62b432693e5013079d733922a5ebf066b63d",
  "allowedHistoryModes": ["audit"]
}
```

The content digest in this example assumes the registry maps `note` to
`note.v1`. Replace the schema digest placeholder with the observed digest.

The engine equivalent is `engine.createGuarded(request, options?)`. Types
`CreateContractRequest`, `CreateContract`, `GuardedCreateRequest`,
`GuardedCreateResult`, and `GuardedCreateOptions`, plus `canonicalJson` and
`contentDigest`, are exported from the package's engine entry point. An
independent client does not need this package or an SDK.

Unknown top-level arguments and unsupported versions are errors. There is no
caller path, caller authority claim, idempotency key, auto-ID, or implicit body.
`fields` must be a JSON object, not JSON text. `body: ""` explicitly selects an
empty body and does not invoke a template. `doc_id`, `doc_type`, and `schema`
are engine-owned and must not appear in `fields`.

`docId` is exact, 1–128 ASCII characters, starts and ends with a letter or
digit, and otherwise contains only letters, digits, `_`, `-`, and `.`. It
cannot contain `..`, start with `.`, or use a Windows reserved device name,
including a reserved name before an extension. The ID is never repaired or
normalized. The allowed history list contains 1–5 distinct known modes.
`read` can be named in the list but never enables a write to a read-only engine.

A successful result extends ordinary create's `docId`, `filePath`, `version`,
`validation`, `writeDurable`, and optional `commitFailure` with:
`contract: "guarded-create-v1"`, `schemaDigest`, `contentDigest`, and the
`effectiveHistoryMode` at admission. MCP also preserves the normal warnings and
durability metadata. Audit events, write rate limits, notifications, tool role
filtering, and operation kinds apply normally. Server dry-run returns the
standard dry-run response without creating a document; it is not evidence of
successful guard admission or persistence.

## Complete schema identity: create-schema-v1

`schemaContract` has this shape:

```text
{
  projection: "create-schema-v1",
  engineVersion: <engine package version>,
  contentProjection: "document-content-v1",
  sources: { <project-relative dependency name>: <complete UTF-8 source text> },
  effective: {
    types: [[<type name>, {name, path, idPrefix, schemaRef, template}], ...],
    extraction: {subtypes: {...}},
    subtypeMap: {...},
    schemas: [[<schema reference>, {
      type, version, required,
      fields: [[<field name>, <complete effective field definition>], ...],
      template
    }], ...]
  }
}
```

Map entry arrays retain loader order because required fields and schema field
order affect serialization. Object member order is canonicalized for hashing.
Effective field definitions include the name, type, index, role, format,
reference target, enum values, default value, list item type, storage and
display precision, coarser-precision behavior, maximum and advisory lengths,
and multiline policy, including explicit null values. The returned material
is sufficient to inspect the effective rules and recompute the identity.

The dependency set is **the whole registered project contract**, not only the
selected type. It includes `_registry/object_types.yaml`, every schema named
by that registry, and every directly referenced registry template file. Raw
source text also covers unrecognized top-level extension material and schema
version/ref spelling. Extraction includes the effective built-in subtype map
and registry extensions. Schema references must be safe local names;
dependencies cannot be arbitrary caller paths, symbolic links, network URLs,
or recursive external includes. Type directories must be real directories
where they already exist, so successful creates remain compatible with the
receipt path rules. Missing type directories are permitted and created only
after admission.

This identity deliberately changes for comments, whitespace, source ordering,
and line-ending edits too. It conservatively detects changes to required
fields, constraints, defaults, templates, precision, references, extraction,
registry mappings, and otherwise unrelated registered types. It is not a
claim of semantic equivalence between differently written schema files.
Unregistered files and other documents are outside this dependency set. The
versioned projection and engine version identify the interpretation; it is
not a hash of the executable or installed dependency binaries.

Each observation reads dependencies afresh with bounded reads, regular-file
and path checks, and before/after handle and pathname identity checks. The
shared schema validator builds a fresh effective store exclusively from the
captured source text; it never reopens schema files through the legacy disk
loader. Both the effective identity and prepared document use that store.
Bounded byte rereads then check those same dependencies for changes; guarded
create compares another complete observation before publication. Cancellation
is checked during capture, between schema validations, and during rereads.
It does not rely on mtime/size cache freshness or the legacy
loader's fallback to stale schemas. Same-size edits with restored mtime are
detected. Missing, unreadable, malformed, changing, or unsupported schema
dependencies fail closed. Strict observation also rejects malformed registry
and schema top-level shapes tolerated by legacy loading.

Cache metadata from the same bounded handles supports later receipt freshness
checks and legacy schema reloads. It is never used to admit guarded operations,
which always take fresh bounded snapshots. Rereads detect observed
changes; they do not lock out external filesystem writers or make the dependency
set a filesystem transaction.

## Content identity: document-content-v1

For both hashes, SHA-256 consumes UTF-8 bytes and returns 64 lowercase hex
characters. There is no added newline or hash prefix.

Canonical JSON recursively sorts object keys by ECMAScript UTF-16 code-unit
order; preserves array order; and uses ECMAScript `JSON.stringify` spelling
for strings, booleans, null, and finite numbers. Negative zero becomes `0`.
There is no Unicode normalization. Integer-looking object keys must remain
lexicographically sorted in the emitted text: sorting an object and then
calling `JSON.stringify` on that object can reorder numeric keys incorrectly.
Use explicit key/value serialization. Independent numeric implementations
must produce ECMAScript's shortest round-trippable binary64 spelling.

To calculate the document digest:

1. Start with the exact JSON `fields` object and add `doc_id`, `doc_type`, and
   the selected registry entry's `schemaRef` as `schema`.
2. Normalize body CRLF to LF and trim its ends using ECMAScript `String.trim`
   whitespace semantics. Do not trim or coerce frontmatter values.
3. Construct the following text with the **fixed outer order** shown. Apply
   canonical JSON separately to each value:

   ```text
   {"docId":<id>,"docType":<type>,"frontmatter":<frontmatter>,"body":<body>}
   ```

4. Hash that text. This differs from recursively sorting the outer envelope:
   its order is `docId`, `docType`, `frontmatter`, `body`.

The engine generates markdown once with its normal writer, then parses those
exact bytes through the strict receipt projection: valid UTF-8, explicit
frontmatter delimiters, YAML CORE schema, duplicate-key rejection, JSON-only
values, and matching reserved identity. It compares the entire parsed
frontmatter and normalized body to the submitted content and checks the
expected digest. It publishes the prepared bytes without regenerating them.

No default fields are synthesized by this API. Schema defaults still affect
the effective validation/extraction contract and are included in schema
identity. Supply desired stored values explicitly. A nested object, ambiguous
flow-list string, field name, or other value that the current writer cannot
round-trip exactly is rejected even if a caller predicts its lossy output.
This API does not expand the legacy serializer's supported data profile.

### Conformance vectors

Canonical JSON input:

```json
{"2":"b","10":"a","z":[true,null,"007"],"a":0}
```

Exact canonical output (also the output when `a` is negative zero):

```text
{"10":"a","2":"b","a":0,"z":[true,null,"007"]}
```

Exact document digest input:

```text
{"docId":"nt-one","docType":"note","frontmatter":{"doc_id":"nt-one","doc_type":"note","schema":"note.v1","title":"Hello"},"body":""}
```

Expected SHA-256:

```text
a680267ffb809101d5d97c16b5fc62b432693e5013079d733922a5ebf066b63d
```

The engine tests implement a separate client canonicalizer using only JSON
serialization and SHA-256. The MCP tests submit this fixed digest through the
real protocol schema and handler and compare the result with document receipt.

## Admission, limits, and reconciliation

The engine freezes request JSON before queuing. Admission, preparation, and
publication use the same reentrant FIFO mutex as other engine operations.
Inside that mutex it checks readiness, read-only status, effective history
policy, fresh complete schema identity, and content. MCP routing supplies a
trusted synchronous `options.validateAccess` callback which rereads the live
session, token record, role caps, project selection, and retained engine
binding after schema awaits. `options.signal` supplies cooperative
cancellation. Neither option is a wire argument or caller authority claim.

All admission checks precede directory creation, journal begin, exclusive file
creation, indexing, and history work. Cached registry/schema activation occurs
only once admission succeeds. A rejected create does not rebuild existing
indexes. Ready references and concurrent request slots stay held until the
handler settles even if its response has already timed out. Cancellation or
timeout while queued prevents later publication. An instance reload, engine
replacement, project path change, or loss of write authority also prevents
queued work from publishing.

Bounds are fail-closed, with no partial contract response:

| Material | Bound |
| --- | --- |
| Registered types | 1–64 |
| Source dependency files | At most 129 |
| Each source file and total source text | 256 KiB |
| Canonical complete schema contract | 512 KiB |
| Canonical create request and generated document | 256 KiB each |
| Canonicalization | Depth 64, 65,536 visited nodes, 1 MiB encoded scalar budget |
| MCP envelope | Smaller of configured response cap and 1 MiB |

The MCP payload and concurrency caps also apply. A contract exceeding the
normal response cap is rejected; configure sufficient response capacity only
when needed. Non-finite numbers, undefined, bigint, functions, cycles, sparse
or decorated arrays, accessors, hidden properties, symbols, and custom
prototypes are rejected for direct engine input as well as unsupported JSON
content encountered during parsing.

Common admission errors include `INVALID_FIELDS`, `VALIDATION_FAILED`,
`SCHEMA_INVALID`, `SCHEMA_CONTRACT_CHANGED`, `CONTENT_DIGEST_MISMATCH`,
`HISTORY_MODE_MISMATCH`, `READ_ONLY`, `DUPLICATE_DOC_ID`,
`CREATE_ENGINE_NOT_READY`, and the existing routing, token, path, bound-read,
and size errors. Ready-pool admission retains its existing
`RECEIPT_ENGINE_NOT_READY` error. A rejection is not permission to silently
refresh expectations and resubmit.

The guarantee is atomic admission relative to this engine's serialized
operations. Arbitrary external filesystem writers, other processes, and
out-of-band in-process mutation are not serialized by this mutex. Dependency
observations and exclusive create detect many such conflicts, but they do
not provide a filesystem transaction. No fsync, replication, cross-system
transaction, or guaranteed Git commit is claimed.

History mode is never switched, initialized, or flushed to satisfy the
allowed list. `audit` selects immediate commit intent; `batch`, `snapshot`, and
`feed` keep their existing semantics. Existing `writeDurable` and
`commitFailure` fields report the actual trailing commit outcome. In
particular, an existing no-op history outcome is not evidence of an immediate
Git commit.

After publication, timeout or cancellation does not roll back the document.
A post-publication failure or lost acknowledgement is uncertain. Preserve the
exact type, ID, and expected content digest and call the existing
`maad_document_receipt` with `contract: "document-persistence-v1"` and that
digest. Exact committed-content evidence can reconcile content; an unverified
or missing receipt is not proof that a create never happened. Never
automatically replay create, switch modes, or flush history to reconcile it.
