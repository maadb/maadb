// Every MCP tool carries a title and explicit read-only / destructive hints,
// taken from src/mcp/annotations.ts, and the hints agree with kinds.ts.

import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TOOL_ANNOTATIONS, annotateRegistrations } from '../../src/mcp/annotations.js';
import { READ_TOOLS, WRITE_TOOLS, ENGINE_LESS_TOOLS } from '../../src/mcp/kinds.js';
import type { InstanceCtx } from '../../src/mcp/ctx.js';
import { EnginePool } from '../../src/instance/pool.js';
import { SessionRegistry } from '../../src/instance/session.js';
import * as discoverTools from '../../src/mcp/tools/discover.js';
import * as readTools from '../../src/mcp/tools/read.js';
import * as guardedCreateTools from '../../src/mcp/tools/guarded-create.js';
import * as documentReceiptTools from '../../src/mcp/tools/document-receipt.js';
import * as writeTools from '../../src/mcp/tools/write.js';
import * as auditTools from '../../src/mcp/tools/audit.js';
import * as maintainTools from '../../src/mcp/tools/maintain.js';
import * as backupTools from '../../src/mcp/tools/backup.js';
import * as historyModeTools from '../../src/mcp/tools/history-mode.js';
import * as cleanupTools from '../../src/mcp/tools/cleanup.js';
import * as instanceTools from '../../src/mcp/tools/instance.js';
import * as authTools from '../../src/mcp/tools/auth.js';

type Register = (s: McpServer, c: InstanceCtx) => unknown;

const REGISTERS: Register[] = [
  instanceTools.register,
  instanceTools.registerReload,
  discoverTools.register,
  readTools.register,
  documentReceiptTools.register,
  guardedCreateTools.registerContract,
  guardedCreateTools.registerWrite,
  writeTools.register,
  auditTools.register,
  maintainTools.register,
  backupTools.register,
  historyModeTools.register,
  cleanupTools.register,
  authTools.register,
];

function probeCtx(): InstanceCtx {
  return {
    instance: { name: 'probe', source: 'synthetic', projects: [] },
    pool: new EnginePool({ projects: [] }),
    sessions: new SessionRegistry(),
  } as unknown as InstanceCtx;
}

function buildFullServer(): McpServer {
  const server = annotateRegistrations(new McpServer({ name: 'probe', version: '0.0.0' }));
  const ctx = probeCtx();
  for (const register of REGISTERS) register(server, ctx);
  return server;
}

async function listTools() {
  const server = buildFullServer();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'probe-client', version: '0.0.0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

describe('tool annotations', () => {
  it('the table lists exactly the tools the server registers', async () => {
    const tools = await listTools();
    const registered = tools.map(t => t.name).sort();
    expect(registered).toEqual(Object.keys(TOOL_ANNOTATIONS).sort());
  });

  it('the table covers every tool kinds.ts knows about', () => {
    const known = [...READ_TOOLS, ...WRITE_TOOLS, ...ENGINE_LESS_TOOLS].sort();
    expect(Object.keys(TOOL_ANNOTATIONS).sort()).toEqual(known);
  });

  it('every listed tool has a title and explicit hints', async () => {
    const tools = await listTools();
    for (const tool of tools) {
      const a = tool.annotations;
      expect(a, tool.name).toBeDefined();
      expect(typeof a?.title, `${tool.name} title`).toBe('string');
      expect(tool.title, `${tool.name} top-level title`).toBe(a?.title);
      expect(typeof a?.readOnlyHint, `${tool.name} readOnlyHint`).toBe('boolean');
      expect(typeof a?.destructiveHint, `${tool.name} destructiveHint`).toBe('boolean');
      expect(typeof a?.idempotentHint, `${tool.name} idempotentHint`).toBe('boolean');
      expect(a?.openWorldHint, `${tool.name} openWorldHint`).toBe(false);
      // A tool is never both read-only and destructive.
      expect(a?.readOnlyHint && a?.destructiveHint, tool.name).toBe(false);
      expect(tool.name.length).toBeLessThanOrEqual(64);
    }
  });

  it('engine read tools are read-only and engine write tools are not', () => {
    for (const name of READ_TOOLS) expect(TOOL_ANNOTATIONS[name]?.readOnlyHint, name).toBe(true);
    for (const name of WRITE_TOOLS) expect(TOOL_ANNOTATIONS[name]?.readOnlyHint, name).toBe(false);
  });

  it('tools that remove, overwrite or revoke are destructive', () => {
    for (const name of [
      'maad_update', 'maad_bulk_update', 'maad_delete', 'maad_bulk_delete',
      'maad_delete_where', 'maad_purge_soft_deleted', 'maad_repair_where',
      'maad_backup', 'maad_instructions', 'maad_revoke_token', 'maad_rotate_token',
    ]) {
      expect(TOOL_ANNOTATIONS[name]?.destructiveHint, name).toBe(true);
    }
  });

  it('refuses to register a tool the table does not list', () => {
    const server = annotateRegistrations(new McpServer({ name: 'probe', version: '0.0.0' }));
    expect(() => server.registerTool('maad_not_a_tool', { description: 'x' }, async () => ({ content: [] })))
      .toThrow(/MISSING_TOOL_ANNOTATIONS/);
  });
});
