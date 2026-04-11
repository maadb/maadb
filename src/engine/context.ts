// ============================================================================
// Engine Context — shared state passed to all domain modules
// ============================================================================

import type { Registry, SchemaStore } from '../types.js';
import type { MaadBackend } from '../backend/index.js';
import type { GitLayer, CommitOptions } from '../git/index.js';
import type { OperationJournal } from './journal.js';
import { logger } from './logger.js';

export interface EngineContext {
  projectRoot: string;
  registry: Registry;
  schemaStore: SchemaStore;
  backend: MaadBackend;
  gitLayer: GitLayer | null;
  journal: OperationJournal;
  readOnly: boolean;
}

export async function gitCommit(ctx: EngineContext, opts: CommitOptions): Promise<void> {
  if (!ctx.gitLayer) return;
  try {
    await ctx.gitLayer.commit(opts);
  } catch (e) {
    logger.bestEffort('git', 'commit', `Git commit failed for ${opts.docId as string}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
