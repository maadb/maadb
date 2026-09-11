import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InstanceCtx } from '../ctx.js';
import { deliveryInput, deliverComplete } from '../complete-delivery.js';
import { withEngine } from '../with-session.js';
import { resultToResponse } from '../response.js';

export const documentReceiptInput = z.object({
  contract: z.literal('document-persistence-v1'),
  project: z.string().optional(),
  delivery: deliveryInput.optional(),
  docType: z.string().min(1).max(256),
  docId: z.string().min(1).max(256),
  expectedContentDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();

export function register(server: McpServer, ctx: InstanceCtx): number {
  server.registerTool('maad_document_receipt', {
    description: 'Read exact immutable committed document evidence from an already-bound, ready project. Does not prove operation completion or power-loss durability; no result authorizes create replay. Optional compact-json-v1 delivery returns bounded complete-evidence pages.',
    inputSchema: documentReceiptInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async (args, extra) => withEngine(ctx, extra, 'maad_document_receipt', args,
    async call => {
      const { delivery, project: _project, ...request } = args;
      const result = await call.engine.documentReceipt(request, call.projectName, call.signal);
      if (!result.ok || !delivery) return resultToResponse(result, 'maad_document_receipt');
      return deliverComplete(result.value, delivery, { ...call, tool: 'maad_document_receipt',
        request: { ...request, project: call.projectName } });
    }));
  return 1;
}
