// ============================================================================
// MCP Server — lifecycle, role-based tool registration, stdio transport
// ============================================================================

import path from 'node:path';
import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MaadEngine } from '../engine.js';
import { parseRole } from './roles.js';
import { setGuardrailConfig } from './guardrails.js';
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
}

export async function startServer(opts: ServeOptions): Promise<void> {
  const projectRoot = path.resolve(opts.projectRoot);
  const role = parseRole(opts.role);

  // Validate project exists
  if (!existsSync(projectRoot)) {
    console.error(`MAAD MCP: Project directory not found: ${projectRoot}`);
    process.exit(1);
  }

  const registryPath = path.join(projectRoot, '_registry', 'object_types.yaml');
  if (!existsSync(registryPath)) {
    console.error(`MAAD MCP: No _registry/object_types.yaml found in ${projectRoot}`);
    process.exit(1);
  }

  // Init engine
  const engine = new MaadEngine();
  const initResult = await engine.init(projectRoot);
  if (!initResult.ok) {
    console.error('MAAD MCP: Engine initialization failed:');
    for (const e of initResult.errors) console.error(`  ${e.code}: ${e.message}`);
    process.exit(1);
  }

  // Set guardrail config
  setGuardrailConfig({ dryRun: opts.dryRun, toolAllowlist: opts.toolAllowlist });

  console.error(`MAAD MCP: Engine initialized for ${projectRoot} (role: ${role}${opts.dryRun ? ', dry-run' : ''})`);

  // Create MCP server
  const server = new McpServer({
    name: 'maad',
    version: '0.2.0',
  });

  // Register tools by role tier
  // reader: discover + read + audit (10 tools)
  // writer: + write (13 tools)
  // admin:  + maintain (15 tools)
  let toolCount = 0;

  // Reader tier — always registered
  discoverTools.register(server, engine, projectRoot);
  readTools.register(server, engine);
  auditTools.register(server, engine);
  toolCount = 10;

  // Writer tier
  if (role === 'writer' || role === 'admin') {
    writeTools.register(server, engine);
    toolCount = 13;
  }

  // Admin tier
  if (role === 'admin') {
    maintainTools.register(server, engine);
    toolCount = 15;
  }

  console.error(`MAAD MCP: ${toolCount} tools registered for role '${role}'`);

  // Shutdown hooks
  const shutdown = async () => {
    console.error('MAAD MCP: Shutting down...');
    engine.close();
    await server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MAAD MCP: Server started on stdio');
}
