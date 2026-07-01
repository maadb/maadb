// ============================================================================
// Fake embedding provider (0.8.0) — a deterministic, offline, no-key provider
// for tests and local development. It is a real hashing vectorizer (the
// "hashing trick"): tokens map to fixed buckets, so identical text yields an
// identical vector (self-retrieval distance 0) and texts sharing words are
// closer. Not semantic in the learned sense, but deterministic and dependency-
// free — the injected provider tests use to exercise the full embed→vec→search
// loop without network or model weights.
// ============================================================================

import type { EmbeddingProvider, EmbedKind } from '../types.js';

const DEFAULT_DIM = 64;

// FNV-1a 32-bit — stable across runs/platforms, no crypto dep.
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function embedOne(text: string, dim: number): Float32Array {
  const v = new Float32Array(dim);
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const tok of tokens) {
    const h = fnv1a(tok);
    const bucket = h % dim;
    // signed update keeps the space from collapsing to all-positive
    v[bucket]! += (h & 1) === 0 ? 1 : -1;
  }
  // L2-normalize so cosine ranking via vec0's L2 distance is well-behaved;
  // an empty/whitespace block maps to a stable nonzero unit vector.
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  if (norm === 0) { v[0] = 1; return v; }
  for (let i = 0; i < dim; i++) v[i]! /= norm;
  return v;
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'fake';
  readonly model = 'fake-hash';
  readonly dim: number;

  constructor(dim: number = DEFAULT_DIM) {
    this.dim = dim;
  }

  async embed(texts: string[], _kind: EmbedKind): Promise<Float32Array[]> {
    return texts.map(t => embedOne(t, this.dim));
  }
}
