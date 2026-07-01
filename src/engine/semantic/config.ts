// ============================================================================
// Semantic retrieval — env/config (0.8.0)
// No central config module exists in the engine; each subsystem reads its own
// MAAD_* vars at point of use. This is the one grouped reader for the semantic
// subsystem, mirroring readMemoryPressureEnv / EnginePool.readIdleSweepEnv.
// ============================================================================

export type ProviderKind = 'openai' | 'local' | 'fake' | 'none';

export interface SemanticEnv {
  /** MAAD_SEMANTIC_ENABLE — master gate. Off ⇒ engine behaves exactly as today. */
  enabled: boolean;
  /** MAAD_EMBED_PROVIDER — which provider to env-construct (injected bypasses this). */
  provider: ProviderKind;
  /** MAAD_EMBED_MODEL — model id (provider-specific). */
  model: string | undefined;
  /** MAAD_EMBED_DIM — explicit vector dim (truncation/override). */
  dim: number | undefined;
  /** MAAD_OPENAI_API_KEY — never logged; stays in the provider closure. */
  openaiApiKey: string | undefined;
  /** MAAD_OPENAI_BASE_URL — defaults to https://api.openai.com. */
  openaiBaseUrl: string | undefined;
  /** MAAD_EMBED_MODEL_PATH — local model weights dir (Phase 2; never defaults to cwd). */
  modelPath: string | undefined;
  /** MAAD_EMBED_BATCH — max texts per embed call (worker batching). */
  batchSize: number;
}

const DEFAULT_BATCH = 32;

function boolEnv(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}

function intEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function providerKind(raw: string | undefined): ProviderKind {
  switch ((raw ?? '').toLowerCase()) {
    case 'openai': return 'openai';
    case 'local': return 'local';
    case 'fake': return 'fake';
    default: return 'none';
  }
}

/** Cheap boolean gate, safe to call per-operation (no allocation worth caching). */
export function isSemanticEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return boolEnv(env['MAAD_SEMANTIC_ENABLE']);
}

export function readSemanticEnv(env: NodeJS.ProcessEnv = process.env): SemanticEnv {
  return {
    enabled: boolEnv(env['MAAD_SEMANTIC_ENABLE']),
    provider: providerKind(env['MAAD_EMBED_PROVIDER']),
    model: env['MAAD_EMBED_MODEL'] || undefined,
    dim: intEnv(env['MAAD_EMBED_DIM']),
    openaiApiKey: env['MAAD_OPENAI_API_KEY'] || undefined,
    openaiBaseUrl: env['MAAD_OPENAI_BASE_URL'] || undefined,
    modelPath: env['MAAD_EMBED_MODEL_PATH'] || undefined,
    batchSize: intEnv(env['MAAD_EMBED_BATCH']) ?? DEFAULT_BATCH,
  };
}
