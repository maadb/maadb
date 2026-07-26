// ============================================================================
// MAAD Error Types and Result Pattern
// The engine never throws. Every stage returns Result<T, MaadError[]>.
// ============================================================================

import type { SourceLocation } from './types.js';

export type ErrorCode =
  | 'FILE_NOT_FOUND'
  | 'FILE_READ_ERROR'
  | 'PARSE_ERROR'
  | 'YAML_PROFILE_VIOLATION'
  | 'REGISTRY_INVALID'
  | 'REGISTRY_NOT_FOUND'
  | 'SCHEMA_NOT_FOUND'
  | 'SCHEMA_INVALID'
  | 'VALIDATION_FAILED'
  | 'REF_NOT_FOUND'
  | 'DUPLICATE_DOC_ID'
  | 'DUPLICATE_PREFIX'
  | 'VERSION_CONFLICT'
  | 'GIT_ERROR'
  | 'GIT_NOT_INITIALIZED'
  | 'BACKEND_ERROR'
  | 'UNKNOWN_TYPE'
  | 'INVALID_DOC_ID'
  | 'WRITE_ERROR'
  | 'DELETE_ERROR'
  | 'READ_ONLY'
  | 'PATH_OUTSIDE_PROJECT'
  | 'INVALID_FIELDS'
  | 'FRONTMATTER_GUARD'
  | 'INSTANCE_CONFIG_INVALID'
  | 'INSTANCE_CONFIG_NOT_FOUND'
  | 'PROJECT_UNKNOWN'
  | 'PROJECT_REQUIRED'
  | 'PROJECT_NOT_WHITELISTED'
  | 'SESSION_UNBOUND'
  | 'SESSION_ALREADY_BOUND'
  | 'INSUFFICIENT_ROLE'
  | 'ROLE_UPGRADE_DENIED'
  | 'WRITE_TIMEOUT'
  | 'SHUTTING_DOWN'
  | 'RATE_LIMITED'
  | 'REQUEST_TIMEOUT'
  | 'MISSING_OPERATION_KIND'
  | 'PIN_PROJECT_INVALID'
  | 'PIN_PROJECT_NOT_FOUND'
  | 'PIN_ON_EXISTING_SESSION'
  | 'SESSION_PINNED'
  | 'INSTANCE_RELOAD_IN_PROGRESS'
  | 'INSTANCE_RELOAD_FAILED'
  | 'INSTANCE_MUTATION_UNSUPPORTED'
  | 'INSTANCE_RELOAD_SYNTHETIC'
  | 'SESSION_CANCELLED'
  | 'TOKENS_FILE_MISSING'
  | 'TOKENS_FILE_INVALID'
  | 'TOKENS_FILE_EMPTY'
  | 'TOKEN_UNKNOWN'
  | 'TOKEN_REVOKED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_MALFORMED'
  | 'TOKEN_PROJECT_FORBIDDEN'
  | 'TOKEN_PROJECT_UNKNOWN'
  | 'TOKEN_ROLE_ABOVE_GLOBAL'
  | 'TOKEN_IDENTITY_REQUIRED'
  | 'TOKEN_NOT_FOUND'
  | 'LEGACY_BEARER_REMOVED'
  // 0.7.1 — agent-first aggregate capabilities
  | 'RESPONSE_TOO_LARGE'
  | 'CURSOR_INVALID'
  | 'SCHEMA_REF_CHAIN_INVALID'
  | 'FILTER_BETWEEN_INVALID'
  | 'FILTER_EMPTY_ARRAY'
  | 'FILTER_OP_INVALID'
  // 0.7.3 — engine-side flood-control safety floor
  | 'BULK_LIMIT_EXCEEDED'
  // 0.7.10 — confirm contract for destructive tools
  | 'CONFIRM_REQUIRED'
  // 0.7.10 — maad_backup: git-tag snapshot lifecycle
  | 'TAG_EXISTS'
  | 'TAG_NOT_FOUND'
  | 'NO_HEAD_COMMIT'
  // 0.7.10 — maad_repair_where: tolerant-only repair contract. Records whose
  // schema drift would require type coercion (which is migration, not
  // repair) surface as this code so a future migration tool can handle them.
  | 'REPAIR_REQUIRES_MIGRATION'
  // 0.7.11 — maad_search boundary rejects unknown primitive values up front
  // instead of silently returning zero rows from a SQL miss on the column.
  | 'INVALID_PRIMITIVE'
  // 0.7.12 — maad_query.sortBy must be a system sort key (updated_at,
  // indexed_at, doc_id, doc_type, created_at and camelCase aliases) or an
  // indexed schema field of the requested docType. Unknown/unindexed sort
  // keys reject up front instead of silently degrading to all-NULL ordering.
  | 'UNSUPPORTED_SORT_FIELD'
  // 0.7.13 — per-doc index-time size guard. A single oversized document can
  // allocate many times its byte size in V8 heap during extract/materialize
  // (parsed annotations + objects + relationships + field index + SQLite
  // params all live at once), enough to FATAL the whole engine process on a
  // memory-capped deployment. indexFile skips such a doc with this code
  // instead, leaving every other project on the engine alive.
  | 'DOC_TOO_LARGE'
  // 0.7.18 — engine self-defense. A heavy maintenance op (reindex / reload /
  // schema / summary) is refused up front when free heap headroom is below
  // the configured floor, so a misbehaving background caller that hammers
  // these ops sheds load (retryable) instead of OOM-crash-looping the engine.
  | 'OVERLOADED'
  // 0.8.0 — semantic retrieval. INVALID_MODE: maad_semantic_search.mode must be
  // exact | hybrid | semantic. SEMANTIC_DISABLED: the tool was called but
  // MAAD_SEMANTIC_ENABLE is off / the vector index never loaded.
  | 'INVALID_MODE'
  | 'SEMANTIC_DISABLED'
  // 0.8.4 — boot false-empty guard. A persisted index reporting zero documents
  // while registered paths hold markdown on disk means the derived index was
  // never built or was lost (fresh clone, volume-restore, wiped _backend), not
  // a genuinely empty project. Serving it would silently return [] from every
  // list/search/query, so the engine refuses to serve until the index is
  // rebuilt (explicit reindex, or MAAD_BOOT_REINDEX=1 to rebuild at boot).
  | 'INDEX_EMPTY';

export interface MaadError {
  code: ErrorCode;
  message: string;
  location?: SourceLocation | undefined;
  details?: Record<string, unknown> | undefined;
}

export type Result<T, E = MaadError[]> =
  | { ok: true; value: T }
  | { ok: false; errors: E };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T>(errors: MaadError[]): Result<T> {
  return { ok: false, errors };
}

export function singleErr<T>(code: ErrorCode, message: string, location?: SourceLocation, details?: Record<string, unknown>): Result<T> {
  return { ok: false, errors: [{ code, message, location, details }] };
}

export function maadError(code: ErrorCode, message: string, location?: SourceLocation, details?: Record<string, unknown>): MaadError {
  return { code, message, location, details };
}
