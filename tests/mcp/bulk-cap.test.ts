// ============================================================================
// 0.7.3 — bulk-tool 50-item cap.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { checkBulkSize, getBulkMaxItems } from '../../src/mcp/bulk-cap.js';

describe('getBulkMaxItems — env override', () => {
  it('defaults to 50 when env unset', () => {
    expect(getBulkMaxItems({})).toBe(50);
  });

  it('honors MAAD_BULK_MAX_ITEMS when set to a positive integer', () => {
    expect(getBulkMaxItems({ MAAD_BULK_MAX_ITEMS: '100' })).toBe(100);
    expect(getBulkMaxItems({ MAAD_BULK_MAX_ITEMS: '1' })).toBe(1);
  });

  it('clamps to hard ceiling of 1000', () => {
    expect(getBulkMaxItems({ MAAD_BULK_MAX_ITEMS: '5000' })).toBe(1000);
  });

  it('falls back to default for malformed values', () => {
    expect(getBulkMaxItems({ MAAD_BULK_MAX_ITEMS: '0' })).toBe(50);
    expect(getBulkMaxItems({ MAAD_BULK_MAX_ITEMS: '-1' })).toBe(50);
    expect(getBulkMaxItems({ MAAD_BULK_MAX_ITEMS: 'abc' })).toBe(50);
  });
});

describe('checkBulkSize — boundary behavior', () => {
  it('returns null at the cap (50 items ok)', () => {
    expect(checkBulkSize('maad_bulk_create', 50, {})).toBeNull();
  });

  it('returns null below the cap', () => {
    expect(checkBulkSize('maad_bulk_create', 1, {})).toBeNull();
    expect(checkBulkSize('maad_bulk_create', 49, {})).toBeNull();
  });

  it('returns rejection for 51 items', () => {
    const r = checkBulkSize('maad_bulk_create', 51, {});
    expect(r).not.toBeNull();
    expect(r!.tool).toBe('maad_bulk_create');
    expect(r!.received).toBe(51);
    expect(r!.limit).toBe(50);
    expect(r!.suggestedChunkSize).toBe(50);
    expect(r!.message).toMatch(/at most 50/);
    expect(r!.message).toMatch(/Split into chunks/);
  });

  it('rejection echoes the calling tool name', () => {
    const r = checkBulkSize('maad_bulk_update', 200, {});
    expect(r!.tool).toBe('maad_bulk_update');
    expect(r!.received).toBe(200);
  });

  it('honors env override on the cap', () => {
    expect(checkBulkSize('maad_bulk_create', 75, { MAAD_BULK_MAX_ITEMS: '100' })).toBeNull();
    const r = checkBulkSize('maad_bulk_create', 101, { MAAD_BULK_MAX_ITEMS: '100' });
    expect(r).not.toBeNull();
    expect(r!.limit).toBe(100);
  });
});
