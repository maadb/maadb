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

// Only some types
{"name": "maad_changes_since", "arguments": {"cursor": "<opaque>", "docTypes": ["case", "case_event"]}}
```

Each page:

```json
{
  "changes": [
    {"docId": "cas-2026-001", "docType": "case", "updatedAt": "2026-09-24T23:41:07.120Z", "operation": "update"}
  ],
  "nextCursor": "<opaque>",
  "hasMore": false
}
```

- Cursor is opaque base64url. Never parse it. Pass `nextCursor` back verbatim; `hasMore` says whether another page is ready now.
- Ordering: `(updatedAt ASC, docId ASC)`, strict `>`. No duplicate emissions.
- Default page 100, max 1000. `docTypes` restricts the feed to those types.
- `operation` is `create` for a document at version 1, otherwise `update`. Full content requires a follow-up `maad_get`.
- Soft-deleted and hard-deleted documents are excluded from the feed. There is no delete emission.

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

Push notifications over the session's SSE channel, fired on durable writes. Each arrives as `notifications/resources/updated` with `uri=maad://records/<docId>`.

```json
{"name": "maad_subscribe", "arguments": {"docTypes": ["case"], "project": "alpha"}}
```

- Optional filters: `docTypes` (omit for all types) and `project` (defaults to the session's bound scope).
- One subscription per session. Calling `maad_subscribe` again replaces the filter.
- `maad_unsubscribe` releases it; admins can list active subscriptions with `maad_subscriptions`.

Notifications alone are not a complete history. Use `maad_changes_since` to catch up after a reconnect.
