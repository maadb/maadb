// ============================================================================
// Admin MCP auth tools — 0.7.0 Scoped Auth & Identity (P3c)
//
//   maad_issue_token    — issue a new token; returns plaintext ONCE + record
//   maad_revoke_token   — mark a token revoked; returns record
//   maad_rotate_token   — revoke + reissue with preserved caps; returns plaintext + record
//   maad_list_tokens    — list registry entries (no hash)
//   maad_show_token     — fetch one record by id (no hash)
//
// All admin-only and engine-less (same pattern as maad_instance_reload and
// maad_subscriptions). Refuse if the instance has no token registry (stdio
// / synthetic). Role gate: admin on every project in the session binding.
// ============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { successResponse, errorResponse } from '../response.js';
import { resolveSessionId } from '../../instance/session.js';
import type { InstanceCtx } from '../ctx.js';
import { roleSatisfies, type Role } from '../roles.js';
import { maadError } from '../../errors.js';
import { tokenId as toTokenId } from '../../auth/types.js';
import type { ProjectCap, IssueSpec, TokenRecord } from '../../auth/types.js';

const ROLE_ENUM = z.enum(['reader', 'writer', 'admin']);

/**
 * Inline admin role check — same pattern as maad_instance_reload. Engine-less
 * tools bypass withEngine's role gate, so we enforce here. Requires admin
 * effective role on EVERY project in the session's binding (least privilege,
 * since token ops affect the instance-wide registry).
 */
function requireAdminEverywhere(ctx: InstanceCtx, sessionId: string): ReturnType<typeof errorResponse> | null {
  const state = ctx.sessions.get(sessionId);
  if (!state || state.mode === null) {
    return errorResponse([maadError('SESSION_UNBOUND',
      'Session is not bound. Call maad_use_project(s) before admin auth tools.')]);
  }
  for (const [projectName, role] of state.effectiveRoles) {
    if (!roleSatisfies(role, 'admin')) {
      return errorResponse([maadError('INSUFFICIENT_ROLE',
        `admin auth tools require admin on every project in the session binding; session has "${role}" on "${projectName}".`)]);
    }
  }
  return null;
}

function requireTokenStore(ctx: InstanceCtx): ReturnType<typeof errorResponse> | null {
  if (ctx.tokens === null) {
    return errorResponse([maadError('TOKENS_FILE_MISSING',
      'Token registry is not available — this MCP instance runs in stdio/synthetic mode with no tokens.yaml. Admin auth tools require --instance with a file-mode registry.')]);
  }
  return null;
}

/** Scrub `hash` from a record before returning to clients — they never need it. */
function sanitize(record: TokenRecord): Omit<TokenRecord, 'hash'> {
  const { hash, ...rest } = record;
  void hash;
  return rest;
}

export function register(server: McpServer, ctx: InstanceCtx): number {
  server.registerTool('maad_issue_token', {
    description: 'Issue a new auth token. Returns plaintext ONCE plus record metadata — plaintext is never recoverable after. Admin on every bound project required.',
    inputSchema: z.object({
      role: ROLE_ENUM.describe('Token\'s global role (capped by per-project overrides and instance project ceiling)'),
      projects: z.array(z.object({
        name: z.string().describe('Project name or "*" wildcard'),
        role: ROLE_ENUM.optional().describe('Optional per-project role downgrade (never exceeds global)'),
      })).describe('Allowlist. Wildcard `*` matches every project at the token\'s global role.'),
      name: z.string().optional().describe('Human label (e.g. "brain-app-gateway")'),
      agentId: z.string().optional().describe('Ref -> agent for identity attribution'),
      userId: z.string().optional().describe('Ref -> user when token represents a human'),
      expiresAt: z.string().optional().describe('ISO 8601 expiry timestamp'),
    }),
  }, async (args, extra) => {
    const storeErr = requireTokenStore(ctx);
    if (storeErr) return storeErr;
    const sid = resolveSessionId(extra);
    const roleErr = requireAdminEverywhere(ctx, sid);
    if (roleErr) return roleErr;

    const spec: IssueSpec = {
      role: args.role as Role,
      projects: args.projects.map(p => {
        const cap: ProjectCap = { name: p.name };
        if (p.role !== undefined) cap.role = p.role as Role;
        return cap;
      }),
    };
    if (args.name !== undefined) spec.name = args.name;
    if (args.agentId !== undefined) spec.agentId = args.agentId;
    if (args.userId !== undefined) spec.userId = args.userId;
    if (args.expiresAt !== undefined) spec.expiresAt = args.expiresAt;

    const result = await ctx.tokens!.issue(spec);
    if (!result.ok) return errorResponse(result.errors);
    return successResponse({
      plaintext: result.value.plaintext,
      record: sanitize(result.value.record),
      warning: 'Store the plaintext now — it will not be returned again.',
    }, 'maad_issue_token');
  });

  server.registerTool('maad_revoke_token', {
    description: 'Revoke a token by its id. Idempotent. Admin on every bound project required.',
    inputSchema: z.object({
      id: z.string().describe('Token id (tok-xxx)'),
    }),
  }, async (args, extra) => {
    const storeErr = requireTokenStore(ctx);
    if (storeErr) return storeErr;
    const sid = resolveSessionId(extra);
    const roleErr = requireAdminEverywhere(ctx, sid);
    if (roleErr) return roleErr;

    const result = await ctx.tokens!.revoke(toTokenId(args.id));
    if (!result.ok) return errorResponse(result.errors);
    // Tear down sessions bound to the revoked token now — excluding this
    // session so the response is not cut off mid-write when an admin revokes
    // their own token (per-request auth 401s its next call regardless, and
    // the transport sweeper evicts it on the next tick).
    ctx.onTokensChanged?.(sid);
    return successResponse({ record: sanitize(result.value) }, 'maad_revoke_token');
  });

  server.registerTool('maad_rotate_token', {
    description: 'Revoke an existing token and issue a new one with the same capabilities. Returns new plaintext ONCE. Admin on every bound project required.',
    inputSchema: z.object({
      id: z.string().describe('Token id to rotate (tok-xxx)'),
    }),
  }, async (args, extra) => {
    const storeErr = requireTokenStore(ctx);
    if (storeErr) return storeErr;
    const sid = resolveSessionId(extra);
    const roleErr = requireAdminEverywhere(ctx, sid);
    if (roleErr) return roleErr;

    const result = await ctx.tokens!.rotate(toTokenId(args.id));
    if (!result.ok) return errorResponse(result.errors);
    // Same self-exclusion as revoke — critical here: closing this session's
    // transport before the response flushes would destroy the one-time
    // plaintext of the replacement token.
    ctx.onTokensChanged?.(sid);
    return successResponse({
      plaintext: result.value.plaintext,
      record: sanitize(result.value.record),
      warning: 'Store the new plaintext now — old token revoked, new plaintext will not be returned again.',
    }, 'maad_rotate_token');
  });

  server.registerTool('maad_list_tokens', {
    description: 'List all tokens in the registry. Active tokens by default; pass includeRevoked:true for full history. Admin on every bound project required.',
    inputSchema: z.object({
      includeRevoked: z.boolean().optional().describe('Include revoked tokens in the response'),
    }),
  }, async (args, extra) => {
    const storeErr = requireTokenStore(ctx);
    if (storeErr) return storeErr;
    const sid = resolveSessionId(extra);
    const roleErr = requireAdminEverywhere(ctx, sid);
    if (roleErr) return roleErr;

    const all = ctx.tokens!.list();
    const filtered = args.includeRevoked === true ? all : all.filter(r => r.revokedAt === undefined);
    return successResponse({
      tokens: filtered.map(sanitize),
      total: filtered.length,
      activeCount: ctx.tokens!.activeCount(),
    }, 'maad_list_tokens');
  });

  server.registerTool('maad_show_token', {
    description: 'Fetch a single token record by id. Hash is never returned. Admin on every bound project required.',
    inputSchema: z.object({
      id: z.string().describe('Token id (tok-xxx)'),
    }),
  }, async (args, extra) => {
    const storeErr = requireTokenStore(ctx);
    if (storeErr) return storeErr;
    const sid = resolveSessionId(extra);
    const roleErr = requireAdminEverywhere(ctx, sid);
    if (roleErr) return roleErr;

    const record = ctx.tokens!.lookupById(toTokenId(args.id));
    if (!record) {
      return errorResponse([maadError('TOKEN_NOT_FOUND', `No token with id ${args.id}`)]);
    }
    return successResponse({ record: sanitize(record) }, 'maad_show_token');
  });

  return 5;
}
