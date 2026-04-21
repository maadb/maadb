// ============================================================================
// Engine Context — shared state passed to all domain modules
// ============================================================================

import type { Registry, SchemaStore } from '../types.js';
import type { MaadBackend } from '../backend/index.js';
import type { GitLayer, CommitOptions, CommitOutcome } from '../git/index.js';
import type { OperationJournal } from './journal.js';
import { logger } from './logger.js';
import { logCommitFailure } from '../logging.js';

/**
 * 0.6.10 — Mutable counters on the context so a write-path failure in
 * `gitCommit` can be surfaced through `maad_health` without plumbing state
 * back to the engine. Initialized once per engine init; bumped by `gitCommit`
 * on the 'failed' outcome.
 */
export interface CommitFailureTracker {
  count: number;
  lastAt: string | null;
  lastCode: string | null;
  lastMessage: string | null;
  lastAction: 'create' | 'update' | 'delete' | null;
  lastDocId: string | null;
}

export function newCommitFailureTracker(): CommitFailureTracker {
  return {
    count: 0,
    lastAt: null,
    lastCode: null,
    lastMessage: null,
    lastAction: null,
    lastDocId: null,
  };
}

export interface EngineContext {
  projectRoot: string;
  registry: Registry;
  schemaStore: SchemaStore;
  backend: MaadBackend;
  gitLayer: GitLayer | null;
  journal: OperationJournal;
  readOnly: boolean;
  commitFailures: CommitFailureTracker;
}

/**
 * Run a git commit and return the outcome. When gitLayer is absent (git not
 * initialized or disabled), returns `noop` — the caller treats that as
 * durable since there's no git to reconcile against. When the commit fails,
 * the failure is logged on the ops channel AND tallied on
 * `ctx.commitFailures` so `maad_health` can surface it; the caller gets the
 * outcome back and can stamp `write_durable: false` on the MCP response.
 */
export async function gitCommit(ctx: EngineContext, opts: CommitOptions): Promise<CommitOutcome> {
  if (!ctx.gitLayer) return { status: 'noop' };
  const outcome = await ctx.gitLayer.commit(opts);
  if (outcome.status === 'failed') {
    ctx.commitFailures.count++;
    ctx.commitFailures.lastAt = new Date().toISOString();
    ctx.commitFailures.lastCode = outcome.code;
    ctx.commitFailures.lastMessage = outcome.message;
    ctx.commitFailures.lastAction = opts.action;
    ctx.commitFailures.lastDocId = opts.docId as string;
    logCommitFailure({
      code: outcome.code,
      message: outcome.message,
      action: opts.action,
      doc_id: opts.docId as string,
      doc_type: opts.docType as string,
      file_count: opts.files.length,
    });
    // Keep the dev-facing log line so the existing logger.bestEffort signal
    // stays visible for humans tailing ops in non-JSON mode.
    logger.bestEffort('git', 'commit', `Git commit failed for ${opts.docId as string}: ${outcome.code} — ${outcome.message}`);
  }
  return outcome;
}
