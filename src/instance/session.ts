// ============================================================================
// SessionRegistry — per-connection state for multi-project routing
//
// A session is created when an MCP client connects. The client binds the
// session to one project (single mode) or a whitelist (multi mode) via
// maad_use_project(s). Once bound, a session cannot rebind — it must
// disconnect and reconnect.
//
// Session IDs are derived from the MCP request context (SDK-supplied where
// possible) so the same code path works for stdio today and HTTP/SSE in 0.9.0.
// ============================================================================

import { randomUUID } from 'node:crypto';
import { ok, singleErr, type Result } from '../errors.js';
import { roleSatisfies, minRole, type Role } from '../mcp/roles.js';
import type { InstanceConfig } from './config.js';
import { getProject } from './config.js';

export type SessionMode = 'single' | 'multi';

/**
 * How a session was bound to its project(s). Load-bearing for gateway-pinned
 * sessions: rebind-rejection in maad_use_project/maad_use_projects checks
 * `bindingSource === 'gateway_pin'` to distinguish trusted-gateway pins from
 * client-initiated binds. `null` = session exists but is unbound.
 *
 * - `client_tool`  — bound by client calling maad_use_project/maad_use_projects
 * - `gateway_pin`  — bound by HTTP transport honoring X-Maad-Pin-Project header
 *                    (multi-tenant hosted deployments, 0.6.8+); irrevocable
 */
export type BindingSource = 'client_tool' | 'gateway_pin';

export interface SessionState {
  sessionId: string;
  mode: SessionMode | null;
  activeProject?: string;
  whitelist?: string[];
  effectiveRoles: Map<string, Role>;
  bindingSource: BindingSource | null;
  createdAt: Date;
  lastActivityAt: Date;
  /**
   * Set to true by `cancelByProject` when the session's bound project was
   * removed via instance reload. The next tool call checks this flag and
   * returns SESSION_CANCELLED, then destroys the session. Multi-mode sessions
   * whose whitelist merely contained the removed project are NOT cancelled —
   * their whitelist is pruned via `pruneProjectFromWhitelist` instead.
   */
  cancelled?: boolean;
  /**
   * 0.6.11 — Live notification subscription. Set by `maad_subscribe`,
   * cleared by `maad_unsubscribe` or session destroy. When present, durable
   * writes matching the filter fire `notifications/resources/updated` to
   * this session via its registered notifier (see NotifierRegistry).
   * docTypes null = match all types; project null = match the session's
   * bound project (single-mode) or any project in the whitelist (multi-mode).
   */
  subscription?: {
    docTypes: string[] | null;
    project: string | null;
    createdAt: Date;
  };
}

export interface BindOptions {
  as?: Role;
  /**
   * Who initiated the bind. Defaults to `client_tool`. HTTP transport passes
   * `gateway_pin` when the X-Maad-Pin-Project header was honored at initialize.
   * Once a session is bound with `gateway_pin`, rebind attempts via
   * maad_use_project/maad_use_projects reject with SESSION_PINNED.
   */
  source?: BindingSource;
}

export type SessionCloseReason = 'client' | 'transport' | 'idle' | 'shutdown';
export type SessionCloseHandler = (sessionId: string, reason: SessionCloseReason) => void;
export type SessionCreateHandler = (sessionId: string) => void;

export class SessionRegistry {
  private sessions = new Map<string, SessionState>();
  private closeHandlers: SessionCloseHandler[] = [];
  private createHandlers: SessionCreateHandler[] = [];

  constructor(private instance: InstanceConfig) {}

  /**
   * Swap the live instance config. Called by the instance-reload path after
   * the pool has applied diffs. Does not touch existing sessions — cancellation
   * and whitelist pruning are separate explicit calls.
   */
  setInstance(newInstance: InstanceConfig): void {
    this.instance = newInstance;
  }

  create(sessionId: string): SessionState {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const state: SessionState = {
      sessionId,
      mode: null,
      effectiveRoles: new Map(),
      bindingSource: null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
    };
    this.sessions.set(sessionId, state);
    // Fan-out to createHandlers — stdio uses this to register a per-session
    // notifier once the synthesized stdio session ID becomes known. Cheap
    // synchronous call path; handlers must be best-effort and non-throwing.
    for (const h of this.createHandlers) {
      try { h(sessionId); } catch { /* best-effort fan-out */ }
    }
    return state;
  }

  get(sessionId: string): SessionState | undefined {
    const state = this.sessions.get(sessionId);
    if (state) state.lastActivityAt = new Date();
    return state;
  }

  /**
   * Peek without bumping lastActivityAt. Used by the idle sweeper — it must
   * not reset the very activity timestamp it's checking against.
   */
  peek(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Register a handler fired when a session is destroyed, regardless of cause.
   * Handlers should be cheap (syncronous, no throws); failures in one handler
   * must not block others. Multiple handlers compose in registration order.
   */
  registerCloseHandler(handler: SessionCloseHandler): void {
    this.closeHandlers.push(handler);
  }

  /**
   * 0.6.11 — Register a handler fired when a session is created. Used by
   * stdio mode to register a notifier once the synthesized stdio session ID
   * becomes known (HTTP knows the sid earlier via onsessioninitialized).
   * Same best-effort / non-throwing contract as closeHandlers.
   */
  registerCreateHandler(handler: SessionCreateHandler): void {
    this.createHandlers.push(handler);
  }

  destroy(sessionId: string, reason: SessionCloseReason = 'client'): void {
    if (!this.sessions.has(sessionId)) return;
    this.sessions.delete(sessionId);
    for (const h of this.closeHandlers) {
      try { h(sessionId, reason); } catch { /* best-effort fan-out */ }
    }
  }

  size(): number {
    return this.sessions.size;
  }

  /**
   * Iterate session snapshots without triggering lastActivityAt updates.
   * Returned array is a copy — safe to mutate during iteration (the sweeper
   * calls destroy() which mutates the underlying map).
   */
  snapshot(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Mark sessions whose single-mode binding (or gateway-pin) targets the
   * named project as `cancelled`. The next tool call on a cancelled session
   * returns SESSION_CANCELLED and then destroys the session. Multi-mode
   * sessions are NOT cancelled here — use `pruneProjectFromWhitelist` for
   * those. Returns the session IDs that were cancelled.
   */
  cancelByProject(projectName: string): string[] {
    const cancelled: string[] = [];
    for (const state of this.sessions.values()) {
      if (state.mode === 'single' && state.activeProject === projectName) {
        state.cancelled = true;
        cancelled.push(state.sessionId);
      }
    }
    return cancelled;
  }

  /**
   * Remove a project from multi-mode sessions' whitelist + effectiveRoles.
   * Single-mode sessions are not touched (handled by `cancelByProject`).
   * A multi-mode session whose whitelist becomes empty after pruning is
   * marked cancelled — it has no remaining projects to route to.
   * Returns { prunedSessions, cancelledSessions } lists.
   */
  pruneProjectFromWhitelist(projectName: string): { prunedSessions: string[]; cancelledSessions: string[] } {
    const pruned: string[] = [];
    const cancelledFromEmpty: string[] = [];
    for (const state of this.sessions.values()) {
      if (state.mode !== 'multi') continue;
      const listHadProject = state.whitelist?.includes(projectName) ?? false;
      if (!listHadProject) continue;
      state.whitelist = state.whitelist!.filter(n => n !== projectName);
      state.effectiveRoles.delete(projectName);
      pruned.push(state.sessionId);
      if (state.whitelist.length === 0) {
        state.cancelled = true;
        cancelledFromEmpty.push(state.sessionId);
      }
    }
    return { prunedSessions: pruned, cancelledSessions: cancelledFromEmpty };
  }

  bindSingle(sessionId: string, projectName: string, opts: BindOptions = {}): Result<SessionState> {
    const state = this.sessions.get(sessionId);
    if (!state) return singleErr('SESSION_UNBOUND', `Unknown session: ${sessionId}`);
    if (state.bindingSource === 'gateway_pin') {
      return singleErr('SESSION_PINNED',
        `session is pinned to project '${state.activeProject}' by gateway; open a new session with a different X-Maad-Pin-Project header to switch projects`);
    }
    if (state.mode !== null) {
      return singleErr('SESSION_ALREADY_BOUND', 'Session already bound — disconnect and reconnect to rebind');
    }

    const project = getProject(this.instance, projectName);
    if (!project) return singleErr('PROJECT_UNKNOWN', `Project "${projectName}" not declared in instance`);

    const effective = this.resolveEffectiveRole(project.role, opts.as);
    if (!effective.ok) return effective;

    state.mode = 'single';
    state.activeProject = projectName;
    state.effectiveRoles.set(projectName, effective.value);
    state.bindingSource = opts.source ?? 'client_tool';
    state.lastActivityAt = new Date();
    return ok(state);
  }

  bindMulti(sessionId: string, projectNames: string[], opts: BindOptions = {}): Result<SessionState> {
    const state = this.sessions.get(sessionId);
    if (!state) return singleErr('SESSION_UNBOUND', `Unknown session: ${sessionId}`);
    if (state.bindingSource === 'gateway_pin') {
      return singleErr('SESSION_PINNED',
        `session is pinned to project '${state.activeProject}' by gateway; open a new session with a different X-Maad-Pin-Project header to switch projects`);
    }
    if (state.mode !== null) {
      return singleErr('SESSION_ALREADY_BOUND', 'Session already bound — disconnect and reconnect to rebind');
    }
    if (projectNames.length === 0) {
      return singleErr('INSTANCE_CONFIG_INVALID', 'bindMulti requires at least one project name');
    }

    const effectiveRoles = new Map<string, Role>();
    for (const name of projectNames) {
      const project = getProject(this.instance, name);
      if (!project) return singleErr('PROJECT_UNKNOWN', `Project "${name}" not declared in instance`);
      const effective = this.resolveEffectiveRole(project.role, opts.as);
      if (!effective.ok) return effective;
      effectiveRoles.set(name, effective.value);
    }

    state.mode = 'multi';
    state.whitelist = [...projectNames];
    state.effectiveRoles = effectiveRoles;
    state.bindingSource = opts.source ?? 'client_tool';
    state.lastActivityAt = new Date();
    return ok(state);
  }

  private resolveEffectiveRole(projectRole: Role, requested?: Role): Result<Role> {
    if (!requested) return ok(projectRole);
    if (!roleSatisfies(projectRole, requested)) {
      return singleErr('ROLE_UPGRADE_DENIED',
        `Cannot bind as ${requested} — project role is ${projectRole}`);
    }
    return ok(minRole(projectRole, requested));
  }
}

// Session ID resolution. MCP SDK v1.29+ exposes a session identifier via
// request meta in some transports. Where it's unavailable (stdio today),
// we synthesize one UUID per process and reuse it — stdio is single-client
// so that's equivalent to "this connection." HTTP/SSE in 0.9.0 will supply
// a real per-connection ID through transport middleware.
let processStdioSessionId: string | null = null;

// `extra` is the second arg MCP SDK passes to tool handlers (RequestHandlerExtra).
// It exposes `sessionId` when the transport supplies one (HTTP/SSE in 0.9.0).
// stdio today does not, so we fall back to a stable per-process UUID.
export function resolveSessionId(extra: unknown): string {
  if (extra && typeof extra === 'object') {
    const sid = (extra as Record<string, unknown>).sessionId;
    if (typeof sid === 'string' && sid.length > 0) return sid;
    const meta = (extra as Record<string, unknown>)._meta;
    if (meta && typeof meta === 'object') {
      const metaSid = (meta as Record<string, unknown>).sessionId;
      if (typeof metaSid === 'string' && metaSid.length > 0) return metaSid;
    }
    const params = (extra as Record<string, unknown>).params;
    if (params && typeof params === 'object') {
      const paramMeta = (params as Record<string, unknown>)._meta;
      if (paramMeta && typeof paramMeta === 'object') {
        const paramSid = (paramMeta as Record<string, unknown>).sessionId;
        if (typeof paramSid === 'string' && paramSid.length > 0) return paramSid;
      }
    }
  }
  if (!processStdioSessionId) processStdioSessionId = `stdio-${randomUUID()}`;
  return processStdioSessionId;
}

// Test hook — resets the stdio fallback. Production code never calls this.
export function __resetStdioSessionId(): void {
  processStdioSessionId = null;
}
