// ============================================================================
// MCP Response Contract — standard { ok, data|errors } shape for all tools
// Provenance mode injects _source metadata when enabled.
// ============================================================================

import type { Result, MaadError } from '../errors.js';
import type { ValidationWarning } from '../types.js';
import type { ProvenanceMode } from './config.js';

let provenanceMode: ProvenanceMode = 'off';

export function setProvenanceMode(mode: ProvenanceMode): void {
  provenanceMode = mode;
}

export function getProvenanceMode(): ProvenanceMode {
  return provenanceMode;
}

interface SuccessResponse {
  ok: true;
  data: unknown;
  _source?: string;
  _meta?: Record<string, unknown>;
}

interface ErrorResponse {
  ok: false;
  errors: Array<{ code: string; message: string; details?: Record<string, unknown> }>;
  _meta?: Record<string, unknown>;
}

type McpResponse = SuccessResponse | ErrorResponse;

export function successResponse(data: unknown, toolName?: string): { content: Array<{ type: 'text'; text: string }> } {
  const response: McpResponse = { ok: true, data };
  if (provenanceMode !== 'off' && toolName) {
    response._source = toolName;
  }
  return { content: [{ type: 'text', text: JSON.stringify(response) }] };
}

export function errorResponse(errors: MaadError[]): { content: Array<{ type: 'text'; text: string }> } {
  const response: McpResponse = {
    ok: false,
    errors: errors.map(e => {
      const base: { code: string; message: string; details?: Record<string, unknown> } = {
        code: e.code,
        message: e.message,
      };
      if (e.details !== undefined) base.details = e.details;
      return base;
    }),
  };
  return { content: [{ type: 'text', text: JSON.stringify(response) }] };
}

export function resultToResponse<T>(result: Result<T>, toolName?: string): { content: Array<{ type: 'text'; text: string }> } {
  if (result.ok) return successResponse(result.value, toolName);
  return errorResponse(result.errors);
}

/**
 * Attach or merge fields into `_meta` on an already-serialized tool response.
 * Used by the MCP wrapper to stamp request_id onto every response so clients
 * can quote it in bug reports. Non-breaking (MCP allows extra fields).
 */
export function attachMeta(
  response: { content: Array<{ type: 'text'; text: string }> },
  meta: Record<string, unknown>,
): { content: Array<{ type: 'text'; text: string }> } {
  const first = response.content[0];
  if (!first || first.type !== 'text') return response;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(first.text) as Record<string, unknown>;
  } catch {
    return response;
  }

  const existing = (parsed._meta as Record<string, unknown> | undefined) ?? {};
  parsed._meta = { ...existing, ...meta };
  return { content: [{ type: 'text', text: JSON.stringify(parsed) }] };
}

/**
 * Attach validation warnings to `_meta.warnings[]`. No-op when the input is
 * empty or undefined — avoids polluting responses for writes that produced
 * no warnings. Used by write-tool handlers (maad_create / maad_update /
 * maad_bulk_*) after a successful engine call.
 */
export function attachWarnings(
  response: { content: Array<{ type: 'text'; text: string }> },
  warnings: ValidationWarning[] | undefined,
): { content: Array<{ type: 'text'; text: string }> } {
  if (!warnings || warnings.length === 0) return response;
  return attachMeta(response, { warnings });
}

/**
 * 0.6.10 — Stamp commit-durability signals onto a write response. Always
 * attaches `write_durable`. When the commit failed (write landed on disk
 * but the git commit didn't), also attaches `commit_failure` with the
 * action / code / message so the client can log forensics or retry.
 * `write_durable: true` attaches nothing else — existing clients that
 * ignore `_meta` see zero behavioral change.
 */
export function attachDurability(
  response: { content: Array<{ type: 'text'; text: string }> },
  writeDurable: boolean,
  commitFailure: { code: string; message: string; action: 'create' | 'update' | 'delete' } | undefined,
): { content: Array<{ type: 'text'; text: string }> } {
  if (writeDurable) return attachMeta(response, { write_durable: true });
  const meta: Record<string, unknown> = { write_durable: false };
  if (commitFailure) meta['commit_failure'] = commitFailure;
  return attachMeta(response, meta);
}
