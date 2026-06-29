import { describe, it, expect } from 'vitest';
import { SemanticIndexer } from '../../../src/engine/semantic/indexer.js';
import type {
  SemanticIndex, PendingEmbed, BlockEmbedding, EmbeddingProvider, EmbedKind,
} from '../../../src/engine/semantic/types.js';

// Minimal controllable SemanticIndex stub exercising only what the worker uses.
function makeIndex(initial: PendingEmbed[]) {
  const queue: PendingEmbed[] = [...initial];
  const embedded = new Set<string>();
  let failures = 0;
  const index = {
    takeEmbedBatch: (n: number) => queue.slice(0, n),
    putBlockEmbeddings: (rows: BlockEmbedding[]) => {
      for (const r of rows) {
        embedded.add(`${r.docId}#${r.blockOrd}`);
        const i = queue.findIndex(q => q.docId === r.docId && q.blockOrd === r.blockOrd);
        if (i >= 0) queue.splice(i, 1);
      }
    },
    recordFailure: (n: number) => { failures += n; },
  } as unknown as SemanticIndex;
  return {
    index,
    queueLen: () => queue.length,
    embeddedCount: () => embedded.size,
    failures: () => failures,
  };
}

// Provider that can fail its first N calls, then recover. Counts calls.
function makeProvider(dim = 4, failFirst = 0) {
  let calls = 0;
  const provider: EmbeddingProvider = {
    id: 'fake', model: 'm', dim,
    embed: async (texts: string[], _kind: EmbedKind) => {
      calls++;
      if (calls <= failFirst) throw new Error('provider unavailable');
      return texts.map(() => new Float32Array(dim));
    },
  };
  return { provider, calls: () => calls };
}

const pending = (n: number): PendingEmbed[] =>
  Array.from({ length: n }, (_, i) => ({ qid: i + 1, docId: 'doc', blockOrd: i, text: `block ${i}` }));

describe('SemanticIndexer', () => {
  it('crash-resume: start() drains a queue left by a prior process', async () => {
    const idx = makeIndex(pending(5));
    const { provider } = makeProvider();
    const worker = new SemanticIndexer(idx.index, provider, 2);
    worker.start();          // fire-and-forget crash-resume drain
    await worker.flush();     // await completion
    expect(idx.embeddedCount()).toBe(5);
    expect(idx.queueLen()).toBe(0);
  });

  it('fail-soft: a failed batch is retained + tallied, then a retry drains it', async () => {
    const idx = makeIndex(pending(3));
    const { provider } = makeProvider(4, /* failFirst */ 1);
    const worker = new SemanticIndexer(idx.index, provider, 3);

    await worker.flush();                 // first embed call throws → batch retained
    expect(idx.embeddedCount()).toBe(0);
    expect(idx.failures()).toBe(3);
    expect(idx.queueLen()).toBe(3);

    await worker.flush();                 // provider recovered → drains
    expect(idx.embeddedCount()).toBe(3);
    expect(idx.queueLen()).toBe(0);
  });

  it('single-flight: concurrent kicks + flush still process each block once', async () => {
    const idx = makeIndex(pending(8));
    const { provider, calls } = makeProvider(4);
    const worker = new SemanticIndexer(idx.index, provider, 3);
    worker.kick(); worker.kick(); worker.kick();   // overlapping kicks coalesce
    await worker.flush();
    expect(idx.embeddedCount()).toBe(8);
    expect(idx.queueLen()).toBe(0);
    // 8 blocks / batch 3 = 3 embed calls — not multiplied by the 3 kicks.
    expect(calls()).toBe(3);
  });

  it('stop() halts the worker; no further draining', async () => {
    const idx = makeIndex(pending(4));
    const { provider } = makeProvider();
    const worker = new SemanticIndexer(idx.index, provider, 2);
    await worker.stop();
    worker.kick();
    await worker.flush();
    expect(idx.embeddedCount()).toBe(0);   // stopped before any work
    expect(idx.queueLen()).toBe(4);
  });
});
