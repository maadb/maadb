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
import { randomBytes } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logger } from '../../engine/logger.js';
import { logAuthFailure } from '../../logging.js';
import { validateBearer } from './auth.js';
import type { SessionRegistry } from '../../instance/session.js';
import { recordIdleSweep, recordSessionOpen } from './telemetry.js';
import { isShuttingDown } from '../shutdown.js';

export interface HttpTransportOptions {
  host: string;
  port: number;
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
  /**
   * Bearer token required on every request. Compared constant-time against
   * the Authorization header. Undefined disables auth (dev/testing only —
   * production always sets this).
   */
  authToken?: string | undefined;
  /**
   * Session registry for protocol-level state. HTTP transport fires destroy()
   * on its close, which fans out to whatever close handlers the server
   * wired in (rate-limit dispose, audit log, etc.).
   */
  sessions: SessionRegistry;
  /** Factory called once per new session to produce a fresh McpServer with tools registered. */
  serverFactory: () => McpServer;
}

interface TransportEntry {
  transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastActivityAt: number;
  remoteAddr: string;
}

export interface HttpTransportHandle {
  httpServer: HttpServer;
  close: () => Promise<void>;
  activeSessionCount: () => number;
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

  const httpServer = createHttpServer(async (req, res) => {
    try {
      // Body-size pre-check via Content-Length. Streaming bypass is possible but
      // stretches the threat model — clients that chunk around this cap are
      // already hostile, and 0.5.0's rate limiter catches sustained abuse.
      const contentLength = Number.parseInt(req.headers['content-length'] ?? '0', 10);
      if (Number.isFinite(contentLength) && contentLength > opts.maxBodyBytes) {
        writeJsonError(res, 413, 'PAYLOAD_TOO_LARGE',
          `Request body exceeds ${opts.maxBodyBytes} bytes`);
        return;
      }

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

      // Middleware step 1: auth. Runs BEFORE session resolution so an
      // unauthenticated caller can never discover whether a session id
      // exists (404 SESSION_NOT_FOUND is reserved for authenticated callers).
      if (opts.authToken !== undefined) {
        const auth = validateBearer(req, opts.authToken);
        if (!auth.ok) {
          logAuthFailure({ remote_addr: remoteAddrFor(req, opts.trustProxy), reason: auth.reason });
          writeJsonError(res, 401, 'UNAUTHORIZED', 'missing or invalid bearer token');
          return;
        }
      }

      const sessionIdHeader = req.headers['mcp-session-id'];
      const sessionId = typeof sessionIdHeader === 'string' ? sessionIdHeader : undefined;

      // Existing session — route to its transport
      if (sessionId && entries.has(sessionId)) {
        const entry = entries.get(sessionId)!;
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
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomBytes(16).toString('base64url'),
        onsessioninitialized: (sid: string) => {
          const now = Date.now();
          entries.set(sid, { transport, createdAt: now, lastActivityAt: now, remoteAddr });
          // Register protocol-level state so registry.destroy(sid) has
          // something to destroy — otherwise the fan-out chain (rate-limit
          // dispose, audit handlers) never runs. withSession may also
          // create(sid) lazily on first tool call; create() is idempotent.
          opts.sessions.create(sid);
          const ua = req.headers['user-agent'];
          recordSessionOpen({
            session_id: sid,
            remote_addr: remoteAddr,
            user_agent: typeof ua === 'string' ? ua : null,
            transport: 'http',
          });
        },
      });
      transport.onclose = (): void => {
        const sid = transport.sessionId;
        if (sid && entries.has(sid)) {
          entries.delete(sid);
          // Fan out to the registry — this fires close handlers the server
          // wired in (rate-limit dispose, session_close audit, etc.).
          opts.sessions.destroy(sid, 'transport');
        }
      };

      const mcpServer = opts.serverFactory();
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

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, opts.host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  logger.info('mcp', 'http', `Server started on http://${opts.host}:${opts.port}/mcp`);

  // Idle sweeper — walks the entries map every ~60s and evicts transports
  // whose lastActivityAt is past the idle threshold. Unref'd so the interval
  // alone doesn't keep the event loop alive; tick cadence is capped at
  // idleMs so tiny idle thresholds don't produce microsecond spins in tests.
  const sweepIntervalMs = Math.max(1_000, Math.min(60_000, Math.floor(opts.idleMs / 2) || 60_000));
  const idleSweeper = setInterval(() => {
    const now = Date.now();
    const threshold = now - opts.idleMs;
    let swept = 0;
    for (const [sid, entry] of entries) {
      if (entry.lastActivityAt < threshold) {
        // Mark the registry first so the fan-out reason reflects WHY it
        // closed. The transport.onclose below would otherwise fire with
        // reason=transport. Destroy is idempotent so calling it twice is safe.
        opts.sessions.destroy(sid, 'idle');
        entries.delete(sid);
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
    close: async () => {
      clearInterval(idleSweeper);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      for (const [sid, entry] of entries) {
        try { await entry.transport.close(); } catch { /* best-effort */ }
        opts.sessions.destroy(sid, 'shutdown');
      }
      entries.clear();
    },
  };
}
