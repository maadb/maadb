import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InstanceCtx } from '../ctx.js';
import { withEngine } from '../with-session.js';
import { resultToResponse } from '../response.js';

export const documentReceiptInput = z.object({
  contract: z.literal('document-persistence-v1'),
  project: z.string().optional(),
  docType: z.string().min(1).max(256),
  docId: z.string().min(1).max(256),
  expectedContentDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();

export function register(server: McpServer, ctx: InstanceCtx): number {
  server.registerTool('maad_document_receipt', {
    description: 'Read exact immutable committed document evidence from an already-bound, ready project. Does not prove operation completion or power-loss durability; no result authorizes create replay.',
    inputSchema: documentReceiptInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async (args, extra) => withEngine(ctx, extra, 'maad_document_receipt', args,
    async ({ engine, projectName, signal }) => resultToResponse(
      await engine.documentReceipt(args, projectName, signal), 'maad_document_receipt')));
  return 1;
}
