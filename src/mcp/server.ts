// ============================================================================
// MCP Server — transport setup and tool registration
// Lifecycle, config, and guardrails are extracted into separate modules.
// ============================================================================

import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildConfig, type McpConfig } from './config.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json') as { version: string };
import { setGuardrailConfig } from './guardrails.js';
import { setProvenanceMode } from './response.js';
import { startupEngine, registerShutdownHooks } from './lifecycle.js';
import { logger } from '../engine/logger.js';
import * as discoverTools from './tools/discover.js';
import * as readTools from './tools/read.js';
import * as writeTools from './tools/write.js';
import * as auditTools from './tools/audit.js';
import * as maintainTools from './tools/maintain.js';

export interface ServeOptions {
  projectRoot: string;
  role?: string | undefined;
  dryRun?: boolean | undefined;
  toolAllowlist?: string[] | undefined;
  provenance?: string | undefined;
}

export async function startServer(opts: ServeOptions): Promise<void> {
  const config = buildConfig(opts);

  // Startup engine with validation
  let startup;
  try {
    startup = await startupEngine(config.projectRoot);
  } catch (e) {
    console.error(`MAAD MCP: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  const { engine } = startup;

  // Set guardrail config
  setGuardrailConfig({ dryRun: config.dryRun, toolAllowlist: config.toolAllowlist });
  setProvenanceMode(config.provenance);

  // Create MCP server
  const server = new McpServer({
    name: 'maad',
    version: pkg.version,
  });

  // Register tools by role tier
  let toolCount = 0;

  discoverTools.register(server, engine, config.projectRoot);
  readTools.register(server, engine);
  auditTools.register(server, engine);
  toolCount = 12;

  if (config.role === 'writer' || config.role === 'admin') {
    writeTools.register(server, engine);
    toolCount = 17;
  }

  if (config.role === 'admin') {
    maintainTools.register(server, engine);
    toolCount = 21;
  }

  logger.info('mcp', 'startup', `${toolCount} tools registered for role '${config.role}'${config.dryRun ? ' (dry-run)' : ''}`);

  // Shutdown hooks
  registerShutdownHooks(engine, () => server.close());

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('mcp', 'startup', 'Server started on stdio');
}
