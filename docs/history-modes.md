# MAADB history modes

`history_mode` controls how each project turns durable Markdown writes into Git
history. It is independent of MCP response metadata settings.

## Modes

| Mode | Project writes | Git behavior | History behavior |
|---|---|---|---|
| `audit` | Enabled | Commits every logical write | History and audit include each completed write. Git is required. |
| `feed` | Enabled | Never stages or commits | Existing Git history remains readable when Git is present. Without Git, history and audit return `HISTORY_DISABLED`. |
| `read` | Disabled | No Git mutations | Existing Git history remains readable when Git is present. Project mutations return `PROJECT_READ_ONLY`. |
| `batch` | Enabled | Groups pending writes into commits | Flushes on configured write or time thresholds, explicit flush, shutdown, or startup recovery. Git is required. |
| `snapshot` | Enabled | Uses the batch mechanism, then creates an annotated `maad-snapshot-*` tag | The tag is created only after the commit containing the pending writes succeeds. Git is required. |

Use `audit` when every logical write needs its own commit. Use `feed` when the
Markdown change feed is the durable boundary and Git commits are managed
elsewhere. Use `batch` to amortize Git work. Use `snapshot` when each grouped
boundary also needs a named Git recovery point.

`read` uses the engine's zero-write path, including at startup. It requires an
already initialized, readable project with the registry, schemas, Markdown,
and index needed to serve reads. Initialize or repair the project under a
write-enabled mode before switching it to `read`.

## Configuration

Set the mode on each project in `instance.yaml`:

```yaml
name: example-instance
projects:
  - name: activity
    path: /srv/maad/activity
    role: writer
    history_mode: feed

  - name: knowledge
    path: /srv/maad/knowledge
    role: admin
    history_mode: batch
    history_options:
      max_writes: 50
      max_delay_ms: 1000
```

Valid modes are `audit`, `feed`, `read`, `batch`, and `snapshot`.

`history_options` affects `batch` and `snapshot`:

- `max_writes` flushes when the number of pending logical writes reaches the
  configured value.
- `max_delay_ms` flushes after the oldest pending group has waited for the
  configured duration.

Both values must be positive integers. If both are present, the first boundary
reached starts the flush. If neither is present, use an explicit flush; pending
writes are also handled by shutdown and startup recovery. In v0.14.0 the
options are still validated when supplied with `audit`, `feed`, or `read`, but
those modes do not use them. Omit the options for those modes so the
configuration communicates its actual policy.

An explicit `audit`, `batch`, or `snapshot` configuration requires a `.git`
entry at the project root. Startup fails with `GIT_NOT_INITIALIZED` when Git is
missing. MAADB does not silently change an explicit mode.

### Precedence

MAADB selects the effective mode in this order:

1. The project's `history_mode` in `instance.yaml`.
2. `MAAD_HISTORY_MODE_DEFAULT`.
3. Compatibility inference: `audit` when the project root has `.git`, otherwise
   `feed`.

The environment default is also how `--project` deployments select a mode when
there is no per-project instance entry:

```bash
MAAD_HISTORY_MODE_DEFAULT=batch maad --project /srv/maad/knowledge serve --role admin
```

`maad_health.history.modeSource` reports `project`, `environment`, or
`inferred`. `configuredMode` is the project-level value, so it is `null` when
the effective mode came from the environment or inference.

Changing `history_mode` or `history_options` for an existing project through an
instance reload is not supported. The reload fails atomically with
`INSTANCE_MUTATION_UNSUPPORTED`; restart the instance to apply the change.

## Flush pending history

The admin-only `maad_flush` MCP tool flushes pending `batch` or `snapshot`
writes for the selected project:

```json
{"name":"maad_flush","arguments":{"project":"knowledge"}}
```

In a single-project CLI deployment, run:

```bash
maad flush --project /srv/maad/knowledge
```

A successful response includes:

- `effectiveMode`
- `trigger`
- `status`: `committed` or `noop`
- `pendingWrites`: the count remaining after the operation
- `flushed`: whether a commit was created
- `sha`: present when a commit was created

The operation is an explicit, successful no-op in `audit`, `feed`, and `read`.
It is also a no-op when a batching mode has no pending writes. A flush failure
returns `GIT_ERROR`, or `GIT_NOT_INITIALIZED` if the Git repository is missing,
and keeps the pending journal evidence for recovery.

In `snapshot` mode, `maad_backup` with `mode: "create"` flushes pending writes
before it creates the requested backup tag. The tag therefore points to a
commit that contains the current pending Markdown state.

## Health and degraded operation

`maad_health` keeps its existing fields and adds this `history` block:

```json
{
  "history": {
    "effectiveMode": "batch",
    "configuredMode": "batch",
    "modeSource": "project",
    "pendingWrites": 3,
    "lastSuccessfulFlush": "2026-08-07T20:15:30.000Z",
    "lastFlushError": null,
    "advisories": []
  }
}
```

`lastSuccessfulFlush` is an ISO 8601 timestamp or `null`. `lastFlushError` is
either `null` or an object with `at`, `code`, `message`, and `trigger`.
`trigger` identifies `threshold`, `timer`, `explicit`, `shutdown`, `recovery`,
or `snapshot`.

Treat a non-null `lastFlushError` as degraded Git durability. Markdown and the
derived index may already contain the write while its Git boundary remains
pending. Check `pendingWrites`, correct the Git failure, and retry through the
normal flush or restart path. A later successful flush clears the error.

For `feed` or `read` without Git, `maad_history` and `maad_audit` return
`HISTORY_DISABLED`. This is the expected mode-aware response, not a Git
initialization failure.

## Crash and shutdown behavior

MAADB keeps indexed journal entries pending until the applicable Git boundary
succeeds. Batch thresholds, timers, explicit flushes, shutdown, and recovery
are serialized per engine, so two triggers cannot commit the same pending group
concurrently.

On a clean shutdown, MAADB clears the history timer and attempts a bounded
flush. The shutdown attempt waits for up to five seconds. If it fails or times
out, the journal entries remain recoverable. At the next startup, MAADB finds
indexed pending entries and attempts recovery before normal operation continues.
If that attempt fails, health reports the error and the entries remain pending.

In normal `audit` operation, every logical write receives its own commit. If
several audit entries remain pending after Git commit failures, v0.14.0 startup
recovery can consolidate those pending entries into one recovery commit. The
Markdown writes and journal evidence remain durable, but the recovered Git
history no longer has one commit per original logical write.

For `snapshot`, the commit is created first and its boundary is recorded before
the annotated tag is created. If tag creation fails, startup recovery retries
the tag against that same commit instead of moving the snapshot to an older or
newer `HEAD`.

## Migrate an existing project

Projects without explicit history configuration continue to start with the
legacy behavior:

- A project with `.git` infers `audit`.
- A project without `.git` infers `feed`.

Inferred projects report `modeSource: "inferred"` and one
`HISTORY_MODE_INFERRED` advisory. To complete migration, inspect
`maad_health.history`, choose the intended policy, and add `history_mode` to the
project entry. This removes the advisory without changing current behavior.

For an existing no-Git project, set `history_mode: feed` to preserve the safe
no-Git write path. To adopt a Git-backed mode, initialize and verify the Git
repository first, then configure `audit`, `batch`, or `snapshot` and restart the
instance. Do not configure a Git-required mode before the repository exists.

Before selecting `read`, verify that the project can already serve reads and
does not need startup scaffolding, reindexing, instruction refresh, or repair.

## Benchmark the modes

The opt-in benchmark uses generated fixtures and reports file/index, Git
add/status, Git commit, and total timings separately. Enable it explicitly;
otherwise Vitest reports the benchmark as skipped.

PowerShell:

```powershell
$env:MAAD_HISTORY_BENCH='1'
npx vitest bench --run tests/performance/history-modes.bench.ts
```

POSIX shells:

```bash
MAAD_HISTORY_BENCH=1 npx vitest bench --run tests/performance/history-modes.bench.ts
```

Run it from a clean repository checkout on the target environment and record
the environment with the result. The v0.14.0 harness measures a `feed` engine
write followed by explicit Git add, status, and commit stages. It does not yet
execute `batch` or `snapshot`, calculate batch amortization, or enforce
workstation-specific latency as a CI threshold.
