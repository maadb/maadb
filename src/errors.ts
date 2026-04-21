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
  | 'SESSION_CANCELLED';

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
