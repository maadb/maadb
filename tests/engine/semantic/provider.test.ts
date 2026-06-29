import { describe, it, expect } from 'vitest';
import { FakeEmbeddingProvider } from '../../../src/engine/semantic/providers/fake.js';
import { OpenAiEmbeddingProvider } from '../../../src/engine/semantic/providers/openai.js';
import { resolveEmbeddingProvider } from '../../../src/engine/semantic/provider.js';
import { readSemanticEnv } from '../../../src/engine/semantic/config.js';
import type { EmbeddingProvider } from '../../../src/engine/semantic/types.js';

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

describe('FakeEmbeddingProvider', () => {
  it('is deterministic and correctly dimensioned, unit-normalized', async () => {
    const p = new FakeEmbeddingProvider(32);
    const [a] = await p.embed(['vector search retrieval'], 'document');
    const [b] = await p.embed(['vector search retrieval'], 'query');
    expect(a!.length).toBe(32);
    expect(Array.from(a!)).toEqual(Array.from(b!));        // deterministic, kind-agnostic
    expect(cosine(a!, a!)).toBeCloseTo(1, 5);              // normalized
  });

  it('places shared-token texts closer than disjoint ones', async () => {
    const p = new FakeEmbeddingProvider(256);
    const [q, near, far] = await p.embed([
      'semantic vector search',
      'vector search over documents',
      'the lazy dog sleeps',
    ], 'document');
    expect(cosine(q!, near!)).toBeGreaterThan(cosine(q!, far!));
  });
});

describe('OpenAiEmbeddingProvider', () => {
  function mockFetch(captured: { url?: string; init?: RequestInit }, data: number[][]) {
    return (async (url: string, init: RequestInit) => {
      captured.url = url;
      captured.init = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: data.map((embedding, index) => ({ embedding, index })) }),
        text: async () => '',
      };
    }) as unknown as typeof fetch;
  }

  // A dim-wide vector with `marker` in element 0 (so order is verifiable). The
  // provider validates returned width against its declared dim, so mocks must
  // be correctly sized.
  const vecOf = (dim: number, marker: number): number[] =>
    Array.from({ length: dim }, (_, i) => (i === 0 ? marker : 0));

  it('resolves dim from the model map and posts the right request', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const p = new OpenAiEmbeddingProvider({
      apiKey: 'sk-test', model: 'text-embedding-3-small',
      fetchImpl: mockFetch(cap, [vecOf(1536, 1), vecOf(1536, 2)]),
    });
    expect(p.dim).toBe(1536);
    const out = await p.embed(['a', 'b'], 'document');
    expect(out.length).toBe(2);
    expect(out[0]!.length).toBe(1536);
    expect(out[0]![0]).toBe(1);
    expect(out[1]![0]).toBe(2);
    expect(cap.url).toBe('https://api.openai.com/v1/embeddings');
    expect((cap.init!.headers as Record<string, string>)['authorization']).toBe('Bearer sk-test');
    const body = JSON.parse(cap.init!.body as string);
    expect(body.model).toBe('text-embedding-3-small');
    expect(body.input).toEqual(['a', 'b']);
    expect(body.dimensions).toBeUndefined();               // native dim ⇒ no truncation
  });

  it('sends `dimensions` only when truncating below native', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const p = new OpenAiEmbeddingProvider({
      apiKey: 'k', model: 'text-embedding-3-large', dim: 512,
      fetchImpl: mockFetch(cap, [vecOf(512, 0)]),
    });
    expect(p.dim).toBe(512);
    await p.embed(['x'], 'document');
    expect(JSON.parse(cap.init!.body as string).dimensions).toBe(512);
  });

  it('preserves input order from out-of-order responses', async () => {
    const p = new OpenAiEmbeddingProvider({
      apiKey: 'k', model: 'text-embedding-3-small',
      fetchImpl: (async () => ({
        ok: true, status: 200,
        json: async () => ({ data: [{ embedding: vecOf(1536, 9), index: 1 }, { embedding: vecOf(1536, 8), index: 0 }] }),
        text: async () => '',
      })) as unknown as typeof fetch,
    });
    const out = await p.embed(['first', 'second'], 'document');
    expect(out[0]![0]).toBe(8);
    expect(out[1]![0]).toBe(9);
  });

  it('throws when the returned width disagrees with the declared dim', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const p = new OpenAiEmbeddingProvider({
      apiKey: 'k', model: 'text-embedding-3-small',
      fetchImpl: mockFetch(cap, [vecOf(8, 1)]),   // 8-dim, but provider declares 1536
    });
    await expect(p.embed(['x'], 'document')).rejects.toThrow(/dim/);
  });

  it('rejects dim > native (OpenAI cannot expand)', () => {
    expect(() => new OpenAiEmbeddingProvider({ apiKey: 'k', model: 'text-embedding-3-small', dim: 3072 }))
      .toThrow(/exceeds the native dim/);
  });

  it('rejects truncation on a non-3-* model (ada-002)', () => {
    expect(() => new OpenAiEmbeddingProvider({ apiKey: 'k', model: 'text-embedding-ada-002', dim: 512 }))
      .toThrow(/does not support dimension truncation/);
  });

  it('throws a clear error on non-200', async () => {
    const p = new OpenAiEmbeddingProvider({
      apiKey: 'k', model: 'text-embedding-3-small',
      fetchImpl: (async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => 'rate limited' })) as unknown as typeof fetch,
    });
    await expect(p.embed(['x'], 'document')).rejects.toThrow(/429.*rate limited/);
  });

  it('requires an explicit dim for an unknown model', () => {
    expect(() => new OpenAiEmbeddingProvider({ apiKey: 'k', model: 'mystery-model' }))
      .toThrow(/MAAD_EMBED_DIM/);
  });
});

describe('resolveEmbeddingProvider', () => {
  const baseEnv = () => readSemanticEnv({});

  it('injected provider wins over env', () => {
    const injected: EmbeddingProvider = { id: 'x', model: 'm', dim: 3, embed: async () => [] };
    expect(resolveEmbeddingProvider({ injected, env: { ...baseEnv(), provider: 'openai' } })).toBe(injected);
  });

  it('openai without a key falls back to lexical-only (null)', () => {
    expect(resolveEmbeddingProvider({ env: { ...baseEnv(), provider: 'openai' } })).toBeNull();
  });

  it('constructs openai when a key is present', () => {
    const p = resolveEmbeddingProvider({
      env: { ...baseEnv(), provider: 'openai', openaiApiKey: 'sk', model: 'text-embedding-3-small' },
    });
    expect(p?.id).toBe('openai');
    expect(p?.dim).toBe(1536);
  });

  it('constructs the fake provider at the configured dim', () => {
    const p = resolveEmbeddingProvider({ env: { ...baseEnv(), provider: 'fake', dim: 48 } });
    expect(p?.id).toBe('fake');
    expect(p?.dim).toBe(48);
  });

  it('local and none resolve to null (lexical-only) in this build', () => {
    expect(resolveEmbeddingProvider({ env: { ...baseEnv(), provider: 'local' } })).toBeNull();
    expect(resolveEmbeddingProvider({ env: { ...baseEnv(), provider: 'none' } })).toBeNull();
  });
});
