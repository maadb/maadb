import { describe, it, expect, beforeEach } from 'vitest';
import { Writable } from 'node:stream';
import {
  initLogging,
  logToolCall,
  logWriteAudit,
  logOpsChannelReady,
  getOpsLog,
  getAuditLog,
} from '../../src/logging.js';

// A capture stream that buffers lines so tests can assert on log output.
class CaptureStream extends Writable {
  public lines: Array<Record<string, unknown>> = [];
  _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
    const raw = chunk.toString('utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        this.lines.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        // non-JSON line — ignore (shouldn't happen with pino in json mode)
      }
    }
    cb();
  }
  clear(): void { this.lines = []; }
}

describe('logging', () => {
  let ops: CaptureStream;
  let audit: CaptureStream;

  beforeEach(() => {
    ops = new CaptureStream();
    audit = new CaptureStream();
    initLogging({ opsDestination: ops, auditDestination: audit, level: 'info' });
  });

  // ---- L1 — tool_call produces an ops line ---------------------------------

  it('L1 — logToolCall produces exactly one ops line with all expected fields', () => {
    logToolCall({
      request_id: 'req-1',
      session_id: 'sess-1',
      project: 'proj-a',
      tool: 'maad_summary',
      role: 'reader',
      payload_size: 42,
      latency_ms: 7,
      result: 'ok',
      error_code: null,
    });

    expect(ops.lines.length).toBe(1);
    const line = ops.lines[0]!;
    expect(line.msg).toBe('tool_call');
    expect(line.request_id).toBe('req-1');
    expect(line.session_id).toBe('sess-1');
    expect(line.project).toBe('proj-a');
    expect(line.tool).toBe('maad_summary');
    expect(line.role).toBe('reader');
    expect(line.payload_size).toBe(42);
    expect(line.latency_ms).toBe(7);
    expect(line.result).toBe('ok');
    expect(line.error_code).toBeNull();
  });

  // ---- L2 — successful write produces an audit line ------------------------

  it('L2 — logWriteAudit produces one audit line with channel tag', () => {
    logWriteAudit({
      request_id: 'req-2',
      session_id: 'sess-1',
      project: 'proj-a',
      tool: 'maad_create',
      doc_id: 'cli-x',
      doc_type: 'client',
      version_before: null,
      version_after: 1,
      changed_fields: [],
      git_commit: null,
    });

    expect(audit.lines.length).toBe(1);
    const line = audit.lines[0]!;
    expect(line.channel).toBe('audit');
    expect(line.msg).toBe('write');
    expect(line.doc_id).toBe('cli-x');
    expect(line.version_before).toBeNull();
    expect(line.version_after).toBe(1);
    // Ops stream should NOT contain the audit line
    expect(ops.lines.length).toBe(0);
  });

  // ---- L3 — failed ops event does not produce audit ------------------------

  it('L3 — tool_call with result=error emits ops line only, no audit', () => {
    logToolCall({
      request_id: 'req-3',
      session_id: 'sess-1',
      project: 'proj-a',
      tool: 'maad_create',
      role: 'writer',
      payload_size: 100,
      latency_ms: 5,
      result: 'error',
      error_code: 'VALIDATION_FAILED',
    });

    expect(ops.lines.length).toBe(1);
    expect(ops.lines[0]!.result).toBe('error');
    expect(ops.lines[0]!.error_code).toBe('VALIDATION_FAILED');
    expect(audit.lines.length).toBe(0);
  });

  // ---- L4 — update audit carries version_before + version_after ------------

  it('L4 — update audit records version_before and version_after and changed_fields', () => {
    logWriteAudit({
      request_id: 'req-4',
      session_id: 'sess-1',
      project: 'proj-a',
      tool: 'maad_update',
      doc_id: 'cli-y',
      doc_type: 'client',
      version_before: 1,
      version_after: 2,
      changed_fields: ['status'],
      git_commit: null,
    });

    expect(audit.lines.length).toBe(1);
    const line = audit.lines[0]!;
    expect(line.version_before).toBe(1);
    expect(line.version_after).toBe(2);
    expect(line.changed_fields).toEqual(['status']);
  });

  // ---- L5 — redaction ------------------------------------------------------

  it('L5 — authorization / token / bearer values are redacted in ops log', () => {
    // Emit a log line with a sensitive field in the payload
    getOpsLog().info(
      { args: { authorization: 'Bearer secret-xyz', data: { safe: 'visible' } } },
      'payload_log',
    );
    expect(ops.lines.length).toBe(1);
    const line = ops.lines[0]!;
    const loggedArgs = line.args as { authorization: string; data: { safe: string } };
    expect(loggedArgs.authorization).toBe('[redacted]');
    expect(loggedArgs.data.safe).toBe('visible');
  });

  it('L5b — bearer and token keys are redacted', () => {
    getOpsLog().info({ args: { token: 't-xyz', bearer: 'b-xyz' } }, 'tokens_log');
    const line = ops.lines[0]!;
    const args = line.args as { token: string; bearer: string };
    expect(args.token).toBe('[redacted]');
    expect(args.bearer).toBe('[redacted]');
  });

  // ---- L5c — document body redaction
  // Defense-in-depth. The canonical path is auditToolCall projecting body fields
  // into byte counts before they reach pino — these tests assert that even if
  // a caller bypasses that projection and writes a raw body into a log payload,
  // pino strips it at the transport boundary.

  it('L5c — args.body is redacted at the pino layer', () => {
    getOpsLog().info(
      { args: { docType: 'client', body: 'raw markdown body that should never appear in logs' } },
      'tool_call',
    );
    const args = ops.lines[0]!.args as { docType: string; body: string };
    expect(args.docType).toBe('client');
    expect(args.body).toBe('[redacted]');
  });

  it('L5d — args.appendBody is redacted at the pino layer', () => {
    getOpsLog().info({ args: { docId: 'cli-x', appendBody: 'appended secret' } }, 'tool_call');
    const args = ops.lines[0]!.args as { docId: string; appendBody: string };
    expect(args.docId).toBe('cli-x');
    expect(args.appendBody).toBe('[redacted]');
  });

  it('L5e — args.records[*].body and args.updates[*].body/appendBody are redacted', () => {
    getOpsLog().info(
      {
        args: {
          records: [
            { docType: 'client', body: 'r0 body' },
            { docType: 'client', body: 'r1 body' },
          ],
          updates: [
            { docId: 'a', body: 'u0 body' },
            { docId: 'b', appendBody: 'u1 append' },
          ],
        },
      },
      'tool_call',
    );
    const args = ops.lines[0]!.args as {
      records: Array<{ docType: string; body: string }>;
      updates: Array<{ docId: string; body?: string; appendBody?: string }>;
    };
    expect(args.records[0]!.body).toBe('[redacted]');
    expect(args.records[1]!.body).toBe('[redacted]');
    expect(args.records[0]!.docType).toBe('client'); // siblings untouched
    expect(args.updates[0]!.body).toBe('[redacted]');
    expect(args.updates[1]!.appendBody).toBe('[redacted]');
    expect(args.updates[0]!.docId).toBe('a');
  });

  // ---- L6 — level gating ---------------------------------------------------

  it('L6 — MAAD_LOG_LEVEL=warn silences info-level ops lines', () => {
    // Re-init with warn level
    initLogging({ opsDestination: ops, auditDestination: audit, level: 'warn' });
    ops.clear();

    logToolCall({
      request_id: 'req-6',
      session_id: 'sess-1',
      project: 'proj-a',
      tool: 'maad_summary',
      role: 'reader',
      payload_size: 10,
      latency_ms: 2,
      result: 'ok',
      error_code: null,
    });

    // Info line is gated out at warn level
    expect(ops.lines.length).toBe(0);

    // But an error-level call still logs
    getOpsLog().error({ event: 'boom' }, 'error_msg');
    expect(ops.lines.length).toBe(1);
  });

  // ---- L7 — audit separation from ops --------------------------------------

  it('L7 — audit events go only to the audit destination, not ops', () => {
    logWriteAudit({
      request_id: 'req-7',
      session_id: 'sess-1',
      project: 'proj-a',
      tool: 'maad_create',
      doc_id: 'cli-z',
      doc_type: 'client',
      version_before: null,
      version_after: 1,
      changed_fields: [],
      git_commit: null,
    });

    logToolCall({
      request_id: 'req-7',
      session_id: 'sess-1',
      project: 'proj-a',
      tool: 'maad_create',
      role: 'writer',
      payload_size: 50,
      latency_ms: 30,
      result: 'ok',
      error_code: null,
    });

    // Exactly one line on each stream
    expect(ops.lines.length).toBe(1);
    expect(audit.lines.length).toBe(1);
    expect(ops.lines[0]!.msg).toBe('tool_call');
    expect(audit.lines[0]!.msg).toBe('write');
    // Audit line carries channel tag, ops line does not
    expect(audit.lines[0]!.channel).toBe('audit');
    expect(ops.lines[0]!.channel).toBeUndefined();
  });

  // ---- L9 — ops_channel_ready self-check (0.7.3) -------------

  it('L9 — logOpsChannelReady emits one ops line with destination/level/pid', () => {
    logOpsChannelReady({ destination: 'stderr', level: 'info', pid: 12345 });

    expect(ops.lines.length).toBe(1);
    const line = ops.lines[0]!;
    expect(line.msg).toBe('ops_channel_ready');
    expect(line.destination).toBe('stderr');
    expect(line.level).toBe('info');
    expect(line.pid).toBe(12345);
    // Audit channel does not receive the readiness line
    expect(audit.lines.length).toBe(0);
  });

  // ---- L8 — getAuditLog is live after init ---------------------------------

  it('L8 — getAuditLog/getOpsLog return the initialized instances', () => {
    // After beforeEach, both should be wired to the capture streams.
    getOpsLog().info({ sanity: true }, 'sanity_ops');
    getAuditLog().info({ sanity: true }, 'sanity_audit');

    expect(ops.lines.some((l) => l.msg === 'sanity_ops')).toBe(true);
    expect(audit.lines.some((l) => l.msg === 'sanity_audit')).toBe(true);
  });
});
