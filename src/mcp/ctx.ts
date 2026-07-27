// ============================================================================
// InstanceCtx — the runtime context threaded through every tool handler.
// Holds pool + sessions so `withEngine` can resolve the correct engine
// per call.
// ============================================================================

import type { EnginePool } from '../instance/pool.js';
import type { SessionRegistry } from '../instance/session.js';
import type { InstanceConfig } from '../instance/config.js';
import type { TokenStore } from '../auth/token-store.js';

export interface InstanceCtx {
  instance: InstanceConfig;
  pool: EnginePool;
  sessions: SessionRegistry;
  /**
   * 0.7.0 — Token registry. Populated in HTTP mode from
   * `<instance-root>/_auth/tokens.yaml`. Null in stdio / synthetic mode
   * (no bearer channel). Callers that only apply when a token is present
   * (auth middleware, identity propagation) check for null.
   */
  tokens: TokenStore | null;
  /**
   * Session-principal-binding enforcement hook. Fired after any token-registry
   * change that can invalidate live sessions (revoke, rotate, tokens.yaml
   * reload) so the HTTP transport can tear down bound sessions immediately
   * instead of waiting for the sweeper backstop. `excludeSessionId` lets the
   * admin auth tools skip the session the mutation ran on — closing it
   * synchronously would race the response carrying a rotate's one-time
   * plaintext; that session is still fenced per-request (revoked bearer
   * → 401 on its next call) and swept on the next tick. Unset in stdio /
   * synthetic mode and in tests that exercise tools without a transport.
   */
  onTokensChanged?: ((excludeSessionId?: string) => void) | undefined;
}
