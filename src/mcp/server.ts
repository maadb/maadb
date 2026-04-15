// ============================================================================
// MCP Server — transport setup and tool registration
// Lifecycle, config, and guardrails are extracted into separate modules.
// ============================================================================

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildConfig } from './config.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };
import { setGuardrailConfig } from './guardrails.js';
import { setProvenanceMode } from './response.js';
import { initIdempotencyCache, readIdempotencyEnv } from './idempotency.js';
import { initRateLimiter, readRateLimitEnv } from './rate-limit.js';
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

export interface ServeOptions {
  projectRoot?: string | undefined;
  instancePath?: string | undefined;
  role?: string | undefined;
  dryRun?: boolean | undefined;
  toolAllowlist?: string[] | undefined;
  provenance?: string | undefined;
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

  // Create MCP server
  const server = new McpServer({ name: 'maad', version: pkg.version });

  // Register tools. Legacy synthetic mode keeps the 0.2.x role-tier registration
  // (reader sees no writer tools, etc). Real instance mode registers the full
  // superset; per-call role gating happens in withEngine.
  const legacyRole = instance.source === 'synthetic' ? parseRole(opts.role) : 'admin';

  // Instance-level tools are only exposed in real multi-project mode. In
  // legacy single-project mode the session auto-binds, so use_project has
  // no purpose and would only confuse clients.
  let toolCount = 0;
  if (instance.source === 'file') {
    instanceTools.register(server, ctx);
    toolCount += 4;
  }

  discoverTools.register(server, ctx);
  readTools.register(server, ctx);
  auditTools.register(server, ctx);
  toolCount += 13;

  if (legacyRole === 'writer' || legacyRole === 'admin') {
    writeTools.register(server, ctx);
    toolCount += 5;
  }
  if (legacyRole === 'admin') {
    maintainTools.register(server, ctx);
    toolCount += 4;
  }

  logger.info('mcp', 'startup',
    `${toolCount} tools registered — instance "${instance.name}" (${instance.source}), ${instance.projects.length} project(s)${dryRun ? ' (dry-run)' : ''}`);

  // Shutdown hooks — close the whole pool, not a single engine.
  registerShutdownHooks(null, async () => {
    await pool.closeAll();
    await server.close();
  });

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('mcp', 'startup', 'Server started on stdio');
}
