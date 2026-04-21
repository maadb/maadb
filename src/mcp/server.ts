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
import { initLogging, readLoggingEnv } from '../logging.js';
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
import * as discoverTools from './tools/discover.js';
import * as readTools from './tools/read.js';
import * as writeTools from './tools/write.js';
import * as auditTools from './tools/audit.js';
import * as maintainTools from './tools/maintain.js';
import * as instanceTools from './tools/instance.js';

export type Transport = 'stdio' | 'http';

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
  initIdempotencyCache(readIdempotencyEnv());
  initRateLimiter(readRateLimitEnv());

  // Build the instance-scoped runtime context
  const pool = new EnginePool(instance);
  const sessions = new SessionRegistry(instance);
  const ctx: InstanceCtx = { instance, pool, sessions };

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
      // maad_instance_reload always registers for admin, even on synthetic
      // instances — handler rejects synthetic with INSTANCE_RELOAD_SYNTHETIC
      // rather than an opaque "unknown tool" response.
      toolCount += instanceTools.registerReload(server, ctx);
    }
    return { server, toolCount };
  };

  const transportKind: Transport = opts.transport ?? 'stdio';

  if (transportKind === 'http') {
    if (!opts.http) {
      console.error('MAAD MCP: --transport http requires HTTP config');
      process.exit(1);
    }
    // One-time registration log using a throwaway count from a probe server.
    // In HTTP mode the real server instances are built per session.
    const { toolCount } = buildMcpServer();
    logger.info('mcp', 'startup',
      `${toolCount} tools registered — instance "${instance.name}" (${instance.source}), ${instance.projects.length} project(s)${dryRun ? ' (dry-run)' : ''} [transport=http]`);

    initTransportTelemetry({ kind: 'http', host: opts.http.host, port: opts.http.port });

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
      maxBodyBytes: opts.http.maxBodyBytes,
      headersTimeoutMs: opts.http.headersTimeoutMs,
      requestTimeoutMs: opts.http.requestTimeoutMs,
      keepAliveTimeoutMs: opts.http.keepAliveTimeoutMs,
      trustProxy: opts.http.trustProxy,
      idleMs: opts.http.idleMs,
      authToken: opts.http.authToken,
      sessions: ctx.sessions,
      instance,
      serverFactory: () => buildMcpServer().server,
    });

    installSignalHandlers(
      { pool, rateLimiter: getRateLimiter() },
      {
        finalCleanup: async () => {
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

  installSignalHandlers(
    { pool, rateLimiter: getRateLimiter() },
    {
      finalCleanup: async () => {
        try { await server.close(); } catch { /* best-effort */ }
      },
    },
  );
  installReloadSignalHandler(ctx);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('mcp', 'startup', 'Server started on stdio');
}
