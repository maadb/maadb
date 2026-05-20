// ============================================================================
// 0.7.10 — destructive-cleanup per-tool maxRecords cap. Default 100, hard
// ceiling 1000, per-tool env override MAAD_CLEANUP_MAX_RECORDS_<TOOL_SUFFIX>.
// Tool-call arg primary, env secondary, default tertiary.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { resolveCleanupMaxRecords, checkCleanupSize } from '../../src/mcp/bulk-cap.js';

describe('resolveCleanupMaxRecords', () => {
  it('returns default 100 when no arg and no env override', () => {
    expect(resolveCleanupMaxRecords('BULK_DELETE', undefined, {} as NodeJS.ProcessEnv)).toBe(100);
  });

  it('honors arg over env', () => {
    expect(resolveCleanupMaxRecords('BULK_DELETE', 25, {
      MAAD_CLEANUP_MAX_RECORDS_BULK_DELETE: '250',
    } as NodeJS.ProcessEnv)).toBe(25);
  });

  it('honors env when arg is undefined', () => {
    expect(resolveCleanupMaxRecords('BULK_DELETE', undefined, {
      MAAD_CLEANUP_MAX_RECORDS_BULK_DELETE: '250',
    } as NodeJS.ProcessEnv)).toBe(250);
  });

  it('clamps arg to the hard ceiling of 1000', () => {
    expect(resolveCleanupMaxRecords('BULK_DELETE', 5000, {} as NodeJS.ProcessEnv)).toBe(1000);
  });

  it('clamps env to the hard ceiling of 1000', () => {
    expect(resolveCleanupMaxRecords('BULK_DELETE', undefined, {
      MAAD_CLEANUP_MAX_RECORDS_BULK_DELETE: '5000',
    } as NodeJS.ProcessEnv)).toBe(1000);
  });

  it('floors arg to 1 when given <1', () => {
    expect(resolveCleanupMaxRecords('BULK_DELETE', 0, {} as NodeJS.ProcessEnv)).toBe(100);
    expect(resolveCleanupMaxRecords('BULK_DELETE', -5, {} as NodeJS.ProcessEnv)).toBe(100);
  });

  it('ignores garbage env values, falls back to default', () => {
    expect(resolveCleanupMaxRecords('BULK_DELETE', undefined, {
      MAAD_CLEANUP_MAX_RECORDS_BULK_DELETE: 'banana',
    } as NodeJS.ProcessEnv)).toBe(100);
  });

  it('per-tool suffix is honored', () => {
    expect(resolveCleanupMaxRecords('DELETE_WHERE', undefined, {
      MAAD_CLEANUP_MAX_RECORDS_DELETE_WHERE: '200',
      MAAD_CLEANUP_MAX_RECORDS_BULK_DELETE: '999',
    } as NodeJS.ProcessEnv)).toBe(200);

    expect(resolveCleanupMaxRecords('PURGE_SOFT_DELETED', undefined, {
      MAAD_CLEANUP_MAX_RECORDS_PURGE_SOFT_DELETED: '50',
    } as NodeJS.ProcessEnv)).toBe(50);
  });

  it('accepts integer-valued arg, truncates fractions', () => {
    expect(resolveCleanupMaxRecords('BULK_DELETE', 75.9, {} as NodeJS.ProcessEnv)).toBe(75);
  });
});

describe('checkCleanupSize', () => {
  it('returns null when count <= max', () => {
    expect(checkCleanupSize('maad_bulk_delete', 50, 100)).toBeNull();
    expect(checkCleanupSize('maad_bulk_delete', 100, 100)).toBeNull();
  });

  it('returns rejection when count > max', () => {
    const r = checkCleanupSize('maad_bulk_delete', 250, 100);
    expect(r).not.toBeNull();
    expect(r!.tool).toBe('maad_bulk_delete');
    expect(r!.received).toBe(250);
    expect(r!.limit).toBe(100);
    expect(r!.suggestedChunkSize).toBe(100);
    expect(r!.message).toContain('250');
    expect(r!.message).toContain('100');
    expect(r!.message.toLowerCase()).toContain('chunk');
  });
});
