// ============================================================================
// Maintain tools — maad_delete, maad_reindex, maad_reload, maad_health
// ============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MaadEngine } from '../../engine.js';
import { docId } from '../../types.js';
import { resultToResponse, successResponse, getProvenanceMode } from '../response.js';
import { isDryRun, dryRunResponse, auditToolCall } from '../guardrails.js';

export function register(server: McpServer, engine: MaadEngine): void {
  server.registerTool('maad_delete', {
    description: 'Deletes a record. Soft: renames file with _deleted prefix. Hard: removes file entirely.',
    inputSchema: z.object({
      docId: z.string().describe('Document ID to delete'),
      mode: z.enum(['soft', 'hard']).default('soft').describe('soft=rename, hard=remove file'),
    }),
  }, async (args) => {
    auditToolCall('maad_delete', args);
    if (isDryRun()) return dryRunResponse('maad_delete', args);
    return resultToResponse(await engine.deleteDocument(docId(args.docId), args.mode));
  });

  server.registerTool('maad_reindex', {
    description: 'Rebuilds the SQLite index from markdown files. Use after external file changes or to recover from stale state.',
    inputSchema: z.object({
      force: z.boolean().optional().default(false).describe('Force full rebuild (skip hash check)'),
    }),
  }, async (args) => {
    return resultToResponse(await engine.reindex({ force: args.force }));
  });

  server.registerTool('maad_reload', {
    description: 'Reloads the engine — picks up new registry, schemas, and type directories without restarting the server. Use after changing _registry/ or _schema/ files.',
    inputSchema: z.object({}),
  }, async () => {
    auditToolCall('maad_reload', {});
    return resultToResponse(await engine.reload());
  });

  server.registerTool('maad_health', {
    description: 'Returns engine health status: initialized, read-only mode, git availability, document count, last indexed timestamp, provenance mode, recovery actions.',
    inputSchema: z.object({}),
  }, () => {
    const health = engine.health();
    const provMode = getProvenanceMode();
    return successResponse({ ...health, provenance: provMode }, 'maad_health');
  });
}
