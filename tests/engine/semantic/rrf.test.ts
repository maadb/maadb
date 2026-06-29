import { describe, it, expect } from 'vitest';
import { rrfFuse, DEFAULT_RRF_K } from '../../../src/engine/semantic/rrf.js';

describe('rrfFuse', () => {
  it('scores a single list by rank (1/(K+rank))', () => {
    const s = rrfFuse([['a', 'b', 'c']]);
    expect(s.get('a')).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 10);
    expect(s.get('b')).toBeCloseTo(1 / (DEFAULT_RRF_K + 2), 10);
    expect(s.get('a')!).toBeGreaterThan(s.get('b')!);
    expect(s.get('b')!).toBeGreaterThan(s.get('c')!);
  });

  it('sums contributions across lists (agreement wins)', () => {
    // "b" is rank 2 in both lists; "a" is rank 1 in one only.
    const s = rrfFuse([['a', 'b'], ['c', 'b']]);
    expect(s.get('b')).toBeCloseTo(2 / (DEFAULT_RRF_K + 2), 10);
    expect(s.get('a')).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 10);
    // b (in both) beats a (top of one) at K=60
    expect(s.get('b')!).toBeGreaterThan(s.get('a')!);
  });

  it('respects K — larger K flattens rank advantage', () => {
    const tight = rrfFuse([['a', 'b']], 1);
    const flat = rrfFuse([['a', 'b']], 1000);
    const tightGap = tight.get('a')! - tight.get('b')!;
    const flatGap = flat.get('a')! - flat.get('b')!;
    expect(tightGap).toBeGreaterThan(flatGap);
  });

  it('empty input yields an empty map', () => {
    expect(rrfFuse([]).size).toBe(0);
    expect(rrfFuse([[]]).size).toBe(0);
  });
});
