// ============================================================================
// Audit — history, diff, snapshot, audit (git-backed)
// ============================================================================

import path from 'node:path';

import { ok, singleErr, type Result } from '../errors.js';
import {
  filePath as toFilePath,
  type DocId,
  type DocType,
  type ParsedCommit,
  type AuditEntry,
  type DiffResult,
  type SnapshotResult,
} from '../types.js';
import type { EngineContext } from './context.js';

function unavailable<T>(ctx: EngineContext): Result<T> {
  const mode = ctx.history?.config.effectiveMode;
  if (mode === 'feed' || mode === 'read') {
    return singleErr(
      'HISTORY_DISABLED',
      `Git history is unavailable in history_mode ${mode}`,
      undefined,
      { historyMode: mode },
    );
  }
  return singleErr('GIT_NOT_INITIALIZED', 'Git is not available in this project');
}

export async function history(
  ctx: EngineContext,
  id: DocId,
  opts?: { limit?: number; since?: string },
): Promise<Result<ParsedCommit[]>> {
  if (!ctx.gitLayer) return unavailable(ctx);

  const doc = ctx.backend.getDocument(id);
  if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${id as string}" not found`);

  const commits = await ctx.gitLayer.history(doc.filePath as string, opts);
  return ok(commits);
}

export async function diff(
  ctx: EngineContext,
  id: DocId,
  from: string,
  to?: string,
): Promise<Result<DiffResult>> {
  if (!ctx.gitLayer) return unavailable(ctx);

  const doc = ctx.backend.getDocument(id);
  if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${id as string}" not found`);

  const result = await ctx.gitLayer.diff(doc.filePath as string, id, from, to);
  if (!result) return singleErr('GIT_ERROR', 'Failed to compute diff');
  return ok(result);
}

export async function snapshot(
  ctx: EngineContext,
  id: DocId,
  at: string,
): Promise<Result<SnapshotResult>> {
  if (!ctx.gitLayer) return unavailable(ctx);

  const doc = ctx.backend.getDocument(id);
  if (!doc) return singleErr('FILE_NOT_FOUND', `Document "${id as string}" not found`);

  const result = await ctx.gitLayer.snapshot(doc.filePath as string, id, at);
  if (!result) return singleErr('GIT_ERROR', 'Failed to retrieve snapshot');
  return ok(result);
}

export async function audit(
  ctx: EngineContext,
  opts?: { since?: string; until?: string; docType?: DocType },
): Promise<Result<AuditEntry[]>> {
  if (!ctx.gitLayer) return unavailable(ctx);

  const entries = await ctx.gitLayer.audit(opts);
  return ok(entries);
}
