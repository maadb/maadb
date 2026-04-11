import { describe, it, expect, beforeEach } from 'vitest';
import { setGuardrailConfig, isDryRun, isToolAllowed, dryRunResponse, auditToolCall } from '../../src/mcp/guardrails.js';

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
});
