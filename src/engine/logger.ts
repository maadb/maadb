// ============================================================================
// Engine Logger — structured error/event logging with severity policy
// All engine operations log through this instead of console.warn/silent catch.
// ============================================================================

export type Severity = 'fatal' | 'error' | 'degraded' | 'best_effort' | 'info';

export interface LogEntry {
  severity: Severity;
  category: string;
  operation: string;
  message: string;
  details?: Record<string, unknown> | undefined;
}

export type LogHandler = (entry: LogEntry) => void;

const defaultHandler: LogHandler = (entry) => {
  const prefix = `MAAD [${entry.severity.toUpperCase()}] ${entry.category}/${entry.operation}`;
  console.error(`${prefix}: ${entry.message}`);
};

let handler: LogHandler = defaultHandler;

export function setLogHandler(h: LogHandler): void {
  handler = h;
}

export function log(
  severity: Severity,
  category: string,
  operation: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  handler({ severity, category, operation, message, details });
}

// Convenience shortcuts
export const logger = {
  fatal: (cat: string, op: string, msg: string, details?: Record<string, unknown>) => log('fatal', cat, op, msg, details),
  error: (cat: string, op: string, msg: string, details?: Record<string, unknown>) => log('error', cat, op, msg, details),
  degraded: (cat: string, op: string, msg: string, details?: Record<string, unknown>) => log('degraded', cat, op, msg, details),
  bestEffort: (cat: string, op: string, msg: string, details?: Record<string, unknown>) => log('best_effort', cat, op, msg, details),
  info: (cat: string, op: string, msg: string, details?: Record<string, unknown>) => log('info', cat, op, msg, details),
};
