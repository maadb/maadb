// ============================================================================
// Auth resolution — token → project cap → three-cap effective role
//
// Pure functions, no I/O. Composed by SessionRegistry.bindSingle/bindMulti
// (HTTP + registry mode) and bypassed entirely in stdio/synthetic mode
// (which has no token channel and uses the two-cap model from 0.4.0).
//
// THREE-CAP RULE:
//   effectiveRole(project) = min(
//     instance.projects[project].role,   // Cap 1: project ceiling
//     token.cap-for-project,              // Cap 2: token allowlist role
//     requestedRole                       // Cap 3: voluntary downgrade
//   )
//
// CAP 2 RESOLUTION:
//   1. Explicit entry for the project name wins, regardless of list order.
//   2. Wildcard '*' entry applies if no explicit entry matches.
//   3. Otherwise the project is forbidden → TOKEN_PROJECT_FORBIDDEN.
//   Entries with no `role` field inherit the token's global role; entries
//   with `role` downgrade to that role (never exceeds global — enforced at
//   load time would be defensive but lock #4 intent is resolver-side).
// ============================================================================

import type { Role } from '../mcp/roles.js';
import { minRole, roleSatisfies } from '../mcp/roles.js';
import type { TokenRecord, ProjectCap } from './types.js';

export type CapResolution =
  | { allowed: true; role: Role }
  | { allowed: false; reason: 'TOKEN_PROJECT_FORBIDDEN' };

/**
 * Find the per-project role cap for a token. Explicit entry > wildcard >
 * forbidden. Per-project role downgrades are capped at the token's global
 * role (lock #4) — an entry that claims higher is silently clamped rather
 * than rejected, which is safe because the outer three-cap composition will
 * clamp again against the project ceiling.
 */
export function resolveTokenCap(token: TokenRecord, projectName: string): CapResolution {
  const explicit = token.projects.find(p => p.name === projectName);
  if (explicit) return { allowed: true, role: capFor(explicit, token.role) };

  const wildcard = token.projects.find(p => p.name === '*');
  if (wildcard) return { allowed: true, role: capFor(wildcard, token.role) };

  return { allowed: false, reason: 'TOKEN_PROJECT_FORBIDDEN' };
}

function capFor(entry: ProjectCap, tokenGlobalRole: Role): Role {
  const requested = entry.role ?? tokenGlobalRole;
  // Clamp: per-project cap never exceeds the token's global role.
  return minRole(tokenGlobalRole, requested);
}

export type ThreeCapResolution =
  | { ok: true; role: Role }
  | { ok: false; code: 'TOKEN_PROJECT_FORBIDDEN' | 'ROLE_UPGRADE_DENIED'; message: string };

/**
 * Three-cap composition. Used in HTTP/registry mode at bind time.
 *
 * Returns the lowest of (instance-project ceiling, token cap, requested).
 * Fails if the token forbids the project, or if the requested role exceeds
 * what the ceilings allow.
 *
 * `requested` of undefined means "whatever the caps give me."
 */
export function composeEffectiveRole(
  projectRole: Role,
  token: TokenRecord,
  projectName: string,
  requested?: Role,
): ThreeCapResolution {
  const cap = resolveTokenCap(token, projectName);
  if (!cap.allowed) {
    return {
      ok: false,
      code: 'TOKEN_PROJECT_FORBIDDEN',
      message: `Token does not allow project "${projectName}"`,
    };
  }

  // Cap 1 × Cap 2: lowest of project ceiling and token cap.
  const ceiling = minRole(projectRole, cap.role);

  if (requested === undefined) return { ok: true, role: ceiling };

  // Cap 3: caller's requested role must be within the ceiling.
  if (!roleSatisfies(ceiling, requested)) {
    return {
      ok: false,
      code: 'ROLE_UPGRADE_DENIED',
      message: `Cannot bind as ${requested} — token+project ceiling is ${ceiling}`,
    };
  }
  return { ok: true, role: minRole(ceiling, requested) };
}
