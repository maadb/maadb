// ============================================================================
// X-Maad-Pin-Project header validation for HTTP transport (0.6.8)
//
// Gateway-enforced session pinning: a trusted upstream gateway sets
// X-Maad-Pin-Project: <project-name> on the MCP initialize request, and the
// engine pins the session to that project irrevocably. Server-side rebind
// rejection lives in SessionRegistry.bindSingle/bindMulti (emits SESSION_PINNED
// when bindingSource === 'gateway_pin').
//
// Validation rules (applied at every HTTP request BEFORE session resolution):
//   - Header absent  → status 'absent', proceed unpinned
//   - Multiple values → PIN_PROJECT_INVALID (spec §Interface #3)
//   - Empty or regex-failing value → PIN_PROJECT_INVALID
//   - Header present AND Mcp-Session-Id present → PIN_ON_EXISTING_SESSION
//     (pin is a session-creation property; not valid on existing sessions)
//   - Value not in instance.projects[].name → PIN_PROJECT_NOT_FOUND
//
// This module is PURE — no side effects, no logging. Caller (http.ts) handles
// HTTP response + logging so remote_addr and trust-proxy policy stay in the
// transport layer.
// ============================================================================

import type { IncomingMessage } from 'node:http';
import type { InstanceConfig } from '../../instance/config.js';

export type PinFailureCode =
  | 'PIN_PROJECT_INVALID'
  | 'PIN_PROJECT_NOT_FOUND'
  | 'PIN_ON_EXISTING_SESSION';

export type PinResult =
  | { status: 'absent' }
  | { status: 'valid'; projectName: string }
  | { status: 'rejected'; code: PinFailureCode; message: string };

// Same regex as instance.yaml project names (src/instance/config.ts).
// Kept local to avoid importing internals; drift-risk is minimal — the spec
// locks this regex as the project-name contract.
const VALID_PROJECT_NAME = /^[a-z][a-z0-9_-]*$/;

export function validatePinHeader(req: IncomingMessage, instance: InstanceConfig): PinResult {
  const raw = req.headers['x-maad-pin-project'];
  if (raw === undefined) return { status: 'absent' };

  // Node normalizes repeated headers to string[]. Per spec, exactly one value.
  if (Array.isArray(raw)) {
    if (raw.length !== 1) {
      return {
        status: 'rejected',
        code: 'PIN_PROJECT_INVALID',
        message: 'X-Maad-Pin-Project header present multiple times; exactly one value required',
      };
    }
    return validateSingle(raw[0]!, req, instance);
  }
  return validateSingle(raw, req, instance);
}

function validateSingle(value: string, req: IncomingMessage, instance: InstanceConfig): PinResult {
  // Pin is a session-creation property. Presence on a request carrying an
  // Mcp-Session-Id means the client is trying to mid-session rebind via the
  // header, which is nonsensical — pin is irrevocable for the session's life.
  if (req.headers['mcp-session-id']) {
    return {
      status: 'rejected',
      code: 'PIN_ON_EXISTING_SESSION',
      message: 'X-Maad-Pin-Project is only valid at session initialize; open a new session without Mcp-Session-Id to change the pin',
    };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || !VALID_PROJECT_NAME.test(trimmed)) {
    return {
      status: 'rejected',
      code: 'PIN_PROJECT_INVALID',
      message: `X-Maad-Pin-Project value ${JSON.stringify(value)} is not a valid project name (expected /^[a-z][a-z0-9_-]*$/)`,
    };
  }
  if (!instance.projects.some(p => p.name === trimmed)) {
    return {
      status: 'rejected',
      code: 'PIN_PROJECT_NOT_FOUND',
      message: `X-Maad-Pin-Project value "${trimmed}" does not match any project in this instance`,
    };
  }
  return { status: 'valid', projectName: trimmed };
}
