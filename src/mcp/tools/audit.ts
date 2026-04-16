// ============================================================================
// Audit tools — maad_history, maad_audit
// ============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { docId, docType } from '../../types.js';
import { resultToResponse } from '../response.js';
import type { InstanceCtx } from '../ctx.js';
import { withEngine } from '../with-session.js';

export function register(server: McpServer, ctx: InstanceCtx): number {
  server.registerTool('maad_history', {
    description: 'Returns git commit history for a specific document.',
    inputSchema: z.object({
      docId: z.string().describe('Document ID'),
      limit: z.number().optional().describe('Max commits to return'),
      since: z.string().optional().describe('Only commits since this date (ISO or git date format)'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_history', args, async ({ engine }) => {
    const opts: { limit?: number; since?: string } = {};
    if (args.limit !== undefined) opts.limit = args.limit;
    if (args.since !== undefined) opts.since = args.since;
    return resultToResponse(await engine.history(docId(args.docId), opts));
  }));

  server.registerTool('maad_audit', {
    description: 'Returns project-wide activity log from git. Shows most recent action per document.',
    inputSchema: z.object({
      since: z.string().optional().describe('Activity since date'),
      until: z.string().optional().describe('Activity until date'),
      docType: z.string().optional().describe('Filter by document type'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_audit', args, async ({ engine }) => {
    const opts: { since?: string; until?: string; docType?: import('../../types.js').DocType } = {};
    if (args.since !== undefined) opts.since = args.since;
    if (args.until !== undefined) opts.until = args.until;
    if (args.docType !== undefined) opts.docType = docType(args.docType);
    return resultToResponse(await engine.audit(opts));
  }));

  return 2;
}
