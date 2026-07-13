// ============================================================================
// Origin-header validation for the Streamable HTTP /mcp endpoint.
//
// MCP Streamable HTTP spec (2025-03-26 onward; reaffirmed 2025-11-25):
// servers MUST validate the Origin header on all incoming connections to
// prevent DNS rebinding, and MUST respond 403 Forbidden when a present
// Origin is invalid. Requests WITHOUT an Origin header pass — Origin is a
// browser-attached header that non-browser MCP clients (SDKs, CLIs,
// backend services) do not send, and a page cannot forge or strip it.
//
// This is Origin validation, not CORS: no Access-Control-* headers are
// emitted, and no preflight handling is added. The allowlist is exact
// serialized origins only — no wildcards, no implicit localhost. An empty
// allowlist (the default) denies every request that presents an Origin,
// which is the secure zero-configuration posture for non-browser deploys.
// ============================================================================

/** Result of canonicalizing the configured allowlist at startup. */
export type ParseOriginsResult =
  | { ok: true; origins: ReadonlySet<string> }
  | { ok: false; errors: string[] };

/**
 * Split a comma-separated origin list (MAAD_HTTP_ALLOWED_ORIGINS) into
 * candidate entries. Empty segments from stray commas are dropped; actual
 * validation happens in parseAllowedOrigins.
 */
export function splitOriginList(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Validate and canonicalize configured allowlist entries once at startup.
 * Accepts only http:/https: origins, canonicalized via WHATWG URL origin
 * serialization. Entries carrying wildcards, paths (beyond a bare trailing
 * slash), queries, fragments, credentials, or the opaque `null` origin are
 * configuration errors — the caller must fail startup with the returned
 * messages rather than silently dropping entries.
 */
export function parseAllowedOrigins(entries: readonly string[]): ParseOriginsResult {
  const origins = new Set<string>();
  const errors: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      errors.push('empty origin entry');
      continue;
    }
    if (trimmed.includes('*')) {
      errors.push(`'${trimmed}': wildcards are not supported; list exact origins`);
      continue;
    }
    if (trimmed.toLowerCase() === 'null') {
      errors.push(`'${trimmed}': the opaque null origin cannot be allowlisted`);
      continue;
    }
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      errors.push(`'${trimmed}': not a parseable origin (expected e.g. https://app.example.com)`);
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      errors.push(`'${trimmed}': only http: and https: origins are supported`);
      continue;
    }
    if (url.username !== '' || url.password !== '') {
      errors.push(`'${trimmed}': credentials are not allowed in an origin`);
      continue;
    }
    if (url.search !== '' || url.hash !== '') {
      errors.push(`'${trimmed}': queries/fragments are not allowed in an origin`);
      continue;
    }
    if (url.pathname !== '/') {
      errors.push(`'${trimmed}': paths are not allowed in an origin`);
      continue;
    }
    origins.add(url.origin);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, origins };
}

export type OriginCheck = 'absent' | 'allowed' | 'forbidden';

/**
 * Evaluate a request's Origin header against the canonical allowlist.
 * `absent` (no header) passes — non-browser client. A present header must
 * be a single, parseable http(s) origin whose canonical serialization is
 * in the allowlist; anything else — unlisted, malformed, duplicated,
 * opaque `null` — is `forbidden` (HTTP 403 per spec).
 */
export function checkOrigin(
  header: string | string[] | undefined,
  allowed: ReadonlySet<string>,
): OriginCheck {
  if (header === undefined) return 'absent';
  if (Array.isArray(header)) return 'forbidden';
  const value = header.trim();
  if (value.length === 0 || value.toLowerCase() === 'null') return 'forbidden';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'forbidden';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'forbidden';
  return allowed.has(url.origin) ? 'allowed' : 'forbidden';
}
