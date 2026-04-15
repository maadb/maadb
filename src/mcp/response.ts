// ============================================================================
// MCP Response Contract — standard { ok, data|errors } shape for all tools
// Provenance mode injects _source metadata when enabled.
// ============================================================================

import type { Result, MaadError } from '../errors.js';
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
}

interface ErrorResponse {
  ok: false;
  errors: Array<{ code: string; message: string; details?: Record<string, unknown> }>;
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
