// ============================================================================
// MCP Roles — role definitions and tool filtering
// ============================================================================

export type Role = 'reader' | 'writer' | 'admin';

const READER_TOOLS = [
  'maad.scan', 'maad.summary', 'maad.describe',
  'maad.get', 'maad.query', 'maad.search', 'maad.related', 'maad.schema', 'maad.aggregate', 'maad.join',
  'maad.history', 'maad.audit',
] as const;

const WRITER_TOOLS = [
  ...READER_TOOLS,
  'maad.create', 'maad.update', 'maad.validate', 'maad.bulk_create', 'maad.bulk_update',
] as const;

const ADMIN_TOOLS = [
  ...WRITER_TOOLS,
  'maad.delete', 'maad.reindex', 'maad.reload', 'maad.health',
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
