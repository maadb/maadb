// ============================================================================
// AI Guardrails — tool allowlists, dry-run, audit logging
// ============================================================================

import { logger } from '../engine/logger.js';

export interface GuardrailConfig {
  dryRun?: boolean | undefined;
  toolAllowlist?: string[] | undefined;
}

let config: GuardrailConfig = {};

export function setGuardrailConfig(c: GuardrailConfig): void {
  config = c;
}

export function isDryRun(): boolean {
  return config.dryRun ?? false;
}

export function isToolAllowed(toolName: string): boolean {
  if (!config.toolAllowlist || config.toolAllowlist.length === 0) return true;
  return config.toolAllowlist.includes(toolName);
}

/**
 * Log every tool call for audit trail.
 */
export function auditToolCall(toolName: string, args: Record<string, unknown>): void {
  logger.info('mcp', 'tool_call', `${toolName}`, { args });
}

/**
 * Dry-run response: returns what would happen without executing.
 */
export function dryRunResponse(toolName: string, args: Record<string, unknown>): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        ok: true,
        dryRun: true,
        tool: toolName,
        wouldExecute: args,
      }),
    }],
  };
}
