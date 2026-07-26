// ============================================================================
// Bearer auth for HTTP transport — 0.7.0 Scoped Auth & Identity
//
// Clients present `Authorization: Bearer <maad_pat_...>`. The plaintext is
// hashed (SHA-256) and looked up in the TokenStore loaded from
// `<instance-root>/_auth/tokens.yaml`. Failed lookups, revoked, and expired
// tokens all map to a plain 401 on the wire — reason surfaces only in the
// ops log.
//
// Legacy single-bearer fallback is HARD-REMOVED in 0.7.0.
// `MAAD_AUTH_TOKEN` without `tokens.yaml` → boot error LEGACY_BEARER_REMOVED.
// No tokens.yaml at all → boot error TOKENS_FILE_MISSING.
//
// stdio has no bearer channel — the token registry is HTTP-only. Synthetic
// (legacy --project) mode never reaches this module because it runs stdio.
// ============================================================================

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

import type { TokenStore } from '../../auth/token-store.js';
import { hashPlaintext, looksLikeToken } from '../../auth/token-store.js';
import type { TokenRecord } from '../../auth/types.js';

export type AuthFailureReason =
  | 'missing'
  | 'malformed'
  | 'unknown'
  | 'revoked'
  | 'expired';

export type AuthResult =
  | { ok: true; record: TokenRecord }
  | { ok: false; reason: AuthFailureReason };

/**
 * Extract the bearer token from the Authorization header.
 * Returns undefined if absent or malformed (no leak about why).
 */
function extractBearer(headerValue: string | string[] | undefined): string | undefined {
  if (typeof headerValue !== 'string') return undefined;
  const trimmed = headerValue.trim();
  if (trimmed.length < 8) return undefined; // "Bearer x" minimum
  // Case-insensitive scheme match; token is whatever follows the first space.
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx < 0) return undefined;
  const scheme = trimmed.slice(0, spaceIdx).toLowerCase();
  if (scheme !== 'bearer') return undefined;
  const token = trimmed.slice(spaceIdx + 1).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * Resolve the Authorization header against the token registry.
 * Pure function over the request + store — no side effects, no logging
 * here (caller handles log + response so remote_addr + trustProxy policy
 * stays in the transport layer).
 *
 * Every failure reason maps to a plain 401 on the wire. The distinct codes
 * are for ops-log diagnostics only.
 */
export function resolveToken(req: IncomingMessage, store: TokenStore, now: Date = new Date()): AuthResult {
  const presented = extractBearer(req.headers.authorization);
  if (presented === undefined) return { ok: false, reason: 'missing' };

  if (!looksLikeToken(presented)) {
    // Use a constant-time compare against a zero buffer of the same shape
    // to normalize timing whether the token was well-formed or not.
    const dummy = Buffer.alloc(presented.length);
    const probe = Buffer.alloc(presented.length);
    timingSafeEqual(dummy, probe);
    return { ok: false, reason: 'malformed' };
  }

  const hash = hashPlaintext(presented);
  const record = store.lookupByHash(hash);
  if (!record) return { ok: false, reason: 'unknown' };
  if (record.revokedAt !== undefined) return { ok: false, reason: 'revoked' };
  if (record.expiresAt !== undefined && new Date(record.expiresAt).getTime() < now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, record };
}

/**
 * Boot-time validation for HTTP mode. Enforces the 0.7.0 hard-removal of
 * legacy single-bearer fallback: tokens.yaml MUST exist and carry ≥1 active
 * entry, or the server refuses to start.
 *
 * Returns an error string (boot rejection) or null (safe to proceed).
 *
 * @param store       — result of TokenStore.load (may be empty)
 * @param storeExists — whether _auth/tokens.yaml was found on disk
 * @param legacyEnv   — value of MAAD_AUTH_TOKEN env, used ONLY to produce a
 *                       distinctive error message when the operator is
 *                       still running a 0.6.x-style deployment config
 */
export function checkHttpAuthAtBoot(
  store: TokenStore,
  storeExists: boolean,
  legacyEnv: string | undefined,
  now: Date = new Date(),
): string | null {
  if (!storeExists) {
    if (legacyEnv !== undefined && legacyEnv.length > 0) {
      return 'LEGACY_BEARER_REMOVED: MAAD_AUTH_TOKEN single-bearer mode was removed in 0.7.0. '
        + 'Generate _auth/tokens.yaml via `maad auth issue-token --role=admin --name=<deployment> --projects=\'*\'` '
        + 'and present the returned maad_pat_<hex> token in the Authorization header. '
        + 'See docs/deploy/systemd.md auth section for the full migration recipe.';
    }
    return 'TOKENS_FILE_MISSING: HTTP mode requires _auth/tokens.yaml with at least one active token. '
      + 'Generate one via `maad auth issue-token --role=admin --name=<deployment> --projects=\'*\'`.';
  }
  if (store.activeCount(now) === 0) {
    return 'TOKENS_FILE_EMPTY: _auth/tokens.yaml has no active (non-revoked, non-expired) tokens. '
      + 'Issue at least one via `maad auth issue-token` before starting HTTP mode.';
  }
  return null;
}

/**
 * Legacy timing-equal helper retained for any non-auth callers that compare
 * strings. Not used by the 0.7.0 auth path directly.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    const dummy = Buffer.alloc(bBuf.length);
    timingSafeEqual(dummy, bBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
