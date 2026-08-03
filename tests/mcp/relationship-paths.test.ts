import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EnginePool } from '../../src/instance/pool.js';
import { SessionRegistry } from '../../src/instance/session.js';
import type { InstanceCtx } from '../../src/mcp/ctx.js';
import type { MaadEngine } from '../../src/engine.js';
import * as readTools from '../../src/mcp/tools/read.js';

type ToolResponse = { content: Array<{ type: string; text: string }> };
type ToolHandler = (
  args: Record<string, unknown>,
  extra: unknown,
) => Promise<ToolResponse>;

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

  it('applies the response-byte guard to an oversized success response', async () => {
    const server = new McpServer({ name: 'probe', version: '0.0.0' });
    let handler: ToolHandler | undefined;
    (server as unknown as {
      registerTool: (name: string, toolConfig: unknown, toolHandler: ToolHandler) => unknown;
    }).registerTool = (name, _toolConfig, toolHandler) => {
      if (name === 'maad_relationship_paths') handler = toolHandler;
      return undefined;
    };

    const instance = {
      name: 'probe',
      source: 'synthetic' as const,
      projects: [{ name: 'default', path: process.cwd(), role: 'reader' as const }],
    };
    const engine = {
      relationshipPaths: () => ({
        ok: true as const,
        value: { oversizedEvidence: 'x'.repeat(1_024) },
      }),
    } as unknown as MaadEngine;
    const pool = {
      get: async () => ({ ok: true as const, value: engine }),
      isEmptyIndexRecoveryEngine: () => false,
      acquire: () => undefined,
      release: () => undefined,
    } as unknown as EnginePool;
    const ctx: InstanceCtx = {
      instance,
      pool,
      sessions: new SessionRegistry(instance),
    };
    readTools.register(server, ctx);
    expect(handler).toBeDefined();

    const originalCap = process.env['MAAD_RESPONSE_MAX_BYTES'];
    process.env['MAAD_RESPONSE_MAX_BYTES'] = '256';
    try {
      const response = await handler!(
        { startDocId: 'doc-a', direction: 'both' },
        { sessionId: 'relationship-paths-size-guard' },
      );
      const body = JSON.parse(response.content[0]!.text) as {
        ok: boolean;
        errors: Array<{
          code: string;
          details: { capBytes: number; projectedBytes: number; tool: string; hint: string };
        }>;
      };

      expect(body.ok).toBe(false);
      expect(body.errors[0]?.code).toBe('RESPONSE_TOO_LARGE');
      expect(body.errors[0]?.details).toMatchObject({
        capBytes: 256,
        tool: 'maad_relationship_paths',
        hint: 'Reduce depth, node, edge, or path limits; or add field and extraction-kind filters',
      });
      expect(body.errors[0]?.details.projectedBytes).toBeGreaterThan(256);
    } finally {
      if (originalCap === undefined) delete process.env['MAAD_RESPONSE_MAX_BYTES'];
      else process.env['MAAD_RESPONSE_MAX_BYTES'] = originalCap;
    }
  });
});
