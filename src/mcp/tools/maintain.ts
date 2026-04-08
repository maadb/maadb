// ============================================================================
// Maintain tools — maad.delete, maad.reindex
// ============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MaadEngine } from '../../engine.js';
import { docId } from '../../types.js';
import { resultToResponse } from '../response.js';
import { isDryRun, dryRunResponse, auditToolCall } from '../guardrails.js';

export function register(server: McpServer, engine: MaadEngine): void {
  server.registerTool('maad.delete', {
    description: 'Deletes a record. Soft: renames file with _deleted prefix. Hard: removes file entirely.',
    inputSchema: z.object({
      docId: z.string().describe('Document ID to delete'),
      mode: z.enum(['soft', 'hard']).default('soft').describe('soft=rename, hard=remove file'),
    }),
  }, async (args) => {
    auditToolCall('maad.delete', args);
    if (isDryRun()) return dryRunResponse('maad.delete', args);
    return resultToResponse(await engine.deleteDocument(docId(args.docId), args.mode));
  });

  server.registerTool('maad.reindex', {
    description: 'Rebuilds the SQLite index from markdown files. Use after external file changes or to recover from stale state.',
    inputSchema: z.object({
      force: z.boolean().optional().default(false).describe('Force full rebuild (skip hash check)'),
    }),
  }, async (args) => {
    return resultToResponse(await engine.reindex({ force: args.force }));
  });
}
