// ============================================================================
// MCP Server — transport setup and tool registration
// Lifecycle, config, and guardrails are extracted into separate modules.
// ============================================================================

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildConfig } from './config.js';
import { startHttpTransport, type HttpTransportHandle } from './transport/http.js';
import { initTransportTelemetry, recordSessionClose } from './transport/telemetry.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };
import { setGuardrailConfig } from './guardrails.js';
import { setProvenanceMode } from './response.js';
import { initIdempotencyCache, readIdempotencyEnv } from './idempotency.js';
import { initRateLimiter, readRateLimitEnv } from './rate-limit.js';
import { initMemoryPressureWatcher, readMemoryPressureEnv, stopMemoryPressureWatcher } from './memory-pressure.js';
import { initLogging, readLoggingEnv, logOpsChannelReady } from '../logging.js';
import { installSignalHandlers } from './shutdown.js';
import { installReloadSignalHandler } from './reload-signal.js';
import { getRateLimiter } from './rate-limit.js';
import { registerShutdownHooks } from './lifecycle.js';
import { logger } from '../engine/logger.js';
import { synthesizeLegacyInstance, loadInstance, type InstanceConfig } from '../instance/config.js';
import { EnginePool } from '../instance/pool.js';
import { SessionRegistry } from '../instance/session.js';
import type { InstanceCtx } from './ctx.js';
import { parseRole } from './roles.js';
import { TokenStore } from '../auth/token-store.js';
import { checkHttpAuthAtBoot } from './transport/auth.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as discoverTools from './tools/discover.js';
import * as readTools from './tools/read.js';
import * as writeTools from './tools/write.js';
import * as auditTools from './tools/audit.js';
import * as maintainTools from './tools/maintain.js';
import * as backupTools from './tools/backup.js';
import * as cleanupTools from './tools/cleanup.js';
import * as instanceTools from './tools/instance.js';
import * as authTools from './tools/auth.js';

export type Transport = 'stdio' | 'http' | 'unix';

export interface HttpServeOptions {
  host: string;
  port: number;
  maxBodyBytes: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
  keepAliveTimeoutMs: number;
  trustProxy: boolean;
  idleMs: number;
  authToken?: string | undefined;
  /**
   * 0.7.5 (fup-2026-148) — Unix domain socket path. When set with
   * transport='unix' (or 'http' with this populated), the server binds
   * to this socket instead of host:port. Same MCP protocol; trusted-host
   * deploy pattern.
   */
  socketPath?: string | undefined;
  /** Socket file mode (octal). Default 0o660. */
  socketMode?: number | undefined;
}

export interface ServeOptions {
  projectRoot?: string | undefined;
  instancePath?: string | undefined;
  role?: string | undefined;
  dryRun?: boolean | undefined;
  toolAllowlist?: string[] | undefined;
  provenance?: string | undefined;
  transport?: Transport | undefined;
  http?: HttpServeOptions | undefined;
}

export async function startServer(opts: ServeOptions): Promise<void> {
  // Resolve the instance: either loaded from instance.yaml or synthesized
  // from a legacy --project path so existing clients upgrade without changes.
  let instance: InstanceConfig;
  if (opts.instancePath) {
    const loaded = await loadInstance(opts.instancePath);
    if (!loaded.ok) {
      const messages = loaded.errors.map(e => `${e.code}: ${e.message}`).join('; ');
      console.error(`MAAD MCP: instance config invalid: ${messages}`);
      process.exit(1);
    }
    instance = loaded.value;
  } else if (opts.projectRoot) {
    const config = buildConfig({ projectRoot: opts.projectRoot, role: opts.role, dryRun: opts.dryRun, toolAllowlist: opts.toolAllowlist, provenance: opts.provenance });
    instance = synthesizeLegacyInstance(config.projectRoot, parseRole(config.role));
  } else {
    console.error('MAAD MCP: must provide --project or --instance (or MAAD_PROJECT / MAAD_INSTANCE env var)');
    process.exit(1);
  }

  // Build global guardrail + provenance state from opts
  const dryRun = opts.dryRun ?? (process.env.MAAD_DRY_RUN === '1' || process.env.MAAD_DRY_RUN === 'true');
  const provenance = opts.provenance ?? process.env.MAAD_PROV ?? 'off';
  setGuardrailConfig({ dryRun, toolAllowlist: opts.toolAllowlist });
  setProvenanceMode(provenance as any);
  initLogging(readLoggingEnv());
  // 0.7.3 (fup-2026-096) — emit one self-check line so deploy validation can
  // confirm the ops channel is wired before any tool call. If this line is
  // missing in journalctl/stderr, no other ops event (commit_failed,
  // rate_limited, validation_warning) will surface either.
  const loggingEnv = readLoggingEnv();
  logOpsChannelReady({
    destination: loggingEnv.pretty ? 'pretty' : 'stderr',
    level: loggingEnv.level ?? 'info',
    pid: process.pid,
  });
  initIdempotencyCache(readIdempotencyEnv());
  initRateLimiter(readRateLimitEnv());
  // 0.7.10 P5 — V8 heap-pressure sampler. Defaults: 60s interval, 0.8 ratio
  // threshold, 5min fire cooldown. Set MAAD_MEMORY_PRESSURE_INTERVAL_MS=0 to
  // disable. Emits degraded-severity ops events when V8 heap approaches the
  // cgroup-driven heap cap so OOMs are visible pre-crash.
  initMemoryPressureWatcher(readMemoryPressureEnv());

  // 0.7.0 — Load the token registry (HTTP+file mode) or null-out for stdio/synthetic.
  // Boot-mode enforcement happens in the HTTP branch below; in stdio/synthetic
  // the registry is irrelevant (no bearer channel). Parse errors at startup
  // refuse to boot — operator sees the exact file path + js-yaml error.
  let tokens: TokenStore | null = null;
  if (instance.source === 'file' && instance.configPath) {
    const instanceRoot = path.dirname(instance.configPath);
    const loaded = await TokenStore.load(instanceRoot);
    if (!loaded.ok) {
      const messages = loaded.errors.map(e => `${e.code}: ${e.message}`).join('; ');
      console.error(`MAAD MCP: token registry invalid: ${messages}`);
      process.exit(1);
    }
    tokens = loaded.value;
  }

  // Build the instance-scoped runtime context
  const pool = new EnginePool(instance);
  // 0.7.3 (fup-2026-150) — start idle-timeout sweeper. Defaults: 30 min idle,
  // 60s sweep. Set MAAD_PROJECT_IDLE_TIMEOUT_MS=0 to disable.
  pool.startIdleSweeper(EnginePool.readIdleSweepEnv());
  const sessions = new SessionRegistry(instance);
  const ctx: InstanceCtx = { instance, pool, sessions, tokens };

  // For the legacy synthetic path we eager-init the single engine so the
  // first tool call is fast and any startup errors surface immediately. In
  // real instance mode, projects are lazy — engines init on first use.
  if (instance.source === 'synthetic') {
    const eager = await pool.get('default');
    if (!eager.ok) {
      const messages = eager.errors.map(e => `${e.code}: ${e.message}`).join('; ');
      console.error(`MAAD MCP: engine initialization failed: ${messages}`);
      process.exit(1);
    }
  }

  // Tool registration factory. Stdio creates one server for the process.
  // HTTP creates a fresh server per session (per SDK example pattern) — tool
  // registration is cheap (schema only, no engine work), so the per-session
  // cost is negligible and isolation is cleaner.
  const legacyRole = instance.source === 'synthetic' ? parseRole(opts.role) : 'admin';

  const buildMcpServer = (): { server: McpServer; toolCount: number } => {
    const server = new McpServer({ name: 'maad', version: pkg.version });
    let toolCount = 0;
    if (instance.source === 'file') {
      toolCount += instanceTools.register(server, ctx);
    }
    toolCount += discoverTools.register(server, ctx);
    toolCount += readTools.register(server, ctx);
    toolCount += auditTools.register(server, ctx);
    if (legacyRole === 'writer' || legacyRole === 'admin') {
      toolCount += writeTools.register(server, ctx);
    }
    if (legacyRole === 'admin') {
      toolCount += maintainTools.register(server, ctx);
      toolCount += backupTools.register(server, ctx);
      toolCount += cleanupTools.register(server, ctx);
      // maad_instance_reload always registers for admin, even on synthetic
      // instances — handler rejects synthetic with INSTANCE_RELOAD_SYNTHETIC
      // rather than an opaque "unknown tool" response.
      toolCount += instanceTools.registerReload(server, ctx);
      // 0.7.0 — admin token registry tools. Handler refuses if ctx.tokens is
      // null (stdio/synthetic mode has no registry); registering always so
      // synthetic clients get a clear TOKENS_FILE_MISSING error rather than
      // an opaque "unknown tool" response.
      toolCount += authTools.register(server, ctx);
    }
    return { server, toolCount };
  };

  const transportKind: Transport = opts.transport ?? 'stdio';

  if (transportKind === 'http' || transportKind === 'unix') {
    if (!opts.http) {
      console.error(`MAAD MCP: --transport ${transportKind} requires HTTP/UDS config`);
      process.exit(1);
    }
    if (transportKind === 'unix' && !opts.http.socketPath) {
      console.error('MAAD MCP: --transport unix requires --unix-socket=<path> (or MAAD_UNIX_SOCKET env)');
      process.exit(1);
    }

    // 0.7.0 — Legacy single-bearer mode hard-removed (dec-maadb-071). HTTP
    // requires _auth/tokens.yaml with ≥1 active entry. Stale MAAD_AUTH_TOKEN
    // env config surfaces a distinctive LEGACY_BEARER_REMOVED error so
    // operators see the migration hint before chasing a generic boot failure.
    // 0.7.5 — UDS transport reuses the same auth gate; bearer is still required
    // (filesystem perms are defense-in-depth, not a replacement).
    if (instance.source !== 'file' || !instance.configPath) {
      console.error(`MAAD MCP: --transport ${transportKind} requires --instance (synthetic --project mode is stdio-only)`);
      process.exit(1);
    }
    const instanceRoot = path.dirname(instance.configPath);
    const storeExists = existsSync(path.join(instanceRoot, '_auth', 'tokens.yaml'));
    const bootErr = checkHttpAuthAtBoot(tokens!, storeExists, opts.http.authToken);
    if (bootErr !== null) {
      console.error(`MAAD MCP: ${bootErr}`);
      process.exit(1);
    }
    // One-time registration log using a throwaway count from a probe server.
    // In HTTP mode the real server instances are built per session.
    const { toolCount } = buildMcpServer();
    const transportLabel = transportKind === 'unix'
      ? `unix:${opts.http.socketPath}`
      : `http://${opts.http.host}:${opts.http.port}`;
    logger.info('mcp', 'startup',
      `${toolCount} tools registered — instance "${instance.name}" (${instance.source}), ${instance.projects.length} project(s)${dryRun ? ' (dry-run)' : ''} [transport=${transportKind}, ${transportLabel}]`);

    initTransportTelemetry(
      transportKind === 'unix'
        ? { kind: 'unix', socketPath: opts.http.socketPath! }
        : { kind: 'http', host: opts.http.host, port: opts.http.port },
    );

    // Wire session-close fan-out: when a session is destroyed (for any
    // reason — client DELETE, transport drop, idle sweep, shutdown), release
    // its per-session rate-limit state and emit the session_close audit event
    // with the measured duration. Additional handlers stack in registration order.
    ctx.sessions.registerCloseHandler((sid, reason) => {
      getRateLimiter().disposeSession(sid);
      recordSessionClose({ session_id: sid, reason });
    });

    const handle: HttpTransportHandle = await startHttpTransport({
      host: opts.http.host,
      port: opts.http.port,
      socketPath: transportKind === 'unix' ? opts.http.socketPath : undefined,
      socketMode: transportKind === 'unix' ? opts.http.socketMode : undefined,
      maxBodyBytes: opts.http.maxBodyBytes,
      headersTimeoutMs: opts.http.headersTimeoutMs,
      requestTimeoutMs: opts.http.requestTimeoutMs,
      keepAliveTimeoutMs: opts.http.keepAliveTimeoutMs,
      trustProxy: opts.http.trustProxy,
      idleMs: opts.http.idleMs,
      tokens: tokens!,
      sessions: ctx.sessions,
      instance,
      serverFactory: () => buildMcpServer().server,
    });

    installSignalHandlers(
      { pool, rateLimiter: getRateLimiter() },
      {
        finalCleanup: async () => {
          stopMemoryPressureWatcher();
          try { await handle.close(); } catch { /* best-effort */ }
        },
      },
    );
    installReloadSignalHandler(ctx);
    return;
  }

  // stdio — single server, single transport, lifetime of the process
  initTransportTelemetry({ kind: 'stdio' });
  const { server, toolCount } = buildMcpServer();
  logger.info('mcp', 'startup',
    `${toolCount} tools registered — instance "${instance.name}" (${instance.source}), ${instance.projects.length} project(s)${dryRun ? ' (dry-run)' : ''}`);

  // 0.6.11 — stdio live-notification notifier. stdio has exactly one session
  // per process, synthesized lazily on first tool call. Register on create so
  // the sid is known before we install the notifier. Unregister on close.
  const { registerNotifier: regN, unregisterNotifier: unregN } = await import('./notifications.js');
  ctx.sessions.registerCreateHandler((sid) => {
    regN(sid, async (event) => {
      await server.server.sendResourceUpdated({
        uri: `maad://records/${event.docId}`,
        ...({ action: event.action, docId: event.docId, docType: event.docType, project: event.project, updatedAt: event.updatedAt } as Record<string, unknown>),
      });
    });
  });
  ctx.sessions.registerCloseHandler((sid) => { unregN(sid); });

  installSignalHandlers(
    { pool, rateLimiter: getRateLimiter() },
    {
      finalCleanup: async () => {
        stopMemoryPressureWatcher();
        try { await server.close(); } catch { /* best-effort */ }
      },
    },
  );
  installReloadSignalHandler(ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('mcp', 'startup', 'Server started on stdio');
}
