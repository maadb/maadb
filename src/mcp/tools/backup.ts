// ============================================================================
// 0.7.10 — maad_backup MCP tool. Admin-tier, write-kind (mutates git refs).
//
// Three modes in one tool (per spec lock):
//   create  — annotated tag on HEAD, returns { tag, sha, message, createdAt }
//   list    — every maad-snapshot-* tag, optional since: ISO8601 filter
//   delete  — drop a maad-snapshot-* tag (refuses other tags)
//
// No confirm contract — tag operations don't destroy underlying commits. The
// explicit mode arg + named tag is the intent gate.
// ============================================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { errorResponse, resultToResponse } from '../response.js';
import { withEngine } from '../with-session.js';
import type { InstanceCtx } from '../ctx.js';
import { flushHistoryBoundary } from './history-mode.js';

export function register(server: McpServer, ctx: InstanceCtx): number {
  server.registerTool('maad_backup', {
    description: 'Create / list / delete named recovery anchors via annotated git tags. Tag format: maad-snapshot-YYYY-MM-DD-HHMM[-label] (UTC). Defaults to mode: "create" so the common case is a one-arg call. delete only operates on maad-snapshot-* tags; non-snapshot tags are refused. Underlying commits are never touched — deleting a tag just drops the label.',
    inputSchema: z.object({
      mode: z.enum(['create', 'list', 'delete']).optional().describe('Operation mode (default: "create")'),
      label: z.string().optional().describe('create only — operator-supplied suffix, sanitized to [a-z0-9-] capped at 32 chars'),
      message: z.string().optional().describe('create only — annotated tag message (defaults to "MAADB snapshot at <sha> (\'<branch>\')")'),
      tag: z.string().optional().describe('delete only — exact tag name to remove'),
      since: z.string().optional().describe('list only — ISO8601 timestamp; return only tags created at or after this point'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_backup', args, async ({ engine }) => {
    const mode = args.mode ?? 'create';

    if (mode === 'create') {
      if (engine.health().history.effectiveMode === 'snapshot') {
        const flush = await flushHistoryBoundary(engine, 'snapshot');
        if (!flush.ok) return errorResponse([flush.error]);
      }
      const opts: import('../../engine/types.js').CreateBackupOptions = {};
      if (args.label !== undefined) opts.label = args.label;
      if (args.message !== undefined) opts.message = args.message;
      return resultToResponse(await engine.backupCreate(opts), 'maad_backup');
    }

    if (mode === 'list') {
      const opts: import('../../engine/types.js').ListBackupsOptions = {};
      if (args.since !== undefined) opts.since = args.since;
      return resultToResponse(await engine.backupList(opts), 'maad_backup');
    }

    if (mode === 'delete') {
      if (!args.tag) {
        return resultToResponse(
          { ok: false, errors: [{ code: 'INVALID_ARGS', message: 'delete mode requires tag' }] } as never,
          'maad_backup',
        );
      }
      return resultToResponse(await engine.backupDelete(args.tag), 'maad_backup');
    }

    return resultToResponse(
      { ok: false, errors: [{ code: 'INVALID_ARGS', message: 'mode must be "create", "list", or "delete"' }] } as never,
      'maad_backup',
    );
  }));

  return 1;
}
