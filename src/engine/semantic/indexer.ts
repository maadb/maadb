// ============================================================================
// Semantic indexer (0.8.0) — the async embed worker. Drains the persisted
// embed_queue: pull a batch of pending blocks, embed them (kind='document'),
// upsert vectors, clear the queue rows. Runs OUTSIDE the engine write mutex —
// model/network latency must never block the write FIFO. The DB writes it does
// (putBlockEmbeddings) are fast and synchronous; only the embed() call awaits.
//
// Lifecycle: start() does a crash-resume drain of whatever the queue holds from
// a prior process; kick() is fired (fire-and-forget) after each durable write;
// flush() is the awaitable form used by reindex --embeddings and tests.
// Single-flight: one drain at a time; a kick during a drain schedules a rerun.
// Fail-soft: an embed error tallies failures and leaves the queue rows for a
// later retry rather than dropping them or hot-looping.
// ============================================================================

import { logger } from '../logger.js';
import type { EmbeddingProvider, SemanticIndex, BlockEmbedding } from './types.js';

const DEFAULT_BATCH = 32;

export class SemanticIndexer {
  private readonly index: SemanticIndex;
  private readonly provider: EmbeddingProvider;
  private readonly batchSize: number;
  private currentDrain: Promise<void> | null = null;
  private rerun = false;
  private stopped = false;

  constructor(index: SemanticIndex, provider: EmbeddingProvider, batchSize = DEFAULT_BATCH) {
    this.index = index;
    this.provider = provider;
    this.batchSize = batchSize > 0 ? batchSize : DEFAULT_BATCH;
  }

  /** Crash-resume: drain whatever a prior process left pending. Fire-and-forget. */
  start(): void {
    this.kick();
  }

  /** Signal that new work may be queued. Non-blocking. */
  kick(): void {
    if (this.stopped) return;
    void this.ensureDraining();
  }

  /** Awaitable drain to completion (reindex --embeddings, tests). */
  async flush(): Promise<void> {
    if (this.stopped) return;
    await this.ensureDraining();
  }

  /** Stop accepting work; lets an in-flight drain finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.currentDrain) {
      try { await this.currentDrain; } catch { /* already logged */ }
    }
  }

  private ensureDraining(): Promise<void> {
    if (this.currentDrain) {
      this.rerun = true;            // fold this request into the running drain
      return this.currentDrain;
    }
    this.currentDrain = this.drain().finally(() => { this.currentDrain = null; });
    return this.currentDrain;
  }

  private async drain(): Promise<void> {
    do {
      this.rerun = false;
      while (!this.stopped) {
        const batch = this.index.takeEmbedBatch(this.batchSize);
        if (batch.length === 0) break;
        try {
          const vectors = await this.provider.embed(batch.map(b => b.text), 'document');
          if (vectors.length !== batch.length) {
            throw new Error(`provider returned ${vectors.length} vectors for ${batch.length} inputs`);
          }
          const rows: BlockEmbedding[] = batch.map((b, i) => ({
            qid: b.qid, docId: b.docId, blockOrd: b.blockOrd, vector: vectors[i]!,
          }));
          this.index.putBlockEmbeddings(rows);
        } catch (e) {
          // Leave the queue rows in place for a later retry; break to avoid a
          // hot loop on a persistent failure (next kick/flush retries).
          this.index.recordFailure(batch.length);
          logger.bestEffort('engine', 'embed_batch_failed',
            `embedding batch failed (${batch.length} blocks); left queued for retry: ${(e as Error).message}`);
          return;
        }
      }
    } while (this.rerun && !this.stopped);
  }
}
