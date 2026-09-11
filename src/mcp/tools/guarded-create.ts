import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InstanceCtx } from '../ctx.js';
import { deliveryInput, deliverComplete } from '../complete-delivery.js';
import { withEngine } from '../with-session.js';
import { createContractRequestSchema, guardedCreateRequestSchema } from '../../engine/guarded-create.js';
import type { GuardedCreateRequest } from '../../engine/guarded-create-types.js';
import { resultToResponse, errorResponse, attachWarnings, attachDurability } from '../response.js';
import { maadError } from '../../errors.js';
import { isDryRun, dryRunResponse, auditToolCall } from '../guardrails.js';
import { getRateLimiter } from '../rate-limit.js';
import { logWriteAudit, logValidationWarning } from '../../logging.js';
import { notifyWrite } from '../notifications.js';

export const createContractInput = createContractRequestSchema.extend({ project: z.string().optional(), delivery: deliveryInput.optional() }).strict();
export const guardedCreateInput = guardedCreateRequestSchema.extend({ project: z.string().optional() }).strict();

export function registerContract(server: McpServer, ctx: InstanceCtx): number {
  server.registerTool('maad_create_contract', {
    description: 'Read a complete versioned schema contract and effective history mode from an already-bound ready project. Optional compact-json-v1 delivery returns lossless, digest-bound pages; verify all pages before accepting a contract.',
    inputSchema: createContractInput,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async (args, extra) => withEngine(ctx, extra, 'maad_create_contract', args, async call => {
    const result = await call.engine.createContract({ contract: args.contract, docType: args.docType }, {
      ...(call.signal ? { signal: call.signal } : {}),
      ...(call.validateAccess ? { validateAccess: call.validateAccess } : {}),
    });
    if (!result.ok || !args.delivery) return resultToResponse(result, 'maad_create_contract');
    return deliverComplete(result.value, args.delivery, { ...call, tool: 'maad_create_contract',
      request: { contract: args.contract, docType: args.docType, project: call.projectName } });
  }));
  return 1;
}

export function registerWrite(server: McpServer, ctx: InstanceCtx): number {
  server.registerTool('maad_create_guarded', {
    description: 'Create exact expected content only if the complete schema, history policy and current write access match. After uncertain outcomes reconcile by document receipt; never automatically replay.',
    inputSchema: guardedCreateInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async (args, extra) => withEngine(ctx, extra, 'maad_create_guarded', args, async call => {
    const denied = call.validateAccess?.();
    if (denied) return errorResponse([denied]);
    const limit = getRateLimiter().tryAcquireWrite(call.sessionId);
    if (limit) return errorResponse([maadError('RATE_LIMITED', 'Write rate limit exceeded', undefined, { ...limit })]);
    auditToolCall('maad_create_guarded', args);
    if (isDryRun()) return dryRunResponse('maad_create_guarded', args);
    const { project: _project, ...request } = args;
    const result = await call.engine.createGuarded(request as GuardedCreateRequest, {
      ...(call.signal ? { signal: call.signal } : {}),
      ...(call.validateAccess ? { validateAccess: call.validateAccess } : {}),
    });
    const response = resultToResponse(result, 'maad_create_guarded');
    if (!result.ok) return response;
    const value = result.value;
    logWriteAudit({ request_id: call.requestId, session_id: call.sessionId, project: call.projectName,
      tool: 'maad_create_guarded', doc_id: args.docId, doc_type: args.docType, version_before: null,
      version_after: value.version, changed_fields: [], git_commit: null, role: call.role,
      ...(call.token ? { token_id: call.token.id,
        ...(call.token.agentId ? { agent_id: call.token.agentId } : {}),
        ...(call.token.userId ? { user_id: call.token.userId } : {}) } : {}),
    });
    for (const warning of value.validation.warnings ?? []) logValidationWarning({
      request_id: call.requestId, session_id: call.sessionId, project: call.projectName,
      tool: 'maad_create_guarded', doc_id: args.docId, doc_type: args.docType, ...warning,
    });
    if (value.writeDurable) await notifyWrite(ctx, { action: 'create', docId: args.docId,
      docType: args.docType, project: call.projectName, updatedAt: new Date().toISOString() });
    return attachDurability(attachWarnings(response, value.validation.warnings), value.writeDurable, value.commitFailure);
  }));
  return 1;
}
