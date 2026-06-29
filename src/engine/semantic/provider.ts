// ============================================================================
// Embedding provider resolution (0.8.0)
// Two construction paths, in priority order:
//   1. Injected — the host app passes an EmbeddingProvider; the engine holds no
//      API keys. This is how patchnet-projects wires its existing client.
//   2. Env-constructed — for standalone `maad serve`: MAAD_EMBED_PROVIDER picks
//      openai | fake | local, sized via MAAD_EMBED_MODEL / MAAD_EMBED_DIM.
// Returns null when no vector provider is configured — semantic stays in
// lexical-only mode (exact/FTS work; semantic/hybrid degrade to lexical).
// ============================================================================

import { logger } from '../logger.js';
import type { EmbeddingProvider } from './types.js';
import { readSemanticEnv, type SemanticEnv } from './config.js';
import { OpenAiEmbeddingProvider } from './providers/openai.js';
import { FakeEmbeddingProvider } from './providers/fake.js';

const DEFAULT_OPENAI_MODEL = 'text-embedding-3-small';
const DEFAULT_FAKE_DIM = 64;

export interface ProviderResolveOptions {
  /** Host-injected provider (DI). Wins over env when present. */
  injected?: EmbeddingProvider | undefined;
  /** Override env (tests); defaults to readSemanticEnv(). */
  env?: SemanticEnv | undefined;
}

export function resolveEmbeddingProvider(opts: ProviderResolveOptions = {}): EmbeddingProvider | null {
  if (opts.injected) return opts.injected;
  const env = opts.env ?? readSemanticEnv();

  switch (env.provider) {
    case 'openai': {
      if (env.openaiApiKey === undefined) {
        logger.degraded('engine', 'semantic_provider_unconfigured',
          'MAAD_EMBED_PROVIDER=openai but MAAD_OPENAI_API_KEY is unset; running lexical-only (no vectors)');
        return null;
      }
      try {
        return new OpenAiEmbeddingProvider({
          apiKey: env.openaiApiKey,
          model: env.model ?? DEFAULT_OPENAI_MODEL,
          dim: env.dim,
          baseUrl: env.openaiBaseUrl,
        });
      } catch (e) {
        logger.degraded('engine', 'semantic_provider_error',
          `failed to construct OpenAI embedding provider; lexical-only: ${(e as Error).message}`);
        return null;
      }
    }
    case 'fake':
      return new FakeEmbeddingProvider(env.dim ?? DEFAULT_FAKE_DIM);
    case 'local':
      // Phase 2 — local transformers.js provider (optional dep). Not in this build.
      logger.degraded('engine', 'semantic_provider_unavailable',
        'MAAD_EMBED_PROVIDER=local is not available in this build; ' +
        'inject a provider or use MAAD_EMBED_PROVIDER=openai. Running lexical-only.');
      return null;
    case 'none':
    default:
      return null;
  }
}
