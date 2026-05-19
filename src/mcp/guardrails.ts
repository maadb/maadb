// ============================================================================
// AI Guardrails — tool allowlists, dry-run, audit logging
// ============================================================================

import { logger } from '../engine/logger.js';
import type { MaadError } from '../errors.js';

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
 * Audit-log marker for whether a destructive call ran as dry-run or confirmed.
 * Stamped on the audit payload via auditToolCall's `extras` argument so
 * post-hoc audit can distinguish exploration from action.
 */
export type ConfirmMode = 'dry_run' | 'confirmed';

/**
 * Confirm-contract guard for destructive tools (0.7.10).
 *
 * Returns null when args.confirm === true (caller has authorized mutation),
 * otherwise returns a CONFIRM_REQUIRED MaadError. Boolean strictness — no
 * truthy coercion; only literal true authorizes mutation. Callers decide
 * whether to surface the error or return a dry-run response carrying the
 * affected set. Spec default is the dry-run path.
 */
export function requireConfirm(args: { confirm?: unknown }): MaadError | null {
  if (args.confirm === true) return null;
  return {
    code: 'CONFIRM_REQUIRED',
    message: 'Mutation requires explicit confirm: true. Without it, the tool returns the would-affect result set without side effects.',
  };
}

/**
 * Log every tool call for audit trail. Optional `extras` lets destructive
 * tools stamp confirm_mode (and future fields) on the audit payload without
 * needing a separate writer.
 *
 * **Logging contract.** Pino is telemetry, not a content archive. Raw document
 * bodies live in MAADB storage + git history; this helper projects body and
 * appendBody fields into byte counts (`bodyBytes`, `appendBodyBytes`) before
 * the log line is emitted. Frontmatter `fields` objects collapse to
 * `fieldNames` (keys only — values stay out of pino). Bulk `records` /
 * `updates` arrays collapse to counts and per-element body byte counts.
 * Other small scalars (docId, docType, project, expectedVersion,
 * idempotencyKey, confirm) pass through verbatim. The pino layer also redacts
 * any leftover `args.body` / `args.appendBody` / `args.records[*].body` etc.
 * paths as defense in depth (see src/logging.ts REDACT_PATHS).
 */
export function auditToolCall(
  toolName: string,
  args: Record<string, unknown>,
  extras?: Record<string, unknown>,
): void {
  const projected = projectAuditArgs(args);
  logger.info('mcp', 'tool_call', `${toolName}`, extras ? { args: projected, ...extras } : { args: projected });
}

function projectAuditArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'body' && typeof v === 'string') {
      out.bodyBytes = Buffer.byteLength(v, 'utf8');
      continue;
    }
    if (k === 'appendBody' && typeof v === 'string') {
      out.appendBodyBytes = Buffer.byteLength(v, 'utf8');
      continue;
    }
    if (k === 'fields' && v && typeof v === 'object' && !Array.isArray(v)) {
      out.fieldNames = Object.keys(v as Record<string, unknown>);
      continue;
    }
    if (k === 'records' && Array.isArray(v)) {
      out.recordCount = v.length;
      out.recordBodyBytes = v.reduce((sum: number, r: unknown) => {
        if (r && typeof r === 'object') {
          const body = (r as Record<string, unknown>).body;
          if (typeof body === 'string') return sum + Buffer.byteLength(body, 'utf8');
        }
        return sum;
      }, 0);
      continue;
    }
    if (k === 'updates' && Array.isArray(v)) {
      out.updateCount = v.length;
      let body = 0;
      let append = 0;
      for (const u of v) {
        if (u && typeof u === 'object') {
          const b = (u as Record<string, unknown>).body;
          const a = (u as Record<string, unknown>).appendBody;
          if (typeof b === 'string') body += Buffer.byteLength(b, 'utf8');
          if (typeof a === 'string') append += Buffer.byteLength(a, 'utf8');
        }
      }
      out.updateBodyBytes = body;
      out.updateAppendBodyBytes = append;
      continue;
    }
    out[k] = v;
  }
  return out;
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
