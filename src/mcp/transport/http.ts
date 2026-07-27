// ============================================================================
// HTTP/SSE transport for MCP (0.5.0 R1 — transport scaffold, no auth yet)
//
// Creates a node:http server, routes /mcp POST/GET/DELETE through the SDK's
// StreamableHTTPServerTransport. One transport instance per session, stored
// in a session-keyed map. node:http timeouts are set explicitly (slowloris +
// hung-request defense). Response hardening headers injected on every response.
// Auth layers in R2, session registry fan-out in R3.
// ============================================================================

import { createServer as createHttpServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, unlinkSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../../engine/logger.js';
import { logAuthFailure, logOriginRejected, logPinRejected, logSessionPrincipalMismatch, logSessionTokenEvicted } from '../../logging.js';
import { resolveToken } from './auth.js';
import type { TokenStore } from '../../auth/token-store.js';
import type { TokenId, TokenRecord } from '../../auth/types.js';
import { validatePinHeader } from './pin.js';
import { parseAllowedOrigins, checkOrigin } from './origin.js';
import type { SessionRegistry } from '../../instance/session.js';
import type { InstanceConfig } from '../../instance/config.js';
import { recordIdleSweep, recordSessionOpen } from './telemetry.js';
import { isShuttingDown } from '../shutdown.js';
import { registerNotifier, unregisterNotifier, type ChangeEvent } from '../notifications.js';

export interface HttpTransportOptions {
  host: string;
  port: number;
  /**
   * 0.7.5 — When set, the server binds to this Unix domain
   * socket path instead of host:port. Same MCP protocol over a different
   * socket, so all auth/session/SSE plumbing is reused unchanged. Intended
   * deployment: trusted-app-process colocated with the engine, socket file
   * mode gates access at the filesystem layer (defense-in-depth on top of
   * the bearer auth that's still required). `host`/`port`/`trustProxy` are
   * ignored when this is set.
   */
  socketPath?: string | undefined;
  /** Octal file mode applied to the socket after bind. Default 0o660. */
  socketMode?: number | undefined;
  maxBodyBytes: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
  keepAliveTimeoutMs: number;
  trustProxy: boolean;
  /**
   * Per-session idle threshold. A session with no inbound client request for
   * this many milliseconds is evicted by the idle sweeper. Defaults to 30 min.
   * Outbound SSE pushes from the server do NOT count as activity — server
   * activity != client activity.
   */
  idleMs: number;
  /** Hard bound on retained per-session transports and MCP server graphs. */
  maxSessions?: number | undefined;
  /**
   * 0.12.0 — Exact browser origins allowed to call /mcp (MCP Streamable HTTP
   * Origin validation, DNS-rebinding defense). Requests WITHOUT an Origin
   * header always pass (non-browser MCP clients don't send one). A present
   * Origin not in this list is rejected 403 ORIGIN_FORBIDDEN before auth,
   * pin, or session handling. Empty/omitted = deny every browser-originated
   * request — the secure default; only deployments where a browser calls
   * /mcp directly need entries. No wildcards, no implicit localhost.
   */
  allowedOrigins?: readonly string[] | undefined;
  /**
   * 0.7.0 — Token registry for scoped auth. Production HTTP mode requires a
   * non-null store with ≥1 active token (server.ts enforces via
   * checkHttpAuthAtBoot before this transport is even instantiated). Tests
   * and dev convenience may pass undefined to bypass auth entirely; when
   * undefined, every request is accepted without a bearer check.
   */
  tokens?: TokenStore | undefined;
  /**
   * Session registry for protocol-level state. HTTP transport fires destroy()
   * on its close, which fans out to whatever close handlers the server
   * wired in (rate-limit dispose, audit log, etc.).
   */
  sessions: SessionRegistry;
  /**
   * Instance config — needed for X-Maad-Pin-Project header validation.
   * The pin validator checks values against instance.projects[].name and
   * skips validation entirely for synthetic (legacy single-project) mode.
   */
  instance: InstanceConfig;
  /** Factory called once per new session to produce a fresh McpServer with tools registered. */
  serverFactory: () => McpServer;
}

interface TransportEntry {
  transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastActivityAt: number;
  remoteAddr: string;
  /**
   * Principal binding — the token id resolved from the bearer that initialized
   * this session. Every subsequent request must present a bearer resolving to
   * this exact id; the session id itself is routing data, never authorization
   * proof. `null` only in the tokens-undefined test/dev bypass, where requests
   * carry no principal to compare. Rotation issues a new token id, so a
   * rotated bearer can never resume the old session either.
   */
  tokenId: TokenId | null;
}

export interface HttpTransportHandle {
  httpServer: HttpServer;
  close: () => Promise<void>;
  activeSessionCount: () => number;
  /**
   * Tear down every session whose bound token is no longer active in the
   * store (revoked, expired, or removed). Returns the number evicted.
   * Called immediately after in-process token mutations/reloads (via
   * ctx.onTokensChanged) and on every sweeper tick as a backstop.
   * `excludeSessionId` skips one session — see InstanceCtx.onTokensChanged.
   */
  evictInvalidTokenSessions: (excludeSessionId?: string) => number;
}

function remoteAddrFor(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) return xff.split(',')[0]!.trim();
    if (Array.isArray(xff) && xff.length > 0) return xff[0]!.trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

function writeJsonError(res: ServerResponse, status: number, code: string, message: string): void {
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
  res.end(JSON.stringify({ ok: false, errors: [{ code, message }] }));
}

function applyResponseHardening(res: ServerResponse, kind: 'json' | 'sse'): void {
  // SDK emits Cache-Control: no-cache (or no-cache, no-transform) on SSE and some JSON paths.
  // We layer in no-store on JSON responses and nosniff on all responses.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (kind === 'json') {
    res.setHeader('Cache-Control', 'no-store');
  }
}

export async function startHttpTransport(opts: HttpTransportOptions): Promise<HttpTransportHandle> {
  const entries = new Map<string, TransportEntry>();
  const maxSessions = Math.max(1, opts.maxSessions ?? 128);

  // 0.12.0 — canonicalize the Origin allowlist once at startup. A bad entry
  // is an operator configuration error: fail boot loudly rather than run
  // with a silently narrower (or unintentionally empty) allowlist.
  const originCfg = parseAllowedOrigins(opts.allowedOrigins ?? []);
  if (!originCfg.ok) {
    throw new Error(`invalid allowed-origin configuration: ${originCfg.errors.join('; ')}`);
  }
  const allowedOrigins = originCfg.origins;

  const discardEntry = (sid: string, reason: 'idle' | 'capacity' | 'shutdown' | 'auth'): TransportEntry | undefined => {
    const entry = entries.get(sid);
    if (!entry) return undefined;
    entries.delete(sid);
    unregisterNotifier(sid);
    opts.sessions.destroy(sid, reason);
    return entry;
  };
  // Fire `pin_ignored_legacy` at most once per process so operators see the
  // signal without getting log spam when a legacy deployment is being probed.
  let legacyPinWarned = false;

  // Principal-binding teardown: close every session whose bound token is no
  // longer active. Per-request auth already fences a dead bearer's next call,
  // but an established SSE stream never re-presents its bearer — eviction is
  // what actually terminates captured authority. Fired via ctx.onTokensChanged
  // right after in-process revoke/rotate/reload, and from the sweeper as a
  // backstop (external tokens.yaml edits + expiry have no in-process signal).
  const evictInvalidTokenSessions = (excludeSessionId?: string): number => {
    const store = opts.tokens;
    if (store === undefined) return 0;
    const nowMs = Date.now();
    let evicted = 0;
    for (const [sid, entry] of entries) {
      if (entry.tokenId === null) continue;
      if (sid === excludeSessionId) continue;
      const record = store.lookupById(entry.tokenId);
      const reason: 'removed' | 'revoked' | 'expired' | null =
        record === undefined ? 'removed'
        : record.revokedAt !== undefined ? 'revoked'
        : record.expiresAt !== undefined && new Date(record.expiresAt).getTime() < nowMs ? 'expired'
        : null;
      if (reason === null) continue;
      logSessionTokenEvicted({ session_id: sid, token_id: entry.tokenId, reason });
      discardEntry(sid, 'auth');
      void entry.transport.close().catch(() => { /* best-effort */ });
      evicted += 1;
    }
    return evicted;
  };

  const httpServer = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${opts.host}`);

      // Liveness probe — unauthenticated, minimal, no state leak. Routed
      // BEFORE auth so container runtimes and orchestrators can probe the
      // process without holding a copy of the bearer token. Returns 503
      // SHUTTING_DOWN during drain so an orchestrator's failing probe during
      // deploy signals "process is exiting" rather than "process is broken".
      if (url.pathname === '/healthz' && req.method === 'GET') {
        const draining = isShuttingDown();
        res.statusCode = draining ? 503 : 200;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (draining) {
          res.end(JSON.stringify({ ok: false, errors: [{ code: 'SHUTTING_DOWN', message: 'server is draining' }] }));
        } else {
          res.end(JSON.stringify({ ok: true }));
        }
        return;
      }

      if (url.pathname !== '/mcp') {
        writeJsonError(res, 404, 'NOT_FOUND', 'Unknown path');
        return;
      }

      // Middleware step 0: Origin validation (0.12.0) — MCP Streamable HTTP
      // DNS-rebinding defense. Scoped to /mcp only; runs before body-size,
      // auth, pin, and session handling so a rejected browser request can
      // never create or touch session state, and never learns whether a
      // session ID exists. Requests without an Origin header pass — Origin
      // is browser-attached; MCP SDK clients, CLIs, and backends omit it.
      const originVerdict = checkOrigin(req.headers['origin'], allowedOrigins);
      if (originVerdict === 'forbidden') {
        const rawOrigin = req.headers['origin'];
        logOriginRejected({
          remote_addr: remoteAddrFor(req, opts.trustProxy),
          origin: typeof rawOrigin === 'string' ? rawOrigin : null,
        });
        writeJsonError(res, 403, 'ORIGIN_FORBIDDEN', 'Origin not allowed');
        return;
      }

      // Body-size pre-check via Content-Length. Streaming bypass is possible but
      // stretches the threat model — clients that chunk around this cap are
      // already hostile, and 0.5.0's rate limiter catches sustained abuse.
      const contentLength = Number.parseInt(req.headers['content-length'] ?? '0', 10);
      if (Number.isFinite(contentLength) && contentLength > opts.maxBodyBytes) {
        writeJsonError(res, 413, 'PAYLOAD_TOO_LARGE',
          `Request body exceeds ${opts.maxBodyBytes} bytes`);
        return;
      }

      // Middleware step 1: auth. Runs BEFORE session resolution so an
      // unauthenticated caller can never discover whether a session id
      // exists (404 SESSION_NOT_FOUND is reserved for authenticated callers).
      // 0.7.0 — resolveToken replaces shared-secret validateBearer. Every
      // failure reason maps to a plain 401; distinct codes surface only in
      // the ops log. Success returns the TokenRecord, which we capture for
      // session-creation binding below. If tokens is undefined (test/dev
      // bypass), we skip auth entirely — production boot enforces presence.
      let authedToken: TokenRecord | null = null;
      if (opts.tokens !== undefined) {
        const authOutcome = resolveToken(req, opts.tokens);
        if (!authOutcome.ok) {
          logAuthFailure({
            remote_addr: remoteAddrFor(req, opts.trustProxy),
            reason: authOutcome.reason === 'missing' ? 'missing' : 'invalid',
          });
          writeJsonError(res, 401, 'UNAUTHORIZED', 'missing or invalid bearer token');
          return;
        }
        authedToken = authOutcome.record;
      }

      // Middleware step 2: X-Maad-Pin-Project (0.6.8) — trusted-gateway
      // session pinning for multi-tenant hosted deployments. Runs AFTER auth
      // (rejections need an authenticated context) and BEFORE session
      // resolution (pin is a session-creation property). Silent skip in
      // synthetic/legacy single-project mode per spec §Interaction with
      // existing features.
      let pinnedProjectName: string | undefined;
      if (opts.instance.source === 'synthetic') {
        if (req.headers['x-maad-pin-project'] !== undefined && !legacyPinWarned) {
          logger.info('mcp', 'http', 'X-Maad-Pin-Project received on synthetic single-project instance; ignoring (pin_ignored_legacy)');
          legacyPinWarned = true;
        }
      } else {
        const pin = validatePinHeader(req, opts.instance);
        if (pin.status === 'rejected') {
          const pinValueRaw = req.headers['x-maad-pin-project'];
          const pinValue = typeof pinValueRaw === 'string' ? pinValueRaw : null;
          logPinRejected({
            remote_addr: remoteAddrFor(req, opts.trustProxy),
            code: pin.code,
            project: pinValue,
          });
          writeJsonError(res, 400, pin.code, pin.message);
          return;
        }
        if (pin.status === 'valid') {
          pinnedProjectName = pin.projectName;
        }
      }

      const sessionIdHeader = req.headers['mcp-session-id'];
      const sessionId = typeof sessionIdHeader === 'string' ? sessionIdHeader : undefined;

      // Existing session — enforce principal binding, then route.
      if (sessionId && entries.has(sessionId)) {
        const entry = entries.get(sessionId)!;
        // Principal binding: the session id routes, the bearer authorizes.
        // The current request's token must be the exact token that
        // initialized this session — a different valid principal that
        // learned the session id gets a response wire-identical to an
        // unknown session, so it cannot even confirm the session exists.
        // Applies to POST (tool calls), GET (SSE attach/resume), and DELETE
        // (session teardown) alike; auth ran above, so this check is
        // synchronous with it in the same event-loop turn (no await between
        // resolveToken and here — no revoke/rotate can interleave).
        const presentedTokenId = authedToken?.id ?? null;
        if (entry.tokenId !== presentedTokenId) {
          logSessionPrincipalMismatch({
            remote_addr: remoteAddrFor(req, opts.trustProxy),
            session_id: sessionId,
            bound_token_id: entry.tokenId,
            presented_token_id: presentedTokenId,
          });
          writeJsonError(res, 404, 'SESSION_NOT_FOUND', 'Unknown session');
          return;
        }
        // Same principal — refresh the registry's token snapshot to the
        // record the store holds NOW, so audit identity and any late bind
        // composition never run on authority older than the current token
        // record. peek(), not get(): the registry's activity clock is bumped
        // by tool dispatch, not transport routing.
        if (authedToken !== null) {
          const st = opts.sessions.peek(sessionId);
          if (st) st.token = authedToken;
        }
        // Inbound client request — bump transport-level lastActivityAt. This
        // is the clock the idle sweeper uses. We intentionally do NOT update
        // it on outbound SSE pushes; those are server activity, not client.
        entry.lastActivityAt = Date.now();
        applyResponseHardening(res, req.method === 'GET' ? 'sse' : 'json');
        await entry.transport.handleRequest(req, res);
        return;
      }

      // Unknown session ID on non-initialize request — 404
      if (sessionId) {
        writeJsonError(res, 404, 'SESSION_NOT_FOUND', 'Unknown session');
        return;
      }

      // No session ID: must be POST for initialize
      if (req.method !== 'POST') {
        writeJsonError(res, 400, 'BAD_REQUEST', 'Mcp-Session-Id header required');
        return;
      }

      // New session: transport delegates ID generation to us (128-bit CSPRNG)
      const remoteAddr = remoteAddrFor(req, opts.trustProxy);
      const pinForClosure = pinnedProjectName;
      const tokenForClosure = authedToken;
      // Forward-reference to the McpServer built below. Captured by the
      // onsessioninitialized closure so 0.6.11 live-notification registration
      // can fire `sendResourceUpdated` through the right per-session server.
      let mcpServerRef: McpServer | null = null;
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(16).toString('base64url'),
        onsessioninitialized: (sid: string) => {
          const now = Date.now();
          if (entries.size >= maxSessions) {
            let oldestSid: string | undefined;
            let oldestActivity = Number.POSITIVE_INFINITY;
            for (const [candidateSid, candidate] of entries) {
              if (candidate.lastActivityAt < oldestActivity) {
                oldestSid = candidateSid;
                oldestActivity = candidate.lastActivityAt;
              }
            }
            if (oldestSid !== undefined) {
              const oldest = discardEntry(oldestSid, 'capacity');
              if (oldest) void oldest.transport.close().catch(() => { /* best-effort */ });
            }
          }
          entries.set(sid, {
            transport,
            createdAt: now,
            lastActivityAt: now,
            remoteAddr,
            tokenId: tokenForClosure?.id ?? null,
          });
          // Register protocol-level state so registry.destroy(sid) has
          // something to destroy — otherwise the fan-out chain (rate-limit
          // dispose, audit handlers) never runs. withSession may also
          // create(sid) lazily on first tool call; create() is idempotent.
          const state = opts.sessions.create(sid);
          // 0.7.0 — Attach the authed token BEFORE any bindSingle/bindMulti
          // call so the three-cap effective-role composition sees it. Subsequent
          // requests on this session re-validate their bearer at the middleware
          // layer; the state.token is a snapshot at initialize time for
          // consistent effective-role resolution.
          if (tokenForClosure !== null) state.token = tokenForClosure;
          // Gateway pin (0.6.8): if the pin header validated, bind the session
          // synchronously before any tool call can reach a handler. Rebind
          // protection lives in SessionRegistry.bindSingle (SESSION_PINNED
          // error on subsequent maad_use_project calls).
          if (pinForClosure !== undefined) {
            const pinBind = opts.sessions.bindSingle(sid, pinForClosure, { source: 'gateway_pin' });
            if (!pinBind.ok) {
              // Should be impossible — we validated the project exists before
              // session creation. Log loudly if it ever fires.
              const msg = pinBind.errors.map(e => `${e.code}: ${e.message}`).join('; ');
              logger.error('mcp', 'http', `gateway pin bind failed for session ${sid}: ${msg}`);
            }
          }
          // 0.6.11 — register per-session notifier keyed on this sid. Fires
          // `notifications/resources/updated` with a synthetic maad://records/
          // URI plus extra params carrying the full ChangeEvent shape.
          // MCP clients that only read `uri` still get a valid notification;
          // clients that read params get the typed event.
          if (mcpServerRef) {
            const capturedServer = mcpServerRef;
            registerNotifier(sid, async (event: ChangeEvent): Promise<void> => {
              await capturedServer.server.sendResourceUpdated({
                uri: `maad://records/${event.docId}`,
                ...({ action: event.action, docId: event.docId, docType: event.docType, project: event.project, updatedAt: event.updatedAt } as Record<string, unknown>),
              });
            });
          }
          const ua = req.headers['user-agent'];
          const openFields: Parameters<typeof recordSessionOpen>[0] = {
            session_id: sid,
            remote_addr: remoteAddr,
            user_agent: typeof ua === 'string' ? ua : null,
            transport: 'http',
          };
          if (pinForClosure !== undefined) openFields.binding_source = 'gateway_pin';
          recordSessionOpen(openFields);
        },
      });
      transport.onclose = (): void => {
        const sid = transport.sessionId;
        if (sid && entries.has(sid)) {
          entries.delete(sid);
          // 0.6.11 — drop the notifier before destroy so it can't race with
          // in-flight writes. destroy() itself fires close handlers but the
          // notifier lives outside that registry.
          unregisterNotifier(sid);
          // Fan out to the registry — this fires close handlers the server
          // wired in (rate-limit dispose, session_close audit, etc.).
          opts.sessions.destroy(sid, 'transport');
        }
      };

      const mcpServer = opts.serverFactory();
      mcpServerRef = mcpServer;
      // SDK's StreamableHTTPServerTransport declares onclose/onerror/onmessage
      // as optional, but Server.connect's Transport interface declares them
      // non-optional under exactOptionalPropertyTypes. Widening cast is the
      // least invasive workaround; the runtime shape is identical.
      await mcpServer.connect(transport as unknown as Parameters<typeof mcpServer.connect>[0]);

      applyResponseHardening(res, 'json');
      await transport.handleRequest(req, res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('mcp', 'http', `request error: ${msg}`);
      if (!res.headersSent) {
        writeJsonError(res, 500, 'INTERNAL', 'Internal server error');
      } else {
        try { res.end(); } catch { /* best-effort */ }
      }
    }
  });

  httpServer.headersTimeout = opts.headersTimeoutMs;
  httpServer.requestTimeout = opts.requestTimeoutMs;
  httpServer.keepAliveTimeout = opts.keepAliveTimeoutMs;

  // 0.7.5 — bind to Unix socket when configured; otherwise TCP.
  // Stale-socket cleanup before listen() handles the common case where a
  // crashed prior process left the socket file behind. Socket mode (default
  // 0o660) chmod-applied after listen so transient world-readable race is
  // bounded by listen-then-chmod (well under any real attacker window for
  // the trusted-host deploy this targets).
  if (opts.socketPath) {
    try {
      if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
    } catch (e) {
      throw new Error(`failed to remove stale Unix socket at ${opts.socketPath}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(opts.socketPath, () => {
        httpServer.off('error', reject);
        const mode = opts.socketMode ?? 0o660;
        try { chmodSync(opts.socketPath!, mode); } catch (e) {
          logger.bestEffort('mcp', 'http.unix.chmod',
            `chmod ${mode.toString(8)} on ${opts.socketPath} failed`,
            { error: e instanceof Error ? e.message : String(e) });
        }
        resolve();
      });
    });
    logger.info('mcp', 'http', `Server started on unix:${opts.socketPath}/mcp (mode ${(opts.socketMode ?? 0o660).toString(8)})`);
  } else {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(opts.port, opts.host, () => {
        httpServer.off('error', reject);
        resolve();
      });
    });
    logger.info('mcp', 'http', `Server started on http://${opts.host}:${opts.port}/mcp`);
  }

  // Idle sweeper — walks the entries map every ~60s and evicts transports
  // whose lastActivityAt is past the idle threshold. Unref'd so the interval
  // alone doesn't keep the event loop alive; tick cadence is capped at
  // idleMs so tiny idle thresholds don't produce microsecond spins in tests.
  const sweepIntervalMs = Math.max(1_000, Math.min(60_000, Math.floor(opts.idleMs / 2) || 60_000));
  const idleSweeper = setInterval(() => {
    // Backstop for principal-binding teardown — catches token expiry and
    // out-of-process tokens.yaml edits that never fire ctx.onTokensChanged.
    evictInvalidTokenSessions();
    const now = Date.now();
    const threshold = now - opts.idleMs;
    let swept = 0;
    for (const [sid, entry] of entries) {
      if (entry.lastActivityAt < threshold) {
        // Mark the registry first so the fan-out reason reflects WHY it
        // closed. The transport.onclose below would otherwise fire with
        // reason=transport. Destroy is idempotent so calling it twice is safe.
        discardEntry(sid, 'idle');
        // Close the SSE transport — frees sockets and triggers SDK cleanup.
        void entry.transport.close().catch(() => { /* best-effort */ });
        swept += 1;
      }
    }
    if (swept > 0) {
      recordIdleSweep({ swept, remaining: entries.size });
    }
  }, sweepIntervalMs);
  idleSweeper.unref?.();

  return {
    httpServer,
    activeSessionCount: () => entries.size,
    evictInvalidTokenSessions,
    close: async () => {
      clearInterval(idleSweeper);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      for (const [sid, entry] of entries) {
        discardEntry(sid, 'shutdown');
        try { await entry.transport.close(); } catch { /* best-effort */ }
      }
      entries.clear();
      // 0.7.5 — UDS cleanup. Best-effort: if a fast SIGKILL beat us here,
      // the next startup's stale-socket unlink will catch it.
      if (opts.socketPath) {
        try {
          if (existsSync(opts.socketPath)) unlinkSync(opts.socketPath);
        } catch { /* best-effort */ }
      }
    },
  };
}
