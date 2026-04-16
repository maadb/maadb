import { describe, it, expect, afterEach } from 'vitest';
import { successResponse, errorResponse, resultToResponse, setProvenanceMode, attachWarnings, attachMeta } from '../../src/mcp/response.js';
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
