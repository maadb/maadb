// ============================================================================
// 0.7.11 — maad_search rejects unknown primitive values at the tool boundary
// instead of silently returning zero rows from a SQL miss on the primitive
// column. Engine layer unchanged (typed contract) — gate lives at MCP and
// CLI boundaries where raw user input arrives.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { isValidPrimitive, PRIMITIVES } from '../../src/types.js';

describe('isValidPrimitive — primitive enum guard', () => {
  it('accepts every primitive declared in PRIMITIVES', () => {
    for (const p of PRIMITIVES) {
      expect(isValidPrimitive(p)).toBe(true);
    }
  });

  it('rejects the three names that surfaced the diagnostic gap', () => {
    expect(isValidPrimitive('doc')).toBe(false);
    expect(isValidPrimitive('field')).toBe(false);
    expect(isValidPrimitive('text')).toBe(false);
  });

  it('rejects empty string and whitespace', () => {
    expect(isValidPrimitive('')).toBe(false);
    expect(isValidPrimitive(' ')).toBe(false);
    expect(isValidPrimitive('entity ')).toBe(false);
  });

  it('is case-sensitive — primitives are lower-case', () => {
    expect(isValidPrimitive('Entity')).toBe(false);
    expect(isValidPrimitive('ENTITY')).toBe(false);
  });

  it('PRIMITIVES contains the 11 documented values and nothing else', () => {
    expect([...PRIMITIVES].sort()).toEqual([
      'amount',
      'contact',
      'date',
      'duration',
      'entity',
      'identifier',
      'location',
      'measure',
      'media',
      'percentage',
      'quantity',
    ]);
  });
});
