// ============================================================================
// Operation kind metadata — every MCP tool that flows through `withEngine`
// declares read vs write. Reads invoke the handler directly; writes wrap it
// in `engine.runExclusive` so the per-engine FIFO mutex serializes them.
//
// The classification is the source of truth at the request boundary. The
// engine itself no longer self-wraps its mutation methods (0.5.0 R4) — the
// mutex lives at the MCP entry point where concurrency policy belongs.
//
// Missing annotations are caught at:
//   - module load (disjointness assertion below)
//   - runtime in `withEngine` (MISSING_OPERATION_KIND for any tool that
//     passes through without a registered kind)
//   - CI (tests/mcp/kinds.test.ts cross-checks against registered tools)
// ============================================================================

export type OperationKind = 'read' | 'write';

// Tools that flow through withEngine and do not mutate git / SQLite /
// in-memory cache / filesystem state.
export const READ_TOOLS: ReadonlySet<string> = new Set([
  'maad_get',
  'maad_query',
  'maad_search',
  'maad_related',
  'maad_schema',
  'maad_aggregate',
  'maad_verify',
  'maad_join',
  'maad_changes_since',
  'maad_history',
  'maad_audit',
  'maad_scan',
  'maad_summary',
  'maad_describe',
  'maad_validate',
  'maad_health',
]);

// Tools that flow through withEngine and may mutate engine state. Must
// acquire the write mutex.
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'maad_create',
  'maad_update',
  'maad_bulk_create',
  'maad_bulk_update',
  'maad_delete',
  'maad_reindex',
  'maad_reload',
]);

// Tools that do not flow through withEngine — they operate on session /
// instance state only and never resolve an engine. OperationKind does not
// apply. Listed here so kind-coverage assertions know to skip them.
export const ENGINE_LESS_TOOLS: ReadonlySet<string> = new Set([
  'maad_projects',
  'maad_use_project',
  'maad_use_projects',
  'maad_current_session',
  'maad_instance_reload',
  'maad_subscribe',
  'maad_unsubscribe',
]);

// Assert the three sets are disjoint. A tool belongs to exactly one bucket.
// Runs at module load — a bad entry crashes the process at startup rather
// than silently shipping.
(function assertDisjoint(): void {
  const seen = new Map<string, string>();
  const register = (bucket: string, names: ReadonlySet<string>) => {
    for (const name of names) {
      const prev = seen.get(name);
      if (prev) {
        throw new Error(`kinds.ts: tool "${name}" listed in both "${prev}" and "${bucket}"`);
      }
      seen.set(name, bucket);
    }
  };
  register('READ_TOOLS', READ_TOOLS);
  register('WRITE_TOOLS', WRITE_TOOLS);
  register('ENGINE_LESS_TOOLS', ENGINE_LESS_TOOLS);
})();

/**
 * Returns the operation kind for a tool that flows through `withEngine`.
 * Returns null for engine-less tools OR unknown names — callers must
 * distinguish via {@link isEngineLess}.
 */
export function getKindForTool(name: string): OperationKind | null {
  if (READ_TOOLS.has(name)) return 'read';
  if (WRITE_TOOLS.has(name)) return 'write';
  return null;
}

/**
 * True if the tool is instance/session-scoped and does not pass through
 * `withEngine`. Callers using {@link getKindForTool} should check this
 * before treating a null return as "missing annotation".
 */
export function isEngineLess(name: string): boolean {
  return ENGINE_LESS_TOOLS.has(name);
}

/**
 * Every engine-bound tool name currently registered. Used by CI tests that
 * cross-check against the MCP server's actual registrations to catch drift.
 */
export function allEngineToolNames(): string[] {
  return [...READ_TOOLS, ...WRITE_TOOLS];
}
