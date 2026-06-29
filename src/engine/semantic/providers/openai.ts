// ============================================================================
// OpenAI embedding provider (0.8.0) — a thin POST /v1/embeddings client over the
// built-in fetch (no SDK dep). Marginal-cost provider: if a deployment already
// has an OpenAI key wired, embeddings reuse the same key/base. The engine never
// stores the key beyond this provider closure.
// ============================================================================

import type { EmbeddingProvider, EmbedKind } from '../types.js';

const DEFAULT_BASE_URL = 'https://api.openai.com';

// Native output dims for the common models — used when no explicit dim is set.
// text-embedding-3-* additionally support server-side truncation via `dimensions`.
const MODEL_DIMS: Record<string, number> = {
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
};

export interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
  /** Explicit output dim. For 3-* models this is sent as `dimensions` (truncation). */
  dim?: number | undefined;
  /** API root (default https://api.openai.com); '/v1/embeddings' is appended. */
  baseUrl?: string | undefined;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch | undefined;
}

interface EmbeddingsResponse {
  data: Array<{ embedding: number[]; index: number }>;
}

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openai';
  readonly model: string;
  readonly dim: number;
  private readonly apiKey: string;
  private readonly url: string;
  private readonly sendDimensions: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: OpenAiProviderOptions) {
    if (!opts.apiKey) throw new Error('OpenAI embedding provider requires an API key (MAAD_OPENAI_API_KEY)');
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    const native = MODEL_DIMS[opts.model];
    const resolved = opts.dim ?? native;
    if (resolved === undefined) {
      throw new Error(
        `Cannot determine embedding dim for OpenAI model "${opts.model}". ` +
        `Set MAAD_EMBED_DIM explicitly.`);
    }
    // Only text-embedding-3-* support server-side dimension truncation.
    const supportsTruncation = /^text-embedding-3-/.test(opts.model);
    if (opts.dim !== undefined && native !== undefined) {
      if (opts.dim > native) {
        throw new Error(
          `MAAD_EMBED_DIM=${opts.dim} exceeds the native dim ${native} for "${opts.model}"; ` +
          `OpenAI embeddings can be truncated below native but never expanded.`);
      }
      if (opts.dim < native && !supportsTruncation) {
        throw new Error(
          `Model "${opts.model}" does not support dimension truncation; ` +
          `set MAAD_EMBED_DIM=${native} or omit it (only text-embedding-3-* can truncate).`);
      }
    }
    this.dim = resolved;
    this.sendDimensions = supportsTruncation && opts.dim !== undefined && native !== undefined && opts.dim < native;
    const base = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.url = `${base}/v1/embeddings`;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async embed(texts: string[], _kind: EmbedKind): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const body: Record<string, unknown> = {
      model: this.model,
      input: texts,
      encoding_format: 'float',
    };
    if (this.sendDimensions) body['dimensions'] = this.dim;

    const res = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenAI embeddings request failed (${res.status}): ${detail.slice(0, 300)}`);
    }
    const json = (await res.json()) as EmbeddingsResponse;
    if (!json.data || json.data.length !== texts.length) {
      throw new Error(`OpenAI embeddings returned ${json.data?.length ?? 0} vectors for ${texts.length} inputs`);
    }
    // Preserve input order regardless of response ordering, and assert the
    // returned width matches the declared dim — a mismatch would otherwise only
    // surface as a sqlite-vec insert failure inside the async worker.
    const out: Float32Array[] = new Array(texts.length);
    for (const item of json.data) {
      if (item.embedding.length !== this.dim) {
        throw new Error(
          `OpenAI returned a ${item.embedding.length}-dim vector but the provider is configured for ${this.dim} ` +
          `(model "${this.model}"). Check MAAD_EMBED_DIM / MAAD_EMBED_MODEL.`);
      }
      out[item.index] = Float32Array.from(item.embedding);
    }
    return out;
  }
}
