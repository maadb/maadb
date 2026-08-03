import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EnginePool } from '../../src/instance/pool.js';
import { SessionRegistry } from '../../src/instance/session.js';
import type { InstanceCtx } from '../../src/mcp/ctx.js';
import * as readTools from '../../src/mcp/tools/read.js';

describe('maad_relationship_paths registration', () => {
  it('is a reader tool with default direction and schema-enforced hard caps', () => {
    const server = new McpServer({ name: 'probe', version: '0.0.0' });
    let config: unknown;
    (server as unknown as {
      registerTool: (name: string, toolConfig: unknown, handler: unknown) => unknown;
    }).registerTool = (name, toolConfig) => {
      if (name === 'maad_relationship_paths') config = toolConfig;
      return undefined;
    };
    const ctx: InstanceCtx = {
      instance: { name: 'probe', source: 'synthetic', projects: [] },
      pool: new EnginePool({ projects: [] }),
      sessions: new SessionRegistry(),
    };

    expect(readTools.register(server, ctx)).toBe(12);
    expect(config).toBeDefined();
    const schema = (config as { inputSchema: { parse: (value: unknown) => Record<string, unknown> } }).inputSchema;
    expect(schema.parse({ startDocId: 'doc-a' })).toMatchObject({
      startDocId: 'doc-a',
      direction: 'outgoing',
    });
    expect(() => schema.parse({ startDocId: 'doc-a', maxDepth: 5 })).toThrow();
    expect(() => schema.parse({ startDocId: 'doc-a', maxNodes: 101 })).toThrow();
    expect(() => schema.parse({ startDocId: 'doc-a', maxEdges: 201 })).toThrow();
    expect(() => schema.parse({ startDocId: 'doc-a', maxPaths: 51 })).toThrow();
  });
});
