// ============================================================================
// Tool annotations — one table for every MCP tool the server registers.
//
// MCP clients use these hints to decide how to present a tool and whether
// to ask before calling it. Claude's connector and plugin directories also
// require a `title` plus an explicit `readOnlyHint` / `destructiveHint` on
// every tool.
//
// `annotateRegistrations` patches `server.registerTool` so every registration
// takes its annotations from this table. A tool missing from the table fails
// at registration, so a new tool cannot ship without them.
// tests/mcp/annotations.test.ts cross-checks this table against kinds.ts and
// against the tools the server actually registers.
// ============================================================================

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

type Hints = Required<Pick<ToolAnnotations, 'title' | 'readOnlyHint' | 'destructiveHint' | 'idempotentHint' | 'openWorldHint'>>;

// Reads: no change to records, index, git or session state beyond the call.
const read = (title: string): Hints =>
  ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });

// Writes that add or rebuild data without removing or overwriting any.
const additive = (title: string, idempotent = false): Hints =>
  ({ title, readOnlyHint: false, destructiveHint: false, idempotentHint: idempotent, openWorldHint: false });

// Writes that can overwrite or remove data, or revoke access.
const destructive = (title: string, idempotent = false): Hints =>
  ({ title, readOnlyHint: false, destructiveHint: true, idempotentHint: idempotent, openWorldHint: false });

export const TOOL_ANNOTATIONS: Readonly<Record<string, Hints>> = Object.freeze({
  // Session and instance (engine-less). Binding a session or subscribing to
  // notifications changes only the caller's own session, not stored data.
  maad_projects: read('List projects'),
  maad_use_project: read('Use a project'),
  maad_use_projects: read('Use several projects'),
  maad_current_session: read('Show current session'),
  maad_subscribe: read('Subscribe to record changes'),
  maad_unsubscribe: read('Unsubscribe from record changes'),
  maad_subscriptions: read('List subscriptions'),
  maad_instance_reload: destructive('Reload instance config', true),

  // Discovery and reads.
  maad_summary: read('Summarize project'),
  maad_describe: read('Describe project'),
  maad_scan: read('Scan markdown files'),
  maad_schema: read('Read schema'),
  maad_get: read('Get record'),
  maad_query: read('Query records'),
  maad_search: read('Search extracted objects'),
  maad_semantic_search: read('Semantic search'),
  maad_related: read('Find related records'),
  maad_relationship_paths: read('Find relationship paths'),
  maad_aggregate: read('Aggregate records'),
  maad_join: read('Join records'),
  maad_verify: read('Verify facts or index'),
  maad_validate: read('Validate records'),
  maad_find_orphans: read('Find orphaned references'),
  maad_changes_since: read('List changes since'),
  maad_history: read('Record history'),
  maad_audit: read('Project activity log'),
  maad_health: read('Engine health'),
  maad_document_receipt: read('Document receipt'),
  maad_create_contract: read('Create contract'),

  // Writes.
  maad_create: additive('Create record'),
  maad_create_guarded: additive('Create record (guarded)'),
  maad_bulk_create: additive('Create records in bulk'),
  maad_update: destructive('Update record'),
  maad_bulk_update: destructive('Update records in bulk'),
  maad_delete: destructive('Delete record'),
  maad_bulk_delete: destructive('Delete records in bulk'),
  maad_delete_where: destructive('Delete records by filter'),
  maad_purge_soft_deleted: destructive('Purge soft-deleted records'),
  maad_repair_where: destructive('Repair records by filter'),

  // Maintenance.
  maad_reindex: additive('Rebuild index', true),
  maad_reload: additive('Reload engine', true),
  maad_flush: additive('Flush history writes', true),
  maad_backup: destructive('Manage backup snapshots'),
  // refresh with force=true replaces user-edited instruction files.
  maad_instructions: destructive('Check or refresh instructions', true),

  // Token registry.
  maad_list_tokens: read('List tokens'),
  maad_show_token: read('Show token'),
  maad_issue_token: additive('Issue token'),
  maad_rotate_token: destructive('Rotate token'),
  maad_revoke_token: destructive('Revoke token', true),
});

export function annotationsFor(name: string): Hints | undefined {
  return TOOL_ANNOTATIONS[name];
}

/**
 * Patch `server.registerTool` so each registration carries the table's
 * annotations. Throws for a tool the table does not list.
 */
export function annotateRegistrations(server: McpServer): McpServer {
  const original = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  (server as unknown as { registerTool: (...args: unknown[]) => unknown }).registerTool =
    (name: unknown, config: unknown, ...rest: unknown[]) => {
      const hints = typeof name === 'string' ? annotationsFor(name) : undefined;
      if (!hints) throw new Error(`MISSING_TOOL_ANNOTATIONS: add "${String(name)}" to src/mcp/annotations.ts`);
      const base = (config ?? {}) as Record<string, unknown>;
      return original(name, { ...base, title: base.title ?? hints.title, annotations: { ...hints } }, ...rest);
    };
  return server;
}
