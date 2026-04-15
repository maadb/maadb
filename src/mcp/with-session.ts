// ============================================================================
// withEngine — the routing helper every project-level tool wraps around.
//
// Resolves the correct engine for the current MCP call:
//   1. Pull/create the session from the request's sessionId.
//   2. In legacy (synthetic) mode, auto-bind to the single project on first
//      call so existing 0.2.x clients work unchanged.
//   3. In real instance mode, require the client to have already bound via
//      maad_use_project(s).
//   4. Pick the project (activeProject in single mode, args.project in multi).
//   5. Gate by tool's minimum role vs the session's effective role.
//   6. Load/cache the engine via EnginePool.
//   7. Hand engine + project meta to the inner handler.
// ============================================================================

import type { MaadEngine } from '../engine.js';
import type { MaadError } from '../errors.js';
import type { InstanceCtx } from './ctx.js';
import type { SessionState } from '../instance/session.js';
import { resolveSessionId } from '../instance/session.js';
import { getMinRoleForTool, roleSatisfies } from './roles.js';
import { errorResponse } from './response.js';
import { getRateLimiter } from './rate-limit.js';

interface CallContext {
  engine: MaadEngine;
  projectName: string;
  projectRoot: string;
  sessionId: string;
}

type McpToolResponse = { content: Array<{ type: 'text'; text: string }> };

// Wrap a tool handler so it runs against the engine chosen by the current
// session. Call this inside every project-level tool registration.
export async function withEngine(
  ctx: InstanceCtx,
  extra: unknown,
  toolName: string,
  args: Record<string, unknown> | undefined,
  handler: (call: CallContext) => Promise<McpToolResponse> | McpToolResponse
): Promise<McpToolResponse> {
  const sessionId = resolveSessionId(extra);
  let state = ctx.sessions.get(sessionId);
  if (!state) state = ctx.sessions.create(sessionId);

  // Legacy single-project instance: auto-bind to 'default' on first call.
  if (state.mode === null && ctx.instance.source === 'synthetic') {
    const bindResult = ctx.sessions.bindSingle(sessionId, 'default');
    if (!bindResult.ok) return errorResponse(bindResult.errors);
    state = bindResult.value;
  }

  if (state.mode === null) {
    return mcpError('SESSION_UNBOUND',
      'No project bound for this session. Call maad_use_project(s) first.');
  }

  // Pick project
  const projectName = resolveProjectName(state, args);
  if (typeof projectName !== 'string') return projectName; // error response

  // Role check
  const effectiveRole = state.effectiveRoles.get(projectName);
  if (!effectiveRole) {
    return mcpError('PROJECT_NOT_WHITELISTED',
      `Session is not bound to project "${projectName}".`);
  }
  const minRole = getMinRoleForTool(toolName);
  if (minRole && !roleSatisfies(effectiveRole, minRole)) {
    return mcpError('INSUFFICIENT_ROLE',
      `Tool ${toolName} requires role "${minRole}" but session has "${effectiveRole}" for project "${projectName}".`);
  }

  // Payload size cap. Oversize args are rejected without touching the engine.
  const rl = getRateLimiter();
  const payloadBytes = args ? Buffer.byteLength(JSON.stringify(args), 'utf8') : 0;
  const payloadRejection = rl.checkPayloadSize(payloadBytes);
  if (payloadRejection) {
    return mcpErrorWithDetails('RATE_LIMITED', 'Payload exceeds limit', {
      reason: payloadRejection.reason,
      limit: payloadRejection.limit,
      retryAfterMs: payloadRejection.retryAfterMs,
      size: payloadBytes,
    });
  }

  // Concurrent-in-flight cap. Released in the `finally` below so an engine
  // error never leaks a slot.
  const slot = rl.tryAcquireConcurrent(sessionId);
  if (!slot.ok) {
    return mcpErrorWithDetails('RATE_LIMITED', 'Concurrent in-flight limit reached', {
      reason: slot.rejection.reason,
      limit: slot.rejection.limit,
      retryAfterMs: slot.rejection.retryAfterMs,
    });
  }

  try {
    // Resolve engine
    const poolResult = await ctx.pool.get(projectName);
    if (!poolResult.ok) return errorResponse(poolResult.errors);

    const project = ctx.instance.projects.find((p) => p.name === projectName)!;
    return await handler({
      engine: poolResult.value,
      projectName,
      projectRoot: project.path,
      sessionId,
    });
  } finally {
    slot.release();
  }
}

function resolveProjectName(state: SessionState, args: Record<string, unknown> | undefined): string | McpToolResponse {
  if (state.mode === 'single') {
    return state.activeProject!;
  }
  // multi mode
  const raw = args && typeof args.project === 'string' ? args.project : undefined;
  if (!raw) {
    return mcpError('PROJECT_REQUIRED',
      'Multi-project session requires `project=<name>` on every call.');
  }
  if (!state.whitelist!.includes(raw)) {
    return mcpError('PROJECT_NOT_WHITELISTED',
      `Project "${raw}" is not in this session's whitelist: [${state.whitelist!.join(', ')}]`);
  }
  return raw;
}

function mcpError(code: string, message: string): McpToolResponse {
  const err: MaadError = { code: code as MaadError['code'], message };
  return errorResponse([err]);
}

function mcpErrorWithDetails(code: string, message: string, details: Record<string, unknown>): McpToolResponse {
  const err: MaadError = { code: code as MaadError['code'], message, details };
  return errorResponse([err]);
}
