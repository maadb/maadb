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
    }, 'maad_current_session');
  });

  return 4;
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
    description: 'Reloads the instance config from disk — picks up new projects, applies removals, and cancels sessions bound to removed projects. Requires admin role on every project in the session binding. Path/role mutations of existing projects are rejected until 0.9.0 eviction policy lands.',
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

    const result = await performInstanceReload(ctx, 'tool');
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

  return 1;
}
