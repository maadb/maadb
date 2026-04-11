// ============================================================================
// MCP Roles — role definitions and tool filtering
// ============================================================================

export type Role = 'reader' | 'writer' | 'admin';

const READER_TOOLS = [
  'maad_scan', 'maad_summary', 'maad_describe',
  'maad_get', 'maad_query', 'maad_search', 'maad_related', 'maad_schema', 'maad_aggregate', 'maad_join',
  'maad_history', 'maad_audit',
] as const;

const WRITER_TOOLS = [
  ...READER_TOOLS,
  'maad_create', 'maad_update', 'maad_validate', 'maad_bulk_create', 'maad_bulk_update',
] as const;

const ADMIN_TOOLS = [
  ...WRITER_TOOLS,
  'maad_delete', 'maad_reindex', 'maad_reload', 'maad_health',
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
