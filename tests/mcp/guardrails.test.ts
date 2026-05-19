import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setGuardrailConfig, isDryRun, isToolAllowed, dryRunResponse, auditToolCall } from '../../src/mcp/guardrails.js';
import { setLogHandler, type LogEntry } from '../../src/engine/logger.js';

describe('guardrails', () => {
  beforeEach(() => {
    setGuardrailConfig({});
  });

  it('isDryRun defaults to false', () => {
    expect(isDryRun()).toBe(false);
  });

  it('isDryRun returns true when configured', () => {
    setGuardrailConfig({ dryRun: true });
    expect(isDryRun()).toBe(true);
  });

  it('isToolAllowed returns true with no allowlist', () => {
    expect(isToolAllowed('maad_create')).toBe(true);
    expect(isToolAllowed('anything')).toBe(true);
  });

  it('isToolAllowed filters when allowlist is set', () => {
    setGuardrailConfig({ toolAllowlist: ['maad_get', 'maad_summary'] });
    expect(isToolAllowed('maad_get')).toBe(true);
    expect(isToolAllowed('maad_summary')).toBe(true);
    expect(isToolAllowed('maad_create')).toBe(false);
    expect(isToolAllowed('maad_delete')).toBe(false);
  });

  it('dryRunResponse returns standard shape with dryRun flag', () => {
    const resp = dryRunResponse('maad_create', { docType: 'client' });
    const parsed = JSON.parse(resp.content[0]!.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.dryRun).toBe(true);
    expect(parsed.tool).toBe('maad_create');
    expect(parsed.wouldExecute).toEqual({ docType: 'client' });
  });

  it('auditToolCall does not throw', () => {
    expect(() => auditToolCall('maad_get', { docId: 'test' })).not.toThrow();
  });

  describe('auditToolCall — body redaction (fup-2026-05-19-maadb-pino-redact-write-bodies)', () => {
    let captured: LogEntry[];
    let originalHandler: ((e: LogEntry) => void) | null;

    beforeEach(() => {
      captured = [];
      originalHandler = null;
      setLogHandler((e) => { captured.push(e); });
    });

    afterEach(() => {
      // Restore the default by re-setting a no-op; engine/logger's default
      // handler is module-scoped and not re-exported, but tests that follow
      // re-call setLogHandler in their own beforeEach if they need it.
      if (originalHandler) setLogHandler(originalHandler);
    });

    it('maad_create: body string is replaced with bodyBytes; fields collapses to fieldNames', () => {
      auditToolCall('maad_create', {
        docType: 'client',
        docId: 'cli-acme',
        fields: { name: 'Acme', status: 'active', notes: 'long internal note' },
        body: 'This is the markdown body — it should NOT appear in pino logs verbatim.',
        project: 'demo',
      });

      expect(captured.length).toBe(1);
      const args = captured[0]!.details!.args as Record<string, unknown>;
      // Body content is gone
      expect(args).not.toHaveProperty('body');
      // bodyBytes preserved as utf-8 byte count
      expect(args.bodyBytes).toBe(Buffer.byteLength(
        'This is the markdown body — it should NOT appear in pino logs verbatim.',
        'utf8',
      ));
      // fields collapsed to key list, values stripped
      expect(args).not.toHaveProperty('fields');
      expect(args.fieldNames).toEqual(['name', 'status', 'notes']);
      // Scalars pass through
      expect(args.docType).toBe('client');
      expect(args.docId).toBe('cli-acme');
      expect(args.project).toBe('demo');
    });

    it('maad_update: appendBody is replaced with appendBodyBytes', () => {
      auditToolCall('maad_update', {
        docId: 'cli-acme',
        appendBody: '\n\n## New section\n\nappended content here',
        expectedVersion: 3,
      });

      const args = captured[0]!.details!.args as Record<string, unknown>;
      expect(args).not.toHaveProperty('appendBody');
      expect(args.appendBodyBytes).toBe(Buffer.byteLength(
        '\n\n## New section\n\nappended content here',
        'utf8',
      ));
      expect(args.docId).toBe('cli-acme');
      expect(args.expectedVersion).toBe(3);
    });

    it('maad_update: both body and appendBody projected; absent body is not invented', () => {
      auditToolCall('maad_update', {
        docId: 'cli-acme',
        body: 'replacement body',
        fields: { status: 'closed' },
      });

      const args = captured[0]!.details!.args as Record<string, unknown>;
      expect(args.bodyBytes).toBe(Buffer.byteLength('replacement body', 'utf8'));
      expect(args).not.toHaveProperty('appendBodyBytes');
      expect(args.fieldNames).toEqual(['status']);
    });

    it('bulk records with bodies: aggregated into recordCount + recordBodyBytes', () => {
      auditToolCall('maad_bulk_create', {
        records: [
          { docType: 'client', body: 'aaaa' },          // 4 bytes
          { docType: 'client', body: 'bbbbbbbb' },      // 8 bytes
          { docType: 'client' },                         // no body
        ],
      });

      const args = captured[0]!.details!.args as Record<string, unknown>;
      expect(args).not.toHaveProperty('records');
      expect(args.recordCount).toBe(3);
      expect(args.recordBodyBytes).toBe(12);
    });

    it('bulk updates with appendBody: aggregated into updateCount + updateBodyBytes + updateAppendBodyBytes', () => {
      auditToolCall('maad_bulk_update', {
        updates: [
          { docId: 'a', body: 'xxx' },                // body 3
          { docId: 'b', appendBody: 'yyyyy' },         // append 5
          { docId: 'c', body: 'zz', appendBody: 'q' }, // body 2, append 1
        ],
      });

      const args = captured[0]!.details!.args as Record<string, unknown>;
      expect(args).not.toHaveProperty('updates');
      expect(args.updateCount).toBe(3);
      expect(args.updateBodyBytes).toBe(5);
      expect(args.updateAppendBodyBytes).toBe(6);
    });

    it('redacted-shape callers (count-only) pass through unchanged', () => {
      auditToolCall('maad_bulk_create', { count: 7 });
      const args = captured[0]!.details!.args as Record<string, unknown>;
      expect(args).toEqual({ count: 7 });
    });

    it('extras (e.g. confirm_mode) merge alongside projected args', () => {
      auditToolCall('maad_delete', { docId: 'cli-x', confirm: true }, { confirm_mode: 'confirmed' });
      const details = captured[0]!.details!;
      expect((details.args as Record<string, unknown>).docId).toBe('cli-x');
      expect(details.confirm_mode).toBe('confirmed');
    });

    it('non-string body field is left in place (no false projection)', () => {
      // Defensive: a caller passing body: null or body: 0 should not synthesize bodyBytes.
      auditToolCall('maad_create', { docType: 'client', body: null });
      const args = captured[0]!.details!.args as Record<string, unknown>;
      expect(args).not.toHaveProperty('bodyBytes');
      // null body is treated as "no body field worth logging" and passes through.
      expect(args.body).toBeNull();
    });
  });
});
