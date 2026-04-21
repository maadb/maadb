// ============================================================================
// MCP Roles — role definitions and tool filtering
// ============================================================================

export type Role = 'reader' | 'writer' | 'admin';

const READER_TOOLS = [
  'maad_scan', 'maad_summary', 'maad_describe',
  'maad_get', 'maad_query', 'maad_search', 'maad_related', 'maad_schema', 'maad_aggregate', 'maad_join',
  'maad_verify', 'maad_changes_since',
  'maad_history', 'maad_audit',
] as const;

const WRITER_TOOLS = [
  ...READER_TOOLS,
  'maad_create', 'maad_update', 'maad_validate', 'maad_bulk_create', 'maad_bulk_update',
] as const;

const ADMIN_TOOLS = [
  ...WRITER_TOOLS,
  'maad_delete', 'maad_reindex', 'maad_reload', 'maad_health',
  'maad_instance_reload',
] as const;

const ROLE_TOOLS: Record<Role, readonly string[]> = {
  reader: READER_TOOLS,
  writer: WRITER_TOOLS,
  admin: ADMIN_TOOLS,
};

export function getToolsForRole(role: Role): ReadonlySet<string> {
  return new Set(ROLE_TOOLS[role]);
}

export function parseRole(raw: string | undefined): Role {
  if (raw === 'reader' || raw === 'writer' || raw === 'admin') return raw;
  return 'reader'; // default: least privilege
}

const ROLE_RANK: Record<Role, number> = { reader: 0, writer: 1, admin: 2 };

// Returns true if `have` satisfies at least the level of `need`.
export function roleSatisfies(have: Role, need: Role): boolean {
  return ROLE_RANK[have] >= ROLE_RANK[need];
}

// Returns the more restrictive of two roles.
export function minRole(a: Role, b: Role): Role {
  return ROLE_RANK[a] <= ROLE_RANK[b] ? a : b;
}

// Inverse of getToolsForRole: for a given tool name, what's the minimum role
// that can call it? Returns null for unknown tools.
export function getMinRoleForTool(toolName: string): Role | null {
  if ((READER_TOOLS as readonly string[]).includes(toolName)) return 'reader';
  if ((WRITER_TOOLS as readonly string[]).includes(toolName)) return 'writer';
  if ((ADMIN_TOOLS as readonly string[]).includes(toolName)) return 'admin';
  return null;
}
