// ============================================================================
// Instance tools — maad_projects, maad_use_project, maad_use_projects,
//                  maad_current_session
//
// These four tools operate at the instance level (no project binding required).
// They let clients discover and bind to projects served by this MCP instance.
// ============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { successResponse, errorResponse } from '../response.js';
import { resolveSessionId } from '../../instance/session.js';
import type { InstanceCtx } from '../ctx.js';
import { performInstanceReload } from '../instance-reload.js';
import { roleSatisfies } from '../roles.js';
import { maadError } from '../../errors.js';
import { collectSubscriptions } from '../notifications.js';
import { tokenRoleOn } from '../../auth/scope.js';
import { registerProject, type RegisterProjectSpec } from '../../instance/register.js';

const ROLE_ENUM = z.enum(['reader', 'writer', 'admin']);

export function register(server: McpServer, ctx: InstanceCtx): number {
  server.registerTool('maad_projects', {
    description: 'Lists projects declared in this MCP instance. Returns name, description, configured role, and whether the current session has access. Call this before maad_use_project.',
    inputSchema: z.object({}),
  }, async (_args, extra) => {
    const sessionId = resolveSessionId(extra);
    const state = ctx.sessions.get(sessionId);

    const projects = ctx.instance.projects.map((p) => ({
      name: p.name,
      description: p.description ?? null,
      role: p.role,
      accessible: state?.mode === null || !state
        ? null
        : state.mode === 'single'
          ? state.activeProject === p.name
          : (state.whitelist ?? []).includes(p.name),
    }));

    return successResponse({
      instance: ctx.instance.name,
      source: ctx.instance.source,
      projects,
      sessionBound: state?.mode !== null && state !== undefined,
    }, 'maad_projects');
  });

  server.registerTool('maad_use_project', {
    description: 'Binds the current session to a single project. Every subsequent tool call routes to this project. Optional `as` downgrades the session role below the project\'s configured role (e.g. bind an admin project in reader mode for safety). Once bound, a session cannot rebind — disconnect and reconnect instead.',
    inputSchema: z.object({
      name: z.string().describe('Project name (from maad_projects)'),
      as: ROLE_ENUM.optional().describe('Optional role downgrade. Cannot exceed the project\'s configured role.'),
    }),
  }, async (args, extra) => {
    const sessionId = resolveSessionId(extra);
    if (!ctx.sessions.get(sessionId)) ctx.sessions.create(sessionId);

    const opts = args.as ? { as: args.as } : {};
    const result = ctx.sessions.bindSingle(sessionId, args.name, opts);
    if (!result.ok) return errorResponse(result.errors);

    const state = result.value;
    return successResponse({
      mode: state.mode,
      activeProject: state.activeProject,
      effectiveRole: state.effectiveRoles.get(args.name),
    }, 'maad_use_project');
  });

  server.registerTool('maad_use_projects', {
    description: 'Binds the current session to a whitelist of projects (multi-project mode). Every subsequent tool call must pass `project=<name>` to pick one. Optional `as` downgrades the role uniformly across all listed projects. Once bound, a session cannot rebind.',
    inputSchema: z.object({
      names: z.array(z.string()).min(1).describe('Project names from maad_projects'),
      as: ROLE_ENUM.optional().describe('Optional role downgrade. Cannot exceed any project\'s configured role.'),
    }),
  }, async (args, extra) => {
    const sessionId = resolveSessionId(extra);
    if (!ctx.sessions.get(sessionId)) ctx.sessions.create(sessionId);

    const opts = args.as ? { as: args.as } : {};
    const result = ctx.sessions.bindMulti(sessionId, args.names, opts);
    if (!result.ok) return errorResponse(result.errors);

    const state = result.value;
    const effectiveRoles: Record<string, string> = {};
    for (const [name, role] of state.effectiveRoles) effectiveRoles[name] = role;

    return successResponse({
      mode: state.mode,
      whitelist: state.whitelist,
      effectiveRoles,
    }, 'maad_use_projects');
  });

  server.registerTool('maad_current_session', {
    description: 'Returns the current session state: mode, bound project(s), effective role per project, and binding_source (how the session was bound — client_tool or gateway_pin). Useful for debugging routing issues and detecting pinned sessions.',
    inputSchema: z.object({}),
  }, async (_args, extra) => {
    const sessionId = resolveSessionId(extra);
    const state = ctx.sessions.get(sessionId);

    if (!state) {
      return successResponse({ sessionId, mode: null, binding_source: null, note: 'no session registered yet' }, 'maad_current_session');
    }

    const effectiveRoles: Record<string, string> = {};
    for (const [name, role] of state.effectiveRoles) effectiveRoles[name] = role;

    return successResponse({
      sessionId: state.sessionId,
      mode: state.mode,
      activeProject: state.activeProject ?? null,
      whitelist: state.whitelist ?? null,
      effectiveRoles,
      binding_source: state.bindingSource,
      createdAt: state.createdAt.toISOString(),
      lastActivityAt: state.lastActivityAt.toISOString(),
      subscription: state.subscription
        ? { docTypes: state.subscription.docTypes, project: state.subscription.project, createdAt: state.subscription.createdAt.toISOString() }
        : null,
    }, 'maad_current_session');
  });

  server.registerTool('maad_subscribe', {
    description: 'Subscribe the current session to live notifications on durable writes. Optional filters: docTypes (array), project (string). Emits notifications/resources/updated with uri=maad://records/<docId> + extra params. One subscription per session; re-subscribe to replace filter.',
    inputSchema: z.object({
      docTypes: z.array(z.string()).optional().describe('Allowlist of doc types; omit for all types'),
      project: z.string().optional().describe('Restrict to one project; defaults to session\'s bound scope'),
    }),
  }, async (args, extra) => {
    const sessionId = resolveSessionId(extra);
    if (!ctx.sessions.get(sessionId)) ctx.sessions.create(sessionId);
    const state = ctx.sessions.get(sessionId)!;

    const docTypes = (args.docTypes && args.docTypes.length > 0) ? args.docTypes : null;
    const project = args.project ?? null;

    state.subscription = { docTypes, project, createdAt: new Date() };

    return successResponse({
      subscribed: true,
      filter: { docTypes, project },
      note: 'Notifications fire only on durable commits. Use maad_changes_since for historical catch-up on reconnect.',
    }, 'maad_subscribe');
  });

  server.registerTool('maad_unsubscribe', {
    description: 'Releases the current session\'s live-update subscription. No-op if not subscribed.',
    inputSchema: z.object({}),
  }, async (_args, extra) => {
    const sessionId = resolveSessionId(extra);
    const state = ctx.sessions.get(sessionId);
    const wasSubscribed = state?.subscription !== undefined;
    if (state) delete state.subscription;

    return successResponse({ subscribed: false, wasSubscribed }, 'maad_unsubscribe');
  });

  return 6;
}

/**
 * Registers the admin-only `maad_instance_reload` tool separately from the
 * base instance tools. Called regardless of instance source so synthetic
 * instances can surface a clear INSTANCE_RELOAD_SYNTHETIC error rather than
 * an opaque "unknown tool" response.
 *
 * Role gate lives inside the handler (engine-less tools bypass the `withEngine`
 * role check). Requires admin effective role on EVERY project in the session's
 * binding — least privilege, since reload is instance-wide.
 */
export function registerReload(server: McpServer, ctx: InstanceCtx): number {
  server.registerTool('maad_instance_reload', {
    description: 'Reloads instance.yaml from disk. Picks up added projects, evicts removed, cancels bound sessions. Admin on every bound project required. Path/role mutations rejected until 0.9.0.',
    inputSchema: z.object({}),
  }, async (_args, extra) => {
    const sessionId = resolveSessionId(extra);
    const state = ctx.sessions.get(sessionId);

    // Session must be bound before an admin check makes sense.
    if (!state || state.mode === null) {
      return errorResponse([maadError('SESSION_UNBOUND',
        'Session is not bound to any project. Call maad_use_project(s) before maad_instance_reload.')]);
    }
    // Admin on EVERY project in the binding. In single mode that's one project;
    // in multi mode it's the whole whitelist. Prevents an operator who only
    // has admin on one subproject from reloading the whole instance and
    // affecting other tenants.
    for (const [projectName, role] of state.effectiveRoles) {
      if (!roleSatisfies(role, 'admin')) {
        return errorResponse([maadError('INSUFFICIENT_ROLE',
          `maad_instance_reload requires admin on every project in the session binding; session has "${role}" on "${projectName}".`)]);
      }
    }

    // Keep the caller alive long enough to carry this response if its bearer
    // was revoked on disk. Its next request is still rejected by auth, and a
    // later unexcluded eviction pass removes the retained session.
    const result = await performInstanceReload(ctx, 'tool', { excludeSessionId: sessionId });
    if (!result.ok) return errorResponse(result.errors);

    return successResponse({
      source: result.value.source,
      projectsAdded: result.value.projectsAdded,
      projectsRemoved: result.value.projectsRemoved,
      sessionsCancelled: result.value.sessionsCancelled.length,
      sessionsPruned: result.value.sessionsPruned.length,
      durationMs: result.value.durationMs,
    }, 'maad_instance_reload');
  });

  server.registerTool('maad_register_project', {
    description: 'Registers a new project in instance.yaml and loads it, so hosts never write instance.yaml, run git init or commit themselves. Creates the folder inside the instance folder (path defaults to name), scaffolds _schema/ and _registry/, initializes Git when historyMode is audit, batch or snapshot, writes instance.yaml atomically, then reloads the instance. Idempotent: calling again with the same name, path, role and historyMode returns registered:false. A different path, role or historyMode for an existing name fails with PROJECT_ALREADY_REGISTERED. Requires admin on every bound project and, with a token, an admin "*" grant.',
    inputSchema: z.object({
      name: z.string().describe('Project name, /^[a-z][a-z0-9_-]*$/'),
      historyMode: z.enum(['audit', 'batch', 'snapshot', 'feed', 'read']).describe('How writes reach Git: audit (commit per write), batch, snapshot, feed (no commits), read (read-only)'),
      role: ROLE_ENUM.describe('Highest role any session gets on this project'),
      path: z.string().optional().describe('Folder relative to the instance config folder (default: name)'),
      description: z.string().max(500).optional().describe('Shown by maad_projects'),
      historyOptions: z.object({
        max_writes: z.number().int().positive().optional(),
        max_delay_ms: z.number().int().positive().optional(),
      }).strict().optional().describe('Batch tuning: { max_writes, max_delay_ms }'),
    }),
  }, async (args, extra) => {
    const sessionId = resolveSessionId(extra);
    const state = ctx.sessions.get(sessionId);
    if (!state || state.mode === null) {
      return errorResponse([maadError('SESSION_UNBOUND',
        'Session is not bound to any project. Call maad_use_project(s) before maad_register_project.')]);
    }
    for (const [projectName, role] of state.effectiveRoles) {
      if (!roleSatisfies(role, 'admin')) {
        return errorResponse([maadError('INSUFFICIENT_ROLE',
          `maad_register_project requires admin on every project in the session binding; session has "${role}" on "${projectName}".`)]);
      }
    }
    // A new project is outside every named grant, so only a token that
    // already reaches all projects as admin may create one.
    if (state.token !== undefined && tokenRoleOn(state.token, '*') !== 'admin') {
      return errorResponse([maadError('INSUFFICIENT_ROLE',
        'maad_register_project requires a token with an admin "*" project grant.')]);
    }
    if (ctx.instance.source !== 'file' || !ctx.instance.configPath) {
      return errorResponse([maadError('INSTANCE_RELOAD_SYNTHETIC',
        'Synthetic (legacy --project) instances have no instance.yaml. Start the server with --instance <path> to register projects.')]);
    }

    const spec: RegisterProjectSpec = { name: args.name, role: args.role, historyMode: args.historyMode };
    if (args.path !== undefined) spec.path = args.path;
    if (args.description !== undefined) spec.description = args.description;
    if (args.historyOptions !== undefined) {
      const opts: RegisterProjectSpec['historyOptions'] = {};
      if (args.historyOptions.max_writes !== undefined) opts.max_writes = args.historyOptions.max_writes;
      if (args.historyOptions.max_delay_ms !== undefined) opts.max_delay_ms = args.historyOptions.max_delay_ms;
      spec.historyOptions = opts;
    }

    const registered = await registerProject(ctx.instance.configPath, spec);
    if (!registered.ok) return errorResponse(registered.errors);
    const outcome = registered.value;

    // Load it unless this server already serves it (an idempotent repeat).
    let reloaded = false;
    if (!ctx.instance.projects.some(p => p.name === outcome.name)) {
      const reload = await performInstanceReload(ctx, 'tool', { excludeSessionId: sessionId });
      if (!reload.ok) {
        // instance.yaml already holds the entry; repeating the call only reloads.
        return errorResponse(reload.errors.map(e => ({
          ...e,
          details: { ...(e.details ?? {}), registered: outcome.registered, retrySafe: true },
        })));
      }
      reloaded = true;
    }

    return successResponse({ ...outcome, reloaded }, 'maad_register_project');
  });

  server.registerTool('maad_subscriptions', {
    description: 'Admin tool: returns live-subscription inventory across all sessions as { totalSubscriptions, subscriptions[], byProject, byDocType }. Requires admin on every project in the session binding.',
    inputSchema: z.object({}),
  }, async (_args, extra) => {
    const sessionId = resolveSessionId(extra);
    const callerState = ctx.sessions.get(sessionId);
    if (!callerState || callerState.mode === null) {
      return errorResponse([maadError('SESSION_UNBOUND',
        'Session is not bound to any project. Call maad_use_project(s) before maad_subscriptions.')]);
    }
    // Admin on EVERY project in the binding — same model as maad_instance_reload.
    // The tool leaks instance-wide state, so require admin across the caller's full scope.
    for (const [projectName, role] of callerState.effectiveRoles) {
      if (!roleSatisfies(role, 'admin')) {
        return errorResponse([maadError('INSUFFICIENT_ROLE',
          `maad_subscriptions requires admin on every project in the session binding; session has "${role}" on "${projectName}".`)]);
      }
    }

    const inventory = collectSubscriptions(ctx.sessions);
    return successResponse(inventory, 'maad_subscriptions');
  });

  return 3;
}
