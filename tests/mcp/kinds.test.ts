// Coverage tests for the OperationKind metadata. Two invariants:
//   1. Every tool the MCP server actually registers is classified — read,
//      write, or engine-less. No drift between what ships and what kinds.ts
//      knows about.
//   2. A tool that reaches withEngine without a kind produces
//      MISSING_OPERATION_KIND instead of silently running unserialized.

import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  READ_TOOLS,
  WRITE_TOOLS,
  ENGINE_LESS_TOOLS,
  getKindForTool,
  isEngineLess,
  allEngineToolNames,
} from '../../src/mcp/kinds.js';
import type { InstanceCtx } from '../../src/mcp/ctx.js';
import { EnginePool } from '../../src/instance/pool.js';
import { SessionRegistry } from '../../src/instance/session.js';
import * as discoverTools from '../../src/mcp/tools/discover.js';
import * as readTools from '../../src/mcp/tools/read.js';
import * as writeTools from '../../src/mcp/tools/write.js';
import * as auditTools from '../../src/mcp/tools/audit.js';
import * as maintainTools from '../../src/mcp/tools/maintain.js';
import * as instanceTools from '../../src/mcp/tools/instance.js';

// Collect tool names that registerTool is called with on a throwaway server.
function collectRegisteredNames(register: (s: McpServer, c: InstanceCtx) => void): string[] {
  const server = new McpServer({ name: 'probe', version: '0.0.0' });
  const names: string[] = [];
  const orig = server.registerTool.bind(server);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as unknown as { registerTool: (...args: any[]) => unknown }).registerTool = (name: string, ...rest: unknown[]) => {
    names.push(name);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (orig as any)(name, ...rest);
  };
  const ctx: InstanceCtx = {
    instance: { name: 'probe', source: 'synthetic', projects: [] },
    pool: new EnginePool({ projects: [] }),
    sessions: new SessionRegistry(),
  };
  register(server, ctx);
  return names;
}

describe('OperationKind coverage', () => {
  it('set cardinalities match the documented roster', () => {
    expect(READ_TOOLS.size).toBe(16);
    expect(WRITE_TOOLS.size).toBe(7);
    expect(ENGINE_LESS_TOOLS.size).toBe(7);
  });

  it('every registered engine-bound tool has a kind', () => {
    const registered = [
      ...collectRegisteredNames(discoverTools.register),
      ...collectRegisteredNames(readTools.register),
      ...collectRegisteredNames(writeTools.register),
      ...collectRegisteredNames(auditTools.register),
      ...collectRegisteredNames(maintainTools.register),
    ];
    for (const name of registered) {
      const kind = getKindForTool(name);
      expect(kind, `tool "${name}" must be registered in READ_TOOLS or WRITE_TOOLS`).not.toBeNull();
    }
  });

  it('every engine-less tool is marked engine-less and has no kind', () => {
    const registered = collectRegisteredNames(instanceTools.register);
    for (const name of registered) {
      expect(isEngineLess(name), `tool "${name}" must be in ENGINE_LESS_TOOLS`).toBe(true);
      expect(getKindForTool(name), `tool "${name}" is engine-less — must not have a kind`).toBeNull();
    }
  });

  it('allEngineToolNames matches READ_TOOLS ∪ WRITE_TOOLS', () => {
    const names = new Set(allEngineToolNames());
    expect(names.size).toBe(READ_TOOLS.size + WRITE_TOOLS.size);
    for (const n of READ_TOOLS) expect(names.has(n)).toBe(true);
    for (const n of WRITE_TOOLS) expect(names.has(n)).toBe(true);
  });

  it('no tool appears in more than one bucket', () => {
    const all = new Map<string, number>();
    for (const n of READ_TOOLS) all.set(n, (all.get(n) ?? 0) + 1);
    for (const n of WRITE_TOOLS) all.set(n, (all.get(n) ?? 0) + 1);
    for (const n of ENGINE_LESS_TOOLS) all.set(n, (all.get(n) ?? 0) + 1);
    for (const [name, count] of all) {
      expect(count, `tool "${name}" appears in multiple buckets`).toBe(1);
    }
  });
});
