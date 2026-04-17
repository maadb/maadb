# MAADB — Change feed

How to consume writes from other sessions.

## maad_changes_since (shipped)

Polling delta. Pass opaque cursor, get next page.

```json
// First call
{"name": "maad_changes_since", "arguments": {"limit": 100}}

// Subsequent
{"name": "maad_changes_since", "arguments": {"cursor": "<opaque>", "limit": 100}}
```

- Cursor is opaque base64url. Never parse it.
- Ordering: `(updated_at ASC, doc_id ASC)`, strict `>`. No duplicate emissions.
- Default page 100, max 1000.
- Each delta carries `doc_id`, `doc_type`, `op` (`create` if version 1, else `update`), `updated_at`. Full content requires a follow-up `maad_get`.
- Deletes not emitted in 0.5.0.

## When to poll

| Scenario | Action |
|---|---|
| Single agent, no peers writing | None. Writes visible on next read. |
| Multi-agent on shared project (stdio) | Call `maad_changes_since` at start of each task. Store `nextCursor` in session frontmatter. |
| Hosted HTTP deployment | Gateway polls every 2–5s active / 30–60s idle. Agent does not poll. |
| Scheduled worker | Load cursor from state file, poll once, act, save cursor, exit. |

## Cursor persistence

Required — without persistence you re-process the full feed on every restart.

- Session-scoped agents: store in session frontmatter (`cursor: "<opaque>"`)
- Scheduled workers: store in `_state/<worker>.yaml` or equivalent

## Rules

- Cadence below 1s is wasteful; don't.
- Cursor is opaque; don't parse it.
- Deletes are not emitted in 0.5.0. Soft deletes appear as `op: update` with `_deleted` prefix in `doc_id`.
- In HTTP deployments, polling belongs in the gateway, not the agent's reasoning loop.

## maad_subscribe (planned 0.6.5)

Push over the existing SSE channel, same payload shape as `maad_changes_since`. When it ships, swap the polling loop for `maad_subscribe` + handler. No other changes required.
