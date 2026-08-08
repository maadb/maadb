// ============================================================================
// History-mode tools — explicit batch/snapshot flush boundary
// ============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MaadEngine } from '../../engine/index.js';
import type { HistoryFlushTrigger, HistoryMode } from '../../history/types.js';
import { maadError, type MaadError } from '../../errors.js';
import type { InstanceCtx } from '../ctx.js';
import { auditToolCall, dryRunResponse, isDryRun } from '../guardrails.js';
import { errorResponse, successResponse } from '../response.js';
import { withEngine } from '../with-session.js';

export interface HistoryFlushView {
  effectiveMode: HistoryMode;
  trigger: HistoryFlushTrigger;
  status: 'committed' | 'noop';
  pendingWrites: number;
  flushed: boolean;
  sha?: string;
}

export type HistoryFlushBoundaryResult =
  | { ok: true; value: HistoryFlushView }
  | { ok: false; error: MaadError };

const FLUSHING_MODES: ReadonlySet<HistoryMode> = new Set(['batch', 'snapshot']);

/**
 * Public flush boundary shared by MCP, CLI, and snapshot backup creation.
 * Audit/feed/read are explicit no-ops; only batch/snapshot drain pending work.
 */
export async function flushHistoryBoundary(
  engine: MaadEngine,
  trigger: HistoryFlushTrigger = 'explicit',
): Promise<HistoryFlushBoundaryResult> {
  const before = engine.health().history;
  if (!FLUSHING_MODES.has(before.effectiveMode)) {
    return {
      ok: true,
      value: {
        effectiveMode: before.effectiveMode,
        trigger,
        status: 'noop',
        pendingWrites: before.pendingWrites,
        flushed: false,
      },
    };
  }

  const result = await engine.flushHistory(trigger);
  if (result.outcome.status === 'failed') {
    const publicCode = result.outcome.code === 'GIT_NOT_INITIALIZED'
      ? 'GIT_NOT_INITIALIZED'
      : 'GIT_ERROR';
    return {
      ok: false,
      error: maadError(publicCode, result.outcome.message, undefined, {
        historyCode: result.outcome.code,
        effectiveMode: before.effectiveMode,
        trigger: result.trigger,
        pendingWrites: result.pendingWrites,
      }),
    };
  }

  const value: HistoryFlushView = {
    effectiveMode: before.effectiveMode,
    trigger: result.trigger,
    status: result.outcome.status,
    pendingWrites: result.pendingWrites,
    flushed: result.outcome.status === 'committed',
  };
  if (result.outcome.status === 'committed') value.sha = result.outcome.sha as string;
  return { ok: true, value };
}

export function register(server: McpServer, ctx: InstanceCtx): number {
  server.registerTool('maad_flush', {
    description: 'Flush pending history writes for batch or snapshot mode. Returns an explicit no-op in audit, feed, and read modes. Requires admin.',
    inputSchema: z.object({
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_flush', args, async ({ engine }) => {
    auditToolCall('maad_flush', args);
    if (isDryRun()) return dryRunResponse('maad_flush', args);

    const result = await flushHistoryBoundary(engine);
    return result.ok
      ? successResponse(result.value, 'maad_flush')
      : errorResponse([result.error]);
  }));

  return 1;
}
