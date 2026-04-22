import { describe, it, expect, afterEach } from 'vitest';
import { successResponse, errorResponse, resultToResponse, setProvenanceMode, attachWarnings, attachMeta, guardResponseSize, responseMaxBytes } from '../../src/mcp/response.js';
import type { Result } from '../../src/errors.js';
import type { ValidationWarning } from '../../src/types.js';

describe('MCP response contract', () => {
  it('successResponse wraps data in standard shape', () => {
    const resp = successResponse({ foo: 'bar' });
    expect(resp.content).toHaveLength(1);
    expect(resp.content[0]!.type).toBe('text');

    const parsed = JSON.parse(resp.content[0]!.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ foo: 'bar' });
  });

  it('errorResponse wraps errors in standard shape', () => {
    const resp = errorResponse([{ code: 'FILE_NOT_FOUND', message: 'Not found', details: {} }] as any);
    const parsed = JSON.parse(resp.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].code).toBe('FILE_NOT_FOUND');
  });

  it('resultToResponse handles success Result', () => {
    const result: Result<string> = { ok: true, value: 'hello' };
    const resp = resultToResponse(result);
    const parsed = JSON.parse(resp.content[0]!.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBe('hello');
  });

  it('resultToResponse handles error Result', () => {
    const result: Result<string> = {
      ok: false,
      errors: [{ code: 'SCHEMA_NOT_FOUND', message: 'No schema', details: {} }],
    };
    const resp = resultToResponse(result);
    const parsed = JSON.parse(resp.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0].code).toBe('SCHEMA_NOT_FOUND');
  });

  it('response shape is always { ok, data } or { ok, errors }', () => {
    const success = JSON.parse(successResponse(42).content[0]!.text);
    expect(Object.keys(success).sort()).toEqual(['data', 'ok']);

    const error = JSON.parse(errorResponse([{ code: 'X', message: 'Y' }] as any).content[0]!.text);
    expect(Object.keys(error).sort()).toEqual(['errors', 'ok']);
  });
});

describe('attachWarnings — 0.6.7 Phase 3 plumbing', () => {
  it('is a no-op when warnings is undefined', () => {
    const base = successResponse({ docId: 'cli-acme' });
    const out = attachWarnings(base, undefined);
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed._meta).toBeUndefined();
  });

  it('is a no-op when warnings is an empty array (avoid polluting clean responses)', () => {
    const base = successResponse({ docId: 'cli-acme' });
    const out = attachWarnings(base, []);
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed._meta).toBeUndefined();
  });

  it('attaches non-empty warnings under _meta.warnings[]', () => {
    const warnings: ValidationWarning[] = [
      {
        field: 'opened_at',
        message: 'stub warning for plumbing test',
        code: 'PRECISION_COARSER_THAN_DECLARED',
        location: null,
      },
    ];
    const base = successResponse({ docId: 'cli-acme' });
    const out = attachWarnings(base, warnings);
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed._meta).toBeDefined();
    expect(parsed._meta.warnings).toEqual(warnings);
  });

  it('merges with pre-existing _meta fields from attachMeta (e.g. request_id)', () => {
    const warnings: ValidationWarning[] = [
      { field: 'ts', message: 'drift', code: 'PRECISION_COARSER_THAN_DECLARED', location: null },
    ];
    const base = successResponse({ ok: true });
    const withRequestId = attachMeta(base, { request_id: 'req-123' });
    const out = attachWarnings(withRequestId, warnings);
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed._meta.request_id).toBe('req-123');
    expect(parsed._meta.warnings).toEqual(warnings);
  });

  it('preserves data payload untouched', () => {
    const warnings: ValidationWarning[] = [
      { field: 'x', message: 'y', code: 'PRECISION_COARSER_THAN_DECLARED', location: null },
    ];
    const base = successResponse({ docId: 'cli-acme', version: 1 });
    const out = attachWarnings(base, warnings);
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed.data).toEqual({ docId: 'cli-acme', version: 1 });
    expect(parsed.ok).toBe(true);
  });
});

describe('guardResponseSize — 0.7.1 R3 projected-size guard', () => {
  const originalEnv = process.env['MAAD_RESPONSE_MAX_BYTES'];
  afterEach(() => {
    if (originalEnv === undefined) delete process.env['MAAD_RESPONSE_MAX_BYTES'];
    else process.env['MAAD_RESPONSE_MAX_BYTES'] = originalEnv;
  });

  it('passes through small success responses unchanged', () => {
    const base = successResponse({ rows: [{ a: 1 }, { b: 2 }] });
    const out = guardResponseSize(base, { tool: 'maad_query' });
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.rows).toHaveLength(2);
  });

  it('returns RESPONSE_TOO_LARGE when payload exceeds cap', () => {
    process.env['MAAD_RESPONSE_MAX_BYTES'] = '256';
    // Build a payload reliably over 256 bytes once JSON-serialized.
    const bigRow = { description: 'x'.repeat(200) };
    const base = successResponse({ rows: [bigRow, bigRow, bigRow] });
    const out = guardResponseSize(base, { tool: 'maad_query' });
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0].code).toBe('RESPONSE_TOO_LARGE');
    expect(parsed.errors[0].details.capBytes).toBe(256);
    expect(parsed.errors[0].details.projectedBytes).toBeGreaterThan(256);
    expect(parsed.errors[0].details.tool).toBe('maad_query');
    expect(parsed.errors[0].details.hint).toContain('projection');
  });

  it('respects MAAD_RESPONSE_MAX_BYTES env override', () => {
    process.env['MAAD_RESPONSE_MAX_BYTES'] = '131072';
    expect(responseMaxBytes()).toBe(131072);
    delete process.env['MAAD_RESPONSE_MAX_BYTES'];
    expect(responseMaxBytes()).toBe(65536);
  });

  it('falls back to default cap on invalid env value', () => {
    process.env['MAAD_RESPONSE_MAX_BYTES'] = 'not-a-number';
    expect(responseMaxBytes()).toBe(65536);
    process.env['MAAD_RESPONSE_MAX_BYTES'] = '-100';
    expect(responseMaxBytes()).toBe(65536);
    process.env['MAAD_RESPONSE_MAX_BYTES'] = '0';
    expect(responseMaxBytes()).toBe(65536);
  });

  it('does not re-wrap error responses even when large', () => {
    process.env['MAAD_RESPONSE_MAX_BYTES'] = '128';
    const base = errorResponse([{
      code: 'VALIDATION_FAILED',
      message: 'x'.repeat(500),
      details: { extraneous: 'x'.repeat(500) },
    }] as any);
    const out = guardResponseSize(base, { tool: 'maad_query' });
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed.ok).toBe(false);
    expect(parsed.errors[0].code).toBe('VALIDATION_FAILED');
  });

  it('uses a custom hint when provided', () => {
    process.env['MAAD_RESPONSE_MAX_BYTES'] = '64';
    const base = successResponse({ data: 'x'.repeat(200) });
    const out = guardResponseSize(base, { tool: 'maad_join', hint: 'Try fewer refs' });
    const parsed = JSON.parse(out.content[0]!.text);
    expect(parsed.errors[0].details.hint).toBe('Try fewer refs');
  });
});

describe('Provenance mode', () => {
  afterEach(() => setProvenanceMode('off'));

  it('does not include _source when provenance is off', () => {
    setProvenanceMode('off');
    const resp = successResponse({ foo: 'bar' }, 'maad_get');
    const parsed = JSON.parse(resp.content[0]!.text);
    expect(parsed._source).toBeUndefined();
  });

  it('includes _source when provenance is on', () => {
    setProvenanceMode('on');
    const resp = successResponse({ foo: 'bar' }, 'maad_get');
    const parsed = JSON.parse(resp.content[0]!.text);
    expect(parsed._source).toBe('maad_get');
  });

  it('includes _source when provenance is detail', () => {
    setProvenanceMode('detail');
    const resp = successResponse({ foo: 'bar' }, 'maad_query');
    const parsed = JSON.parse(resp.content[0]!.text);
    expect(parsed._source).toBe('maad_query');
  });

  it('does not include _source when no tool name provided', () => {
    setProvenanceMode('on');
    const resp = successResponse({ foo: 'bar' });
    const parsed = JSON.parse(resp.content[0]!.text);
    expect(parsed._source).toBeUndefined();
  });

  it('resultToResponse passes tool name through', () => {
    setProvenanceMode('on');
    const result: Result<string> = { ok: true, value: 'hello' };
    const resp = resultToResponse(result, 'maad_search');
    const parsed = JSON.parse(resp.content[0]!.text);
    expect(parsed._source).toBe('maad_search');
  });
});
