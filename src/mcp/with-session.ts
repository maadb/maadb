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

import { randomUUID } from 'node:crypto';
import type { MaadEngine } from '../engine.js';
import type { MaadError } from '../errors.js';
import type { InstanceCtx } from './ctx.js';
import type { SessionState } from '../instance/session.js';
import { resolveSessionId } from '../instance/session.js';
import { getMinRoleForTool, roleSatisfies } from './roles.js';
import { errorResponse, attachMeta } from './response.js';
import { getRateLimiter } from './rate-limit.js';
import { logToolCall, getOpsLog } from '../logging.js';
import { isShuttingDown } from './shutdown.js';
import { getKindForTool, isEngineLess } from './kinds.js';
import { getHeavyOpGuard, heavyOpKey } from './heavy-ops.js';
import { isCommitIdentityEnabled, type CommitIdentity } from '../git/commit.js';
import { composeEffectiveRole } from '../auth/resolve.js';
import { responseMaxBytes, contractResponseMaxBytes, responseBytes } from './response.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function getRequestTimeoutMs(): number {
  const env = process.env.MAAD_REQUEST_TIMEOUT_MS;
  if (env && !Number.isNaN(Number(env))) return Number(env);
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

interface CallContext {
  signal?: AbortSignal;
  validateAccess?: () => MaadError | null;
  engine: MaadEngine;
  projectName: string;
  projectRoot: string;
  sessionId: string;
  requestId: string;
  /**
   * 0.7.0 — Identity snapshot for audit + commit propagation. `role` is the
   * effective role resolved for this (session × project). `token` is
   * populated when the session was authenticated via the HTTP+registry path;
   * undefined for stdio / synthetic mode.
   */
  role: string;
  token?: import('../auth/types.js').TokenRecord;
}

type McpToolResponse = { content: Array<{ type: 'text'; text: string }> };

// Wrap a tool handler so it runs against the engine chosen by the current
// session. Call this inside every project-level tool registration.
//
// Every call gets a fresh request_id (UUID). It is:
//   - stamped onto the response as _meta.request_id
//   - emitted on the ops log in the trailing tool_call line
//   - passed into the handler (so audit logs and idempotency can reference it)
//
// The function has several early-return points (session errors, role, payload,
// concurrent). All of them flow through `finalize()` so every response — success
// or rejection — is logged uniformly.
export async function withEngine(
  ctx: InstanceCtx,
  extra: unknown,
  toolName: string,
  args: Record<string, unknown> | undefined,
  handler: (call: CallContext) => Promise<McpToolResponse> | McpToolResponse
): Promise<McpToolResponse> {
  const guarded = toolName === 'maad_create_guarded';
  const strictReady = guarded || toolName === 'maad_create_contract' || toolName === 'maad_document_receipt';
  const requestId = randomUUID();
  const startedMs = Date.now();
  const sessionId = resolveSessionId(extra);
  const payloadBytes = args ? Buffer.byteLength(JSON.stringify(args), 'utf8') : 0;

  let projectForLog: string | null = null;
  let roleForLog: string | null = null;

  // finalize() is called once per request, on the single return path. It
  // attaches _meta.request_id (opt-in via MAAD_EMIT_REQUEST_ID=true since
  // 0.7.0), inspects the response body for logging, and emits the tool_call
  // ops line. The log line always carries request_id regardless of stamping
  // — emission only affects the wire response, not diagnostics.
  const emitRequestId = process.env.MAAD_EMIT_REQUEST_ID === 'true';
  const finalize = (response: McpToolResponse): McpToolResponse => {
    let stamped = emitRequestId ? attachMeta(response, { request_id: requestId }) : response;
    const cap = strictReady ? contractResponseMaxBytes() : responseMaxBytes();
    const bytes = responseBytes(stamped);
    // Final metadata and escaping are part of every engine-bound result budget.
    // Never replace an existing failure, or suggest replay after publication.
    if (inspectResponse(stamped).result === 'ok' && bytes > cap) {
      const write = getKindForTool(toolName) === 'write';
      stamped = mcpErrorWithDetails('RESPONSE_TOO_LARGE', 'Complete MCP result exceeds response cap', {
        tool: toolName, observedBytes: bytes, capBytes: cap, accounting: 'mcp-result-utf8',
        writeOutcome: write ? 'unknown_reconcile' : 'read_only',
        hint: write ? 'A write may have occurred. Reconcile by document receipt; never automatically replay.'
          : strictReady ? 'Retry this read with delivery.format=compact-json-v1 and a bounded maxBytes; collect and verify all pages.'
          : 'Narrow field projection, add filters, or paginate with cursor',
      });
      if (emitRequestId) stamped = attachMeta(stamped, { request_id: requestId });
    }
    const latencyMs = Date.now() - startedMs;
    const { result, errorCode } = inspectResponse(stamped);
    logToolCall({
      request_id: requestId,
      session_id: sessionId,
      project: projectForLog,
      tool: toolName,
      role: roleForLog,
      payload_size: payloadBytes,
      latency_ms: latencyMs,
      result,
      error_code: errorCode,
    });
    return stamped;
  };


  // Reject new work during shutdown before any other check.
  if (isShuttingDown()) {
    return finalize(mcpError('SHUTTING_DOWN',
      'Server is shutting down; retry against a healthy instance.'));
  }

  let state = ctx.sessions.get(sessionId);
  if (strictReady && !state) return finalize(mcpError('SESSION_UNBOUND', 'Receipt requires an already-bound session'));
  if (!state) state = ctx.sessions.create(sessionId);

  // Session cancelled by instance-reload (its bound project was removed, or
  // its multi-mode whitelist drained to empty). Emit the error once, then
  // destroy so the client reconnects cleanly.
  if (state.cancelled) {
    const boundProject = state.activeProject ?? state.whitelist?.[0] ?? 'unknown';
    ctx.sessions.destroy(sessionId, 'transport');
    return finalize(mcpError('SESSION_CANCELLED',
      `Session was cancelled because its bound project "${boundProject}" was removed by an instance reload. Reconnect to continue.`));
  }

  // Legacy single-project instance: auto-bind to 'default' on first call.
  if (!strictReady && state.mode === null && ctx.instance.source === 'synthetic') {
    const bindResult = ctx.sessions.bindSingle(sessionId, 'default');
    if (!bindResult.ok) return finalize(errorResponse(bindResult.errors));
    state = bindResult.value;
  }

  if (state.mode === null) {
    return finalize(mcpError('SESSION_UNBOUND',
      'No project bound for this session. Call maad_use_project(s) first.'));
  }

  // Pick project
  if (strictReady && state.mode === 'single' && args?.project !== undefined && args.project !== state.activeProject) {
    return finalize(mcpError('PROJECT_NOT_WHITELISTED', 'Receipt project differs from the bound project'));
  }
  const projectName = resolveProjectName(state, args);
  if (typeof projectName !== 'string') return finalize(projectName); // error response
  projectForLog = projectName;

  // Role check
  const effectiveRole = state.effectiveRoles.get(projectName);
  if (!effectiveRole) {
    return finalize(mcpError('PROJECT_NOT_WHITELISTED',
      `Session is not bound to project "${projectName}".`));
  }
  roleForLog = effectiveRole;
  const minRole = getMinRoleForTool(toolName);
  if (minRole && !roleSatisfies(effectiveRole, minRole)) {
    return finalize(mcpError('INSUFFICIENT_ROLE',
      `Tool ${toolName} requires role "${minRole}" but session has "${effectiveRole}" for project "${projectName}".`));
  }

  // Receipt reuses session role checks and the existing token/project cap resolver.
  // Re-read live records rather than treating the bind-time snapshot as authority.
  const boundState = state;
  const boundToken = state.token;
  const boundTokenHash = boundToken?.hash;
  const boundTokenId = boundToken?.id;
  const boundMode = state.mode;
  const requiredLiveRole = guarded ? 'writer' : 'reader';
  const currentReceiptAccess = (): McpToolResponse | null => {
    const current = ctx.sessions.peek(sessionId);
    if (current !== boundState || current.cancelled) return mcpError('SESSION_CANCELLED', 'Receipt session is no longer active');
    const selected = resolveProjectName(current, args);
    if (current.mode !== boundMode || (current.mode === 'single' && current.activeProject !== projectName) || selected !== projectName) return mcpError('PROJECT_NOT_WHITELISTED', 'Receipt project binding changed');
    const role = current.effectiveRoles.get(projectName);
    const project = ctx.pool.getInstance().projects.find(p => p.name === projectName);
    if (!project || !role || !roleSatisfies(role, requiredLiveRole) || !roleSatisfies(project.role, requiredLiveRole)) {
      return mcpError('INSUFFICIENT_ROLE', 'Current receipt read access is unavailable');
    }
    if (ctx.tokens || boundToken) {
      if (!ctx.tokens || !boundToken || current.token?.hash !== boundTokenHash) return mcpError('TOKEN_UNKNOWN', 'Receipt token is unavailable');
      const token = ctx.tokens.lookupByHash(boundTokenHash!);
      if (!token || token.id !== boundTokenId) return mcpError('TOKEN_UNKNOWN', 'Receipt token is unavailable');
      if (token.revokedAt !== undefined) return mcpError('TOKEN_REVOKED', 'Receipt token was revoked');
      if (token.expiresAt !== undefined && !(Date.parse(token.expiresAt) > Date.now())) return mcpError('TOKEN_EXPIRED', 'Receipt token expired');
      const access = composeEffectiveRole(project.role, token, projectName);
      if (!access.ok) return mcpError(access.code, access.message);
      if (!roleSatisfies(access.role, requiredLiveRole)) return mcpError('INSUFFICIENT_ROLE', 'Receipt read access is unavailable');
    }
    return null;
  };
  if (strictReady) {
    const denied = currentReceiptAccess();
    if (denied) return finalize(denied);
  }

  // Payload size cap. Oversize args are rejected without touching the engine.
  const rl = getRateLimiter();
  const payloadRejection = rl.checkPayloadSize(payloadBytes);
  if (payloadRejection) {
    return finalize(mcpErrorWithDetails('RATE_LIMITED', 'Payload exceeds limit', {
      reason: payloadRejection.reason,
      limit: payloadRejection.limit,
      retryAfterMs: payloadRejection.retryAfterMs,
      size: payloadBytes,
    }));
  }

  // Concurrent-in-flight cap. Released in the `finally` below so an engine
  // error never leaks a slot.
  const slot = rl.tryAcquireConcurrent(sessionId);
  if (!slot.ok) {
    return finalize(mcpErrorWithDetails('RATE_LIMITED', 'Concurrent in-flight limit reached', {
      reason: slot.rejection.reason,
      limit: slot.rejection.limit,
      retryAfterMs: slot.rejection.retryAfterMs,
    }));
  }

  let acquiredProject: string | null = null;
  let readyReference: { engine: MaadEngine; isCurrent: () => boolean; release: () => void } | null = null;
  let receiptIsCurrent: (() => boolean) | null = null;
  let receiptOwnsSlot = false;
  let recoveryEngine: import('../engine/index.js').MaadEngine | null = null;
  try {
    // Resolve engine
    const ready = strictReady ? ctx.pool.acquireReadyReference(projectName) : null;
    if (ready && !ready.ok) return finalize(errorResponse(ready.errors));
    if (ready?.ok) readyReference = ready.value;
    const poolResult = readyReference ? { ok: true as const, value: readyReference.engine } : await ctx.pool.get(projectName, {
      allowEmptyIndexRecovery: toolName === 'maad_reindex',
    });
    if (!poolResult.ok) return finalize(errorResponse(poolResult.errors));
    if (ctx.pool.isEmptyIndexRecoveryEngine(poolResult.value)) recoveryEngine = poolResult.value;

    // 0.7.3 — refcount the engine for the duration of this handler so the
    // idle sweeper cannot evict mid-call. Released in finally below.
    if (!strictReady) {
      ctx.pool.acquire(projectName);
      acquiredProject = projectName;
    }

    const project = ctx.instance.projects.find((p) => p.name === projectName)!;

    // Operation kind dispatch. Reads invoke the handler directly; writes
    // acquire the per-engine write mutex via engine.runExclusive so
    // mutations across tools, sessions, and transports all serialize
    // through a single chokepoint. An unclassified tool that reaches
    // withEngine (i.e. not in kinds.ts) is a bug — fail fast with a clear
    // code rather than silently running a write without the mutex.
    const kind = getKindForTool(toolName);
    if (kind === null && !isEngineLess(toolName)) {
      return finalize(mcpError('MISSING_OPERATION_KIND',
        `Tool "${toolName}" has no OperationKind registered in src/mcp/kinds.ts. ` +
        `Every engine-bound tool must be listed as read or write.`));
    }

    // Per-request timeout via Promise.race. The handler continues running
    // on timeout (cooperative cancellation into engine stages is deferred to
    // 0.8.5 — documented in docs/gaps.md). Its eventual completion emits a
    // delayed `tool_call_overrun` log line so operators can see what the
    // slow work was doing.
    const timeoutMs = getRequestTimeoutMs();
    const receiptAbort = strictReady ? new AbortController() : null;
    const externalSignal = (extra as { signal?: AbortSignal } | undefined)?.signal;
    const onAbort = () => receiptAbort?.abort();
    if (receiptAbort) {
      externalSignal?.addEventListener('abort', onAbort, { once: true });
      if (externalSignal?.aborted) receiptAbort.abort();
    }
    const callCtx: CallContext = {
      engine: poolResult.value,
      projectName,
      projectRoot: project.path,
      sessionId,
      requestId,
      role: effectiveRole,
    };
    if (state.token !== undefined) callCtx.token = state.token;
    if (receiptAbort) callCtx.signal = receiptAbort.signal;
    if (strictReady) {
      const retained = readyReference!;
      callCtx.validateAccess = () => {
        const denied = currentReceiptAccess();
        if (denied) return (JSON.parse(denied.content[0]!.text) as { errors: MaadError[] }).errors[0]!;
        if (receiptAbort?.signal.aborted) return { code: 'REQUEST_TIMEOUT', message: 'Strict operation cancelled' };
        if (!retained.isCurrent()) return { code: 'CREATE_ENGINE_NOT_READY', message: 'Bound engine changed during admission' };
        return null;
      };
    }
    const invokeHandler = (): Promise<McpToolResponse> => Promise.resolve(handler(callCtx));
    // 0.7.0 — For writes under an authenticated session with the identity
    // flag on, set the engine's pending commit-identity slot inside the
    // write mutex. This survives the full handler scope; cleared in finally.
    // AsyncLocalStorage-based reentrancy means inner engine.createDocument
    // calls reuse the already-held mutex, so the slot is safe.
    const runWithIdentity = async (): Promise<McpToolResponse> => {
      const engine = poolResult.value;
      if (state.token && isCommitIdentityEnabled()) {
        const identity: CommitIdentity = { role: effectiveRole };
        identity.tokenId = state.token.id as string;
        if (state.token.agentId !== undefined) identity.agentId = state.token.agentId;
        if (state.token.userId !== undefined) identity.userId = state.token.userId;
        engine.setCommitIdentity(identity);
      }
      try {
        return await invokeHandler();
      } finally {
        engine.setCommitIdentity(undefined);
      }
    };
    // Engine self-defense for heavy maintenance ops (reindex/reload/schema/
    // summary). The admission gate sheds (retryable OVERLOADED) when free heap
    // headroom is below the floor so a storm can't OOM-crash-loop the engine;
    // single-flight coalesces concurrent identical ops into one execution.
    const guard = getHeavyOpGuard();
    const heavy = guard.isHeavy(toolName);
    if (heavy) {
      const rejection = guard.checkAdmission();
      if (rejection) {
        return finalize(mcpErrorWithDetails('OVERLOADED',
          'Engine shed a heavy maintenance op to protect memory; retry shortly.', {
            reason: rejection.reason,
            freeMb: rejection.freeMb,
            minFreeMb: rejection.minFreeMb,
            retryAfterMs: rejection.retryAfterMs,
          }));
      }
    }

    const runDispatch = (): Promise<McpToolResponse> =>
      kind === 'write'
        ? guarded
          ? poolResult.value.runGuardedExclusive(runWithIdentity)
          : poolResult.value.runExclusive(toolName, runWithIdentity)
        : invokeHandler();
    // For heavy ops, the single-flight leader also takes a process-global
    // concurrency slot (followers share its result and take none). At the cap,
    // shed with retryable OVERLOADED instead of piling onto the heap.
    let handlerPromise: Promise<McpToolResponse> = heavy
      ? guard.runCoalesced(heavyOpKey(projectName, toolName, args), async () => {
          const slot = guard.tryAcquireConcurrencySlot();
          if (!slot.ok) {
            return mcpErrorWithDetails('OVERLOADED',
              'Engine at heavy-op concurrency limit; retry shortly.', {
                reason: slot.rejection.reason,
                limit: slot.rejection.limit,
                retryAfterMs: slot.rejection.retryAfterMs,
              });
          }
          try {
            return await runDispatch();
          } finally {
            slot.release();
          }
        })
      : runDispatch();

    if (strictReady && readyReference) {
      const retained = readyReference;
      receiptIsCurrent = retained.isCurrent;
      receiptOwnsSlot = true;
      readyReference = null;
      handlerPromise = handlerPromise.then(response => {
        if (guarded) return response;
        const denied = currentReceiptAccess();
        if (denied) return denied;
        if (receiptAbort?.signal.aborted) return mcpError('REQUEST_TIMEOUT', 'Receipt observation cancelled');
        if (!retained.isCurrent()) return mcpError('RECEIPT_ENGINE_NOT_READY', 'Receipt engine changed during observation');
        return response;
      }).finally(() => {
        externalSignal?.removeEventListener('abort', onAbort);
        retained.release();
        slot.release();
      });
    }

    let timedOut = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<McpToolResponse>((resolve) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        receiptAbort?.abort();
        resolve(mcpErrorWithDetails('REQUEST_TIMEOUT',
          `Tool ${toolName} exceeded per-request timeout of ${timeoutMs}ms`,
          { tool: toolName, limitMs: timeoutMs },
        ));
      }, timeoutMs);
      // Don't keep the event loop alive for a pending request timer —
      // process exit stays clean when all real work is done.
      timeoutHandle.unref?.();
    });

    let response: McpToolResponse;
    try {
      response = await Promise.race<McpToolResponse>([handlerPromise, timeoutPromise]);
    } finally {
      // Clear the timer on the happy path so we don't keep ~30s of dead
      // closures around per request under sustained load.
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    if (timedOut) {
      // Observe the handler's eventual completion and log the overrun.
      // Keep the observation unhandled-rejection-safe.
      void handlerPromise.then(
        () => {
          getOpsLog().warn(
            { event: 'tool_call_overrun', request_id: requestId, tool: toolName, limit_ms: timeoutMs },
            'tool_call_overrun',
          );
        },
        (err) => {
          getOpsLog().warn(
            { event: 'tool_call_overrun', request_id: requestId, tool: toolName, limit_ms: timeoutMs, error: String(err) },
            'tool_call_overrun',
          );
        },
      );
    }

    if (strictReady && !guarded) {
      const denied = currentReceiptAccess();
      if (denied) return finalize(denied);
      if (!timedOut && receiptIsCurrent && !receiptIsCurrent()) {
        return finalize(mcpError('RECEIPT_ENGINE_NOT_READY', 'Receipt engine changed during observation'));
      }
    }
    return finalize(response);
  } finally {
    readyReference?.release();
    if (!receiptOwnsSlot) slot.release();
    // 0.7.3 — release engine refcount. Paired with acquiredProject above;
    // null when pool.get failed and acquire was never called.
    if (acquiredProject !== null) ctx.pool.release(acquiredProject);
    if (recoveryEngine) await ctx.pool.discardEmptyIndexRecovery(recoveryEngine);
  }
}

function inspectResponse(response: McpToolResponse): { result: 'ok' | 'error'; errorCode: string | null } {
  const first = response.content[0];
  if (!first || first.type !== 'text') return { result: 'error', errorCode: null };
  try {
    const parsed = JSON.parse(first.text) as { ok?: unknown; errors?: Array<{ code?: string }> };
    if (parsed.ok === true) return { result: 'ok', errorCode: null };
    const code = parsed.errors?.[0]?.code ?? null;
    return { result: 'error', errorCode: code };
  } catch {
    return { result: 'error', errorCode: null };
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
