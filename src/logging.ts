// ============================================================================
// Logging — two pino loggers, ops + audit.
//
// opsLog   one line per MCP tool call, plus engine-layer events (write_slow,
//          shutdown_start, etc.). Level env-tunable. Redacts authorization
//          and common token fields.
//
// auditLog one line per successful write. Before/after version, changed
//          fields, git commit SHA. Separable to a dedicated file via
//          MAAD_AUDIT_PATH for operators who want an append-only audit trail.
//
// Both are pino instances — fast JSON, zero overhead for gated levels,
// first-class redaction. Test hook: resetLoggers() lets tests inject a
// destination (via environment + pino transports) or capture output via a
// child with a memory destination. See tests/mcp/logging.test.ts for the
// pattern.
// ============================================================================

import pino, { type Logger, type DestinationStream } from 'pino';
import { createWriteStream } from 'node:fs';

const REDACT_PATHS = [
  'args.authorization',
  'args.token',
  'args.bearer',
  'args.headers.authorization',
  'authorization',
  'headers.authorization',
];

export interface LoggingOptions {
  level?: string;
  pretty?: boolean;
  auditPath?: string;
  // Test hook — an explicit destination stream overrides all file/pretty wiring.
  opsDestination?: DestinationStream;
  auditDestination?: DestinationStream;
}

let opsLog: Logger;
let auditLog: Logger;

// Default log destination is stderr (fd 2), not stdout. In stdio MCP transport
// mode, stdout IS the JSON-RPC channel — any non-protocol bytes written there
// (including pino log lines) corrupt the frame stream and the client
// disconnects. stderr is safe for both transports; HTTP operators can still
// redirect it wherever they like.
function defaultDestination(): DestinationStream {
  return pino.destination({ fd: 2, sync: false });
}

function buildOps(opts: LoggingOptions): Logger {
  const level = opts.level ?? process.env.MAAD_LOG_LEVEL ?? 'info';
  if (opts.opsDestination) {
    return pino({ level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, opts.opsDestination);
  }
  if (opts.pretty ?? process.env.MAAD_LOG_PRETTY === '1') {
    return pino({
      level,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      transport: { target: 'pino-pretty', options: { colorize: true, destination: 2 } },
    });
  }
  return pino({ level, redact: { paths: REDACT_PATHS, censor: '[redacted]' } }, defaultDestination());
}

function buildAudit(opts: LoggingOptions): Logger {
  // Audit is always 'info' — it records discrete state changes, level gating
  // would defeat its purpose.
  const level = 'info';
  if (opts.auditDestination) {
    return pino({ level, base: { channel: 'audit' } }, opts.auditDestination);
  }
  const auditPath = opts.auditPath ?? process.env.MAAD_AUDIT_PATH;
  if (auditPath && auditPath.length > 0) {
    const stream = createWriteStream(auditPath, { flags: 'a' });
    return pino({ level, base: { channel: 'audit' } }, stream);
  }
  return pino({ level, base: { channel: 'audit' } }, defaultDestination());
}

export function initLogging(opts: LoggingOptions = {}): void {
  opsLog = buildOps(opts);
  auditLog = buildAudit(opts);
}

// Eager default — safe to call getOpsLog()/getAuditLog() before initLogging().
initLogging();

export function getOpsLog(): Logger { return opsLog; }
export function getAuditLog(): Logger { return auditLog; }

export function readLoggingEnv(): LoggingOptions {
  const opts: LoggingOptions = {};
  if (process.env.MAAD_LOG_LEVEL) opts.level = process.env.MAAD_LOG_LEVEL;
  if (process.env.MAAD_LOG_PRETTY === '1') opts.pretty = true;
  if (process.env.MAAD_AUDIT_PATH) opts.auditPath = process.env.MAAD_AUDIT_PATH;
  return opts;
}

// ---- Tool-call event (ops) -------------------------------------------------

export interface ToolCallLogFields {
  request_id: string;
  session_id: string;
  project: string | null;
  tool: string;
  role: string | null;
  payload_size: number;
  latency_ms: number;
  result: 'ok' | 'error';
  error_code: string | null;
}

export function logToolCall(fields: ToolCallLogFields): void {
  opsLog.info(fields, 'tool_call');
}

// ---- Write event (audit) ---------------------------------------------------

export interface WriteAuditFields {
  request_id: string;
  session_id: string;
  project: string;
  tool: string;
  doc_id: string | null;
  doc_ids?: string[];
  doc_type: string | null;
  version_before: number | null;
  version_after: number | null;
  changed_fields: string[];
  git_commit: string | null;
}

export function logWriteAudit(fields: WriteAuditFields): void {
  auditLog.info(fields, 'write');
}

// ---- Auth failure event (ops) ----------------------------------------------

export interface AuthFailureFields {
  remote_addr: string;
  reason: 'missing' | 'invalid';
}

export function logAuthFailure(fields: AuthFailureFields): void {
  opsLog.info(fields, 'auth_failure');
}

// ---- Pin rejection event (ops) --------------------------------------------
// 0.6.8 — emitted when X-Maad-Pin-Project header validation fails at HTTP
// initialize. Operators tracking hosted-deployment misconfiguration (bad
// gateway, typo'd slug, request smuggling attempts) filter on
// code=PIN_PROJECT_* to see the pattern quickly.

export interface PinRejectedFields {
  remote_addr: string;
  code: 'PIN_PROJECT_INVALID' | 'PIN_PROJECT_NOT_FOUND' | 'PIN_ON_EXISTING_SESSION';
  project: string | null;
}

export function logPinRejected(fields: PinRejectedFields): void {
  opsLog.info(fields, 'pin_rejected');
}

// ---- Validation warning event (ops) ---------------------------------------
// 0.6.7 — one `warn`-level line per ValidationWarning emitted on a write.
// Operators see patterns across agents without having to scrape response
// bodies. Code is part of the structured payload so filtering by
// `code=PRECISION_COARSER_THAN_DECLARED` (or future soft-check codes) is
// straightforward.

export interface ValidationWarningFields {
  request_id: string;
  session_id: string;
  project: string;
  tool: string;
  doc_id: string | null;
  doc_type: string | null;
  field: string;
  code: string;
  message: string;
}

export function logValidationWarning(fields: ValidationWarningFields): void {
  opsLog.warn(fields, 'validation_warning');
}

// ---- Instance reload events -----------------------------------------------
// 0.6.9 — audit + ops events for maad_instance_reload + SIGHUP. Audit carries
// the diff (projectsAdded / projectsRemoved) + source so operators can trace
// tenant-membership changes. Ops channel carries start / complete / failed
// progress lines for live debugging.

export interface InstanceReloadAuditFields {
  source: 'tool' | 'sighup';
  projectsAdded: number;
  projectsRemoved: number;
  projectsAddedNames: string[];
  projectsRemovedNames: string[];
  sessionsCancelled: number;
  sessionsPruned: number;
  durationMs: number;
}

export function logInstanceReload(fields: InstanceReloadAuditFields): void {
  auditLog.info(fields, 'instance_reload');
}

export interface InstanceReloadProgressFields {
  source: 'tool' | 'sighup';
  phase: 'start' | 'complete' | 'failed';
  code?: string;
  message?: string;
  projectsAdded?: number;
  projectsRemoved?: number;
  durationMs?: number;
}

export function logInstanceReloadProgress(fields: InstanceReloadProgressFields): void {
  const eventName = `instance_reload_${fields.phase}`;
  if (fields.phase === 'failed') {
    opsLog.warn(fields, eventName);
  } else {
    opsLog.info(fields, eventName);
  }
}

// ---- Commit failure event (ops) -------------------------------------------
// 0.6.10 — emitted when a git commit attached to a write fails (stage
// succeeded but commit threw / returned no sha / status threw). Before this
// release, commit failures were caught and silently dropped — producing the
// fup-066 symptom where bulk writes ack'd durable while git held staged
// state. Operators grep for `commit_failed` to detect durability drift.

export interface CommitFailureFields {
  code: string;
  message: string;
  action: 'create' | 'update' | 'delete';
  doc_id: string;
  doc_type: string;
  file_count: number;
}

export function logCommitFailure(fields: CommitFailureFields): void {
  opsLog.warn(fields, 'commit_failed');
}
