# MAADB — Docker deployment

Reference guide for running `maad serve --transport http` in a container behind traefik with TLS. Engine-scope only — pick whatever container orchestrator, secrets store, and log aggregation you already use.

## Prerequisites

- Docker 24+ and Docker Compose v2
- A host with ports 80/443 reachable (for traefik TLS) and a DNS name pointed at it
- An `instance.yaml` or a project directory to mount into the container

## Layout

```
maad-deploy/
  compose.yaml
  Dockerfile                 # build from the maadb source tree, or pull npm
  instance.yaml              # mounted read-only
  data/                      # project directories — mounted read-write
    proj-a/
    proj-b/
  secrets/
    maad_auth_token          # docker secret, chmod 600
  letsencrypt/               # traefik ACME persistence
```

## 1. Generate a bearer token

```bash
mkdir -p secrets
openssl rand -base64 48 | tr -d '=' | tr '+/' '-_' > secrets/maad_auth_token
chmod 600 secrets/maad_auth_token
```

Never put the token in `compose.yaml` or in an env file checked into git. Docker secrets mount the file at `/run/secrets/<name>` inside the container with correct permissions.

## 2. Dockerfile

Multi-stage build — install + build in a heavier image, copy only runtime artifacts into a minimal final stage.

```dockerfile
# Dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

# Non-root runtime. Keep the UID stable so bind-mounted project dirs on the
# host don't need to be chowned after every rebuild.
RUN groupadd -g 10001 maad && useradd -m -u 10001 -g 10001 maad
USER maad
WORKDIR /app

COPY --from=build --chown=maad:maad /src/dist ./dist
COPY --from=build --chown=maad:maad /src/node_modules ./node_modules
COPY --from=build --chown=maad:maad /src/package.json ./package.json

# tini PID 1 so SIGTERM from `docker stop` actually reaches node and triggers
# the graceful-shutdown state machine.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/cli.js", "serve"]

# Liveness target — no auth required, 200 live / 503 draining
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:7733/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
```

Build:

```bash
docker build -t maadb:0.5.0 .
```

## 3. Compose stack with traefik

```yaml
# compose.yaml
services:
  traefik:
    image: traefik:v3.2
    restart: unless-stopped
    command:
      - --providers.docker=true
      - --providers.docker.exposedByDefault=false
      - --entrypoints.web.address=:80
      - --entrypoints.web.http.redirections.entrypoint.to=websecure
      - --entrypoints.web.http.redirections.entrypoint.scheme=https
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.le.acme.email=you@example.com
      - --certificatesresolvers.le.acme.storage=/letsencrypt/acme.json
      - --certificatesresolvers.le.acme.tlschallenge=true
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./letsencrypt:/letsencrypt

  maad:
    image: maadb:0.5.0
    restart: unless-stopped
    environment:
      MAAD_TRANSPORT: http
      MAAD_HTTP_HOST: 0.0.0.0      # safe — traefik is the only ingress
      MAAD_HTTP_PORT: 7733
      MAAD_INSTANCE: /data/instance.yaml
      MAAD_SESSION_IDLE_MS: 1800000
      MAAD_HTTP_MAX_BODY: 1048576
      MAAD_SHUTDOWN_TIMEOUT_MS: 10000
      MAAD_TRUST_PROXY: "true"     # trust X-Forwarded-For from traefik
      MAAD_LOG_LEVEL: info
      MAAD_AUDIT_PATH: /data/logs/audit.log
    # Docker secrets materialize at /run/secrets/<name>. Read the token from
    # that file via MAAD_AUTH_TOKEN_FILE-style pattern, or shell-wrap to export
    # it. Example below uses a small entrypoint wrapper.
    secrets:
      - maad_auth_token
    entrypoint: ["/bin/sh", "-c"]
    command:
      - 'export MAAD_AUTH_TOKEN="$(cat /run/secrets/maad_auth_token)" && exec /usr/bin/tini -- node dist/cli.js serve'
    volumes:
      - ./instance.yaml:/data/instance.yaml:ro
      - ./data:/data
    labels:
      - traefik.enable=true
      - traefik.http.routers.maad.rule=Host(`maad.example.com`)
      - traefik.http.routers.maad.entrypoints=websecure
      - traefik.http.routers.maad.tls.certresolver=le
      - traefik.http.services.maad.loadbalancer.server.port=7733
      # SSE-safe timeouts and no response buffering
      - traefik.http.services.maad.loadbalancer.responseforwarding.flushinterval=100ms
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:7733/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
      interval: 30s
      timeout: 5s
      start_period: 10s
      retries: 3

secrets:
  maad_auth_token:
    file: ./secrets/maad_auth_token
```

Start:

```bash
docker compose up -d
docker compose logs -f maad
```

## 4. Smoke test

```bash
TOKEN=$(cat secrets/maad_auth_token)

# Liveness — no auth required
curl -fsS https://maad.example.com/healthz

# Initialize — needs bearer
curl -sS -X POST https://maad.example.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0.1"}}}' -i
```

Expected: `200 OK` on initialize with an `mcp-session-id` header. Missing/wrong token returns `401 UNAUTHORIZED` before any session state is created.

## 5. Client-side MCP config

User responsibility. For Claude Code / Claude Desktop:

```json
{
  "mcpServers": {
    "maad": {
      "transport": { "type": "http", "url": "https://maad.example.com/mcp" },
      "headers": { "Authorization": "Bearer ${MAAD_TOKEN}" }
    }
  }
}
```

Keep `MAAD_TOKEN` in the client's environment, never in the committed config.

## 6. Hot-reload instance.yaml (0.6.9+)

Edit `instance.yaml` on the mounted volume and send `SIGHUP` to the container:

```bash
# Edit /path/to/instance.yaml on the host (it's a bind-mount, picked up live)
docker compose kill -s SIGHUP maad

# Or invoke the MCP tool from an admin session (HTTP):
# maad_instance_reload → { projectsAdded, projectsRemoved, ... }

# Inspect what happened:
docker compose logs maad --since 1m | grep instance_reload
# instance_reload_start / instance_reload_complete
# audit: instance_reload { source: "sighup", projectsAdded: [...], ... }
```

Added projects register lazily (first tool call on the new project boots its engine). Removed projects evict their engine and cancel sessions bound to them (single-mode → `SESSION_CANCELLED` on next call; multi-mode → whitelist pruned, session survives if it has other projects). Path or role mutations on existing projects reject with `INSTANCE_MUTATION_UNSUPPORTED` — until the 0.9.0 eviction policy lands, use remove-then-re-add across two reload cycles.

## 7. Rotating the token

Today this is a restart:

```bash
openssl rand -base64 48 | tr -d '=' | tr '+/' '-_' > secrets/maad_auth_token
chmod 600 secrets/maad_auth_token
docker compose up -d --force-recreate maad
```

Clients update their copy out-of-band. In-flight writes get `MAAD_SHUTDOWN_TIMEOUT_MS` to drain before the container exits. Rotation without restart is on the roadmap (0.8.5).

## Multi-tenant hosting with X-Maad-Pin-Project (0.6.8+)

If you're running one engine container serving multiple projects and want a gateway (your own app, or traefik middleware) to lock each client to exactly one project, use the `X-Maad-Pin-Project` header. The engine binds the session to the named project at `initialize` and blocks any `maad_use_project` / `maad_use_projects` rebind with `SESSION_PINNED`.

### Gateway-side contract

The gateway MUST do two things on every request forwarded to the engine:

1. **Strip any client-supplied `X-Maad-Pin-Project` header** before adding its own. Forwarding a client-set value defeats the pin — any authenticated client would just pick their own tenant.
2. **Set `X-Maad-Pin-Project` to the project name corresponding to the authenticated user** (an opaque slug you mint at signup is the usual pattern).

Add a unit test in the gateway that asserts a client-supplied `X-Maad-Pin-Project` is not forwarded. This is the single most important test for this pattern.

### Load-bearing security invariant

The header is trusted. If the engine is directly reachable from clients, the header has no security value. Run the engine behind a Docker network (as the compose stack above does — `MAAD_HTTP_HOST=0.0.0.0` inside the container's isolated namespace, accessible only via traefik). Never publish the engine port to the host.

### traefik pin-strip middleware

Traefik 3.x strips request headers via the `headers` middleware. To strip any client-supplied `X-Maad-Pin-Project` before forwarding:

```yaml
# compose.yaml — under the maad service labels
labels:
  - traefik.http.middlewares.maad-strip-pin.headers.customrequestheaders.X-Maad-Pin-Project=
  - traefik.http.routers.maad.middlewares=maad-strip-pin@docker
```

An empty value in `customrequestheaders` replaces any client-supplied value with an empty string before forwarding — the engine treats that as "header absent" (no pin applied). You then inject the real pin from your app-level gateway after the authn step.

If traefik is the only gateway AND you're authenticating via a forward-auth middleware, have the forward-auth service return the project slug in a response header and use traefik's `authResponseHeaders` to plumb it into `X-Maad-Pin-Project` on the forwarded request.

### Observability

- `maad_health.sessions.pinned` — count of currently active pinned sessions
- `session_open` audit event — `binding_source: "gateway_pin"` on pinned sessions
- `pin_rejected` ops event — emitted on every `PIN_PROJECT_INVALID` / `PIN_PROJECT_NOT_FOUND` / `PIN_ON_EXISTING_SESSION` with `{remote_addr, code, project}`

If `maad_health.sessions.pinned` is 0 and you expect pinning, check the gateway container's logs and the headers hitting the engine.

### Legacy / single-project mode

If you run with `MAAD_PROJECT` instead of `MAAD_INSTANCE`, the engine logs `pin_ignored_legacy` once per process when it first sees the header and proceeds unpinned. Pinning has no meaning in single-project mode.

## Gotchas

- **Token required at boot.** `--transport http` without `MAAD_AUTH_TOKEN` fails with `AUTH_TOKEN_REQUIRED`. Don't forget the `export` line in the entrypoint wrapper.
- **Bind host inside the container.** `MAAD_HTTP_HOST=0.0.0.0` is correct here — the container's network namespace is isolated and traefik is the only ingress. The loopback-only warning doesn't apply behind Docker's userland networking.
- **SSE and proxy buffering.** Traefik doesn't buffer response bodies by default, but some orchestrators insert a second proxy. If `tools/list` hangs after `initialize` returns, look for buffering in the ingress chain. The `flushinterval=100ms` label above helps.
- **Git inside the container.** The engine needs git for its audit trail — the Dockerfile installs git in the runtime image. Bind-mounted project dirs must include `.git/`. First boot on an empty dir will `git init` automatically.
- **tini as PID 1.** Without it, `docker stop` sends SIGTERM to node but node may not propagate it through the shell wrapper. tini makes the drain → exit cycle reliable.
- **Non-root UID mapping.** The image runs as UID 10001. If your host project directories are owned by a different UID, either chown them or adjust the `maad` user in the Dockerfile before building.
- **HEALTHCHECK during drain.** `/healthz` returns 503 `SHUTTING_DOWN` while draining — orchestrators will mark the container unhealthy and stop routing traffic to it during restart. That's intentional.
