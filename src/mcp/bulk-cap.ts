// ============================================================================
// Bulk-tool item-count cap (0.7.3).
//
// Defense-in-depth flood control for maad_bulk_create / maad_bulk_update.
// Independent of per-session write rate limits — those throttle frequency,
// this caps per-request blast radius. Also bounds memory cost of bulk results
// (per-record validation reports, audit events, notification fanouts).
//
// Default cap: 50. Configurable via MAAD_BULK_MAX_ITEMS, clamped to [1, 1000]
// to keep the floor meaningful even under operator misconfiguration.
// ============================================================================

const DEFAULT_BULK_MAX = 50;
const HARD_BULK_MAX = 1000;

export function getBulkMaxItems(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MAAD_BULK_MAX_ITEMS;
  if (!raw) return DEFAULT_BULK_MAX;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_BULK_MAX;
  if (n > HARD_BULK_MAX) return HARD_BULK_MAX;
  return n;
}

export interface BulkCapRejection {
  tool: string;
  received: number;
  limit: number;
  suggestedChunkSize: number;
  message: string;
}

export function checkBulkSize(
  toolName: string,
  count: number,
  env: NodeJS.ProcessEnv = process.env,
): BulkCapRejection | null {
  const max = getBulkMaxItems(env);
  if (count <= max) return null;
  return {
    tool: toolName,
    received: count,
    limit: max,
    suggestedChunkSize: max,
    message: `${toolName} accepts at most ${max} items per call (received ${count}). Split into chunks of <= ${max}.`,
  };
}

// ----------------------------------------------------------------------------
// 0.7.10 — Destructive-cleanup per-tool record caps. Per spec
// docs/specs/0.7.10-integrity-cleanup.md §confirm-contract: default 100,
// hard ceiling 1000. Per-tool env override:
// `MAAD_CLEANUP_MAX_RECORDS_<TOOL_SUFFIX>` (uppercase, e.g.
// `MAAD_CLEANUP_MAX_RECORDS_BULK_DELETE`). Tool-call arg primary, env
// secondary, default tertiary.
// ----------------------------------------------------------------------------

const DEFAULT_CLEANUP_MAX = 100;
const HARD_CLEANUP_MAX = 1000;

export function resolveCleanupMaxRecords(
  toolSuffix: string,
  argValue: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (argValue !== undefined && Number.isFinite(argValue) && argValue >= 1) {
    return Math.min(Math.floor(argValue), HARD_CLEANUP_MAX);
  }
  const envKey = `MAAD_CLEANUP_MAX_RECORDS_${toolSuffix.toUpperCase()}`;
  const raw = env[envKey];
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1) {
      return Math.min(n, HARD_CLEANUP_MAX);
    }
  }
  return DEFAULT_CLEANUP_MAX;
}

export function checkCleanupSize(
  toolName: string,
  count: number,
  maxRecords: number,
): BulkCapRejection | null {
  if (count <= maxRecords) return null;
  return {
    tool: toolName,
    received: count,
    limit: maxRecords,
    suggestedChunkSize: maxRecords,
    message: `${toolName} would affect ${count} records but the limit is ${maxRecords}. Tighten the scope, raise maxRecords (cap ${HARD_CLEANUP_MAX}), or chunk the operation.`,
  };
}
