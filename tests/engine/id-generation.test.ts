import { describe, it, expect, vi } from 'vitest';
import { generateDocId, type ExistingDocIdSupplier } from '../../src/engine/helpers.js';

const year = new Date().getFullYear();

function supplier(ids: readonly string[]) {
  return vi.fn<ExistingDocIdSupplier>(() => ids);
}

describe('generateDocId', () => {
  it('uses a name slug without calling the supplier', () => {
    const ids = supplier([`cli-${year}-007`]);
    expect(generateDocId('cli', { name: 'Acme Corp!' }, ids)).toBe('cli-acme-corp');
    expect(ids).not.toHaveBeenCalled();
  });

  it('falls back to a title slug without calling the supplier', () => {
    const ids = supplier([]);
    expect(generateDocId('cas', { title: 'Big Case' }, ids)).toBe('cas-big-case');
    expect(ids).not.toHaveBeenCalled();
  });

  it('calls the supplier once on the sequence path and allocates max + 1', () => {
    const ids = supplier([`note-${year}-002`, `note-${year}-010`, `note-${year - 1}-099`, `cli-${year}-500`]);
    expect(generateDocId('note', { author: 'a' }, ids)).toBe(`note-${year}-011`);
    expect(ids).toHaveBeenCalledTimes(1);
  });

  it('samples when name/title yield no usable slug', () => {
    const empty = supplier([]);
    expect(generateDocId('cli', { name: '!!!' }, empty)).toBe(`cli-${year}-001`);
    expect(empty).toHaveBeenCalledTimes(1);

    const nonString = supplier([`cli-${year}-004`]);
    expect(generateDocId('cli', { name: 42 }, nonString)).toBe(`cli-${year}-005`);
    expect(nonString).toHaveBeenCalledTimes(1);
  });

  it('counts explicit sequence-shaped IDs and IDs from other types sharing the prefix', () => {
    const ids = supplier([`tk-${year}-003`, `tk-${year}-120`]);
    expect(generateDocId('tk', {}, ids)).toBe(`tk-${year}-121`);
  });

  it('keeps array callers and the no-IDs default unchanged', () => {
    expect(generateDocId('cas', {}, [`cas-${year}-041`])).toBe(`cas-${year}-042`);
    expect(generateDocId('cas', {})).toBe(`cas-${year}-001`);
  });
});
