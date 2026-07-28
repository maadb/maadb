# MAADB — Change feed

How to consume writes from other sessions.

## Recommended pattern

**Live subscription plus cursor catch-up:** use `maad_subscribe` for push notifications on durable writes, and `maad_changes_since` to catch up after reconnects or notification gaps. Persist the cursor between calls. In HTTP deployments, polling cadence belongs in the gateway, not the agent's reasoning loop.

## maad_changes_since

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
- Soft-deleted and hard-deleted documents are excluded from the feed. There is no dedicated `op: delete` emission.

## When to poll

| Scenario | Action |
|---|---|
| Single agent, no peers writing | None. Writes visible on next read. |
| Multi-agent on shared project (stdio) | Prefer `maad_subscribe`; use `maad_changes_since` at task start / after gaps. Store `nextCursor` in session frontmatter. |
| Hosted HTTP deployment | Gateway owns cadence (subscribe and/or poll every 2–5s active / 30–60s idle). Agent does not poll in its reasoning loop. |
| Scheduled worker | Load cursor from state file, poll once, act, save cursor, exit. |

## Cursor persistence

Required — without persistence you re-process the full feed on every restart.

- Session-scoped agents: store in session frontmatter (`cursor: "<opaque>"`)
- Scheduled workers: store in `_state/<worker>.yaml` or equivalent

## Rules

- Cadence below 1s is wasteful; don't.
- Cursor is opaque; don't parse it.
- Deletes are not emitted. Soft-deleted and hard-deleted documents simply stop appearing in later pages.
- In HTTP deployments, polling belongs in the gateway, not the agent's reasoning loop.

## maad_subscribe

Push notifications over the existing SSE channel (shipped). Same durable-write events as the change feed; manage with `maad_unsubscribe` / `maad_subscriptions`. Use `maad_changes_since` for historical catch-up on reconnect — notifications alone are not a complete history.
