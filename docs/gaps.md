# MAADB Gaps — Intentional Deferrals

This document lists capabilities MAADB is *not* shipping yet, with the rationale for deferring them and the signal that would promote them back onto the active roadmap. The goal: make gaps explicit so operators, integrators, and reviewers can pressure-test the engine against a known surface rather than guessing what's missing.

Everything in `ROADMAP.md` under `Planned` is committed work. Everything in this document is deliberately *not* scheduled for the near term, or is scheduled but at a deliberately minimal initial scope.

---

## Write path

### Mutex timeout and `WRITE_TIMEOUT` error
**Shipped in 0.4.1:** per-engine FIFO write mutex, infinite block on contention.
**Deferred:** configurable acquire timeout returning `WRITE_TIMEOUT`.
**Why defer:** realistic contention under MVP workloads is 2–3 writers with sub-200ms per commit. Infinite block is easier to reason about and easier to debug — if a writer hangs >2s it'll show up in latency logs immediately. A timeout adds a policy knob without solving a real problem yet.
**Trigger to build:** observed stuck writes in production logs, or any deployment where call-site retry logic depends on a bounded wait.
**Target slot:** 0.8.5 remote MCP hardening.

### Queue-depth backpressure (`WRITE_BACKPRESSURE` / 429-equivalent)
**Shipped in 0.4.1:** mutex serializes writes; per-session rate limiting caps incoming request rate.
**Deferred:** explicit queue-depth threshold that returns a distinct backpressure error when the write queue exceeds N.
**Why defer:** rate limiting already protects the engine from flood at the session boundary. Queue-depth signalling is useful when many sessions coordinate write bursts across a shared engine — a pattern that doesn't exist yet.
**Trigger to build:** observed sustained queue depth >10, or operator demand for push-back signals distinct from rate-limit rejections.
**Target slot:** 0.8.5.

### Write batching / coalescing
**Deferred indefinitely.**
**Why:** coalescing changes commit semantics (a single commit now represents N logical writes) and complicates audit attribution. Git commit cost is low enough that per-write commits are fine up to hundreds of writes per minute.
**Trigger to build:** sustained write throughput where per-commit latency dominates, *and* audit trail fidelity can be relaxed.

---

## Transport and auth

### Per-connection role tiers (reader / writer / admin)
**Shipped in 0.5.0:** single role tier — authenticated bearer token = full access per the server's configured role.
**Deferred:** token → role mapping with reader, writer, admin tiers over HTTP.
**Why defer:** most integrations launch with one role per deployment. Multi-tier tokens add an auth store, rotation story, and UI that aren't load-bearing until a customer asks for read-only sharing.
**Trigger to build:** first deployment that needs to issue read-only tokens distinct from write tokens.
**Target slot:** 0.8.5.

### Rate limit policy per token or tier
**Shipped in 0.4.1:** per-session token bucket with uniform limits (tunable globally via env).
**Deferred:** per-token or per-tier rate limit policy.
**Why defer:** uniform limits cover MVP. Tiered rate limits are a commercial-product concern.
**Trigger to build:** first deployment that needs to offer multiple service tiers.
**Target slot:** 0.8.5.

### TLS terminated in-engine
**Not planned.**
**Why:** standard pattern is to terminate TLS at a reverse proxy (nginx, Caddy, Cloudflare, Azure Front Door). Adding TLS to the engine duplicates infrastructure concerns and complicates certificate rotation.
**Trigger to reconsider:** a serious operator use case where reverse-proxy termination is not available.

---

## Observability

### Metrics export (Prometheus / OTEL)
**Shipped in 0.4.1:** structured JSON logs carrying every operationally relevant field (request_id, session_id, project, tool, role, payload_size, latency_ms, result, error_code).
**Deferred:** Prometheus or OpenTelemetry metrics endpoints.
**Why defer:** JSON logs can be parsed into metrics by any log aggregator. Dedicated metrics endpoints are worth building once an operator has a specific dashboard requirement.
**Trigger to build:** operator request for native Prometheus scrape or OTEL push.
**Target slot:** 0.8.5.

### Distributed tracing
**Deferred indefinitely.**
**Why:** `request_id` in logs is sufficient for tracing a single request through the engine. Distributed tracing pays off when MAADB sits in a multi-service call graph — it doesn't today.
**Trigger to build:** MAADB becomes part of a mesh where upstream/downstream tracing context needs to be propagated.

---

## Data lifecycle

### `git gc` automation
**Deferred.**
**Why:** git repos under MAADB workloads grow slowly. Manual `git gc` is fine for MVP. Scheduled maintenance is straightforward but operationally boring.
**Trigger to build:** observed repo bloat in any long-running deployment.
**Target slot:** 0.8.5.

### Disk quota enforcement in-engine
**Not planned.**
**Why:** container-level disk limits handle this for hosted deployments. Self-hosted operators can enforce at the filesystem or volume level. Adding quota logic to the engine duplicates OS primitives.
**Trigger to reconsider:** explicit self-hosted use case where OS-level limits are unavailable.

### Schema migration tooling
**Listed under Future (unscoped).**
**Why:** schema evolution is a real need but scope depends entirely on the first migration that hurts. Building generic migration infrastructure before a concrete use case produces over-engineered tooling.
**Trigger to build:** first production schema that needs to evolve incompatibly.

---

## Agent-facing features

### Polling delta endpoint (`maad_changes_since`)
**Shipped in 0.5.0:** basic delta endpoint taking a timestamp or version cursor.
**Deferred:** push-based subscriptions (MCP Resource Subscriptions over SSE).
**Why defer:** polling with a cheap delta endpoint covers the MVP use case. Push subscriptions add per-connection server state and commit to a protocol shape that might evolve.
**Trigger to build:** observed operator pattern where mid-session freshness matters enough that polling latency is unacceptable.
**Target slot:** unscheduled — evaluate after 0.5.0 usage signal.

### Architect skill auto-trigger
**Deferred to documentation.**
**Why:** `maad_summary` already returns `emptyProject: true` and a `bootstrapHint` pointing at the Architect skill. Well-written client prompts route to Architect mode on empty projects already. An engine-level trigger is only valuable if clients refuse to read the summary correctly.
**Trigger to build:** observed pattern of agents ignoring `emptyProject` signal and writing malformed records into empty projects.

### Full concurrency stress test suite
**Shipped in 0.4.1:** smoke tests for two-writer race, N-writer flood, writer + concurrent readers, stale lock recovery.
**Deferred:** sustained-load stress suite with throughput and latency benchmarks.
**Why defer:** smoke tests prove correctness under contention. Stress tests prove scale. Scale isn't the MVP claim.
**Trigger to build:** external benchmark request or first deployment at scale that needs a regression fence.
**Target slot:** 0.8.5.

---

## How to use this document

If you're evaluating MAADB and wondering why something isn't built yet, the answer is usually here. If it isn't here, it's either in `ROADMAP.md` under `Planned` (committed work) or genuinely unconsidered — open an issue.

Everything in this document can be promoted into the active roadmap once the "trigger to build" condition fires. The triggers are intentionally concrete so the decision to invest is signal-driven, not vibes-driven.
