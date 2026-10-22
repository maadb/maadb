// ============================================================================
// Token scope containment.
//
// The admin auth tools (issue / revoke / rotate / list / show) act on the
// instance-wide token registry. A caller that is admin on its own bound
// projects must not be able to mint, change or even see tokens that reach
// beyond those projects, or one tenant's admin could cross the project
// boundary. These helpers decide what a caller's token may touch.
//
// Matching mirrors resolve time: a named project entry wins over the `*`
// wildcard, and a per-project role may only reduce the token's global role.
// ============================================================================

import { minRole, roleSatisfies, type Role } from '../mcp/roles.js';
import type { IssueSpec, ProjectCap, TokenRecord } from './types.js';

/** The role a token holds on `project`, or null when it does not reach it. */
export function tokenRoleOn(
  token: Pick<TokenRecord, 'role' | 'projects'>,
  project: string,
): Role | null {
  const named = token.projects.find(c => c.name === project);
  if (named) return named.role ? minRole(token.role, named.role) : token.role;
  const wildcard = token.projects.find(c => c.name === '*');
  if (wildcard) return wildcard.role ? minRole(token.role, wildcard.role) : token.role;
  return null;
}

function holdsWildcard(token: Pick<TokenRecord, 'projects'>): boolean {
  return token.projects.some(c => c.name === '*');
}

/** The role a requested cap would grant: its own role, capped by the global one. */
function grantedRole(globalRole: Role, cap: ProjectCap): Role {
  return cap.role ? minRole(globalRole, cap.role) : globalRole;
}

/**
 * Check that `spec` does not exceed `issuer`. Returns a reason string when it
 * does, null when the issue is within the issuer's scope.
 */
export function issueExceedsScope(
  issuer: Pick<TokenRecord, 'role' | 'projects'>,
  spec: Pick<IssueSpec, 'role' | 'projects'>,
): string | null {
  if (!roleSatisfies(issuer.role, spec.role)) {
    return `cannot issue a "${spec.role}" token from a "${issuer.role}" token`;
  }
  for (const cap of spec.projects) {
    const granted = grantedRole(spec.role, cap);
    if (cap.name === '*') {
      if (!holdsWildcard(issuer)) {
        return 'a wildcard ("*") project entry requires a token that itself holds the wildcard';
      }
    }
    const held = cap.name === '*'
      ? tokenRoleOn(issuer, '*')
      : tokenRoleOn(issuer, cap.name);
    if (held === null) {
      return `the issuing token does not reach project "${cap.name}"`;
    }
    if (!roleSatisfies(held, granted)) {
      return `cannot grant "${granted}" on "${cap.name}"; the issuing token holds "${held}" there`;
    }
  }
  return null;
}

/**
 * True when every project `target` reaches is one `caller` administers, so the
 * caller may see, revoke or rotate it. A wildcard target needs a wildcard
 * caller.
 */
export function withinCallerScope(
  caller: Pick<TokenRecord, 'role' | 'projects'>,
  target: Pick<TokenRecord, 'projects'>,
): boolean {
  for (const cap of target.projects) {
    if (cap.name === '*') {
      if (!holdsWildcard(caller)) return false;
      const held = tokenRoleOn(caller, '*');
      if (held === null || !roleSatisfies(held, 'admin')) return false;
      continue;
    }
    const held = tokenRoleOn(caller, cap.name);
    if (held === null || !roleSatisfies(held, 'admin')) return false;
  }
  return true;
}
