import { describe, it, expect } from 'vitest';
import { getToolsForRole, parseRole } from '../../src/mcp/roles.js';

describe('MCP roles', () => {
  it('reader gets 11 tools', () => {
    const tools = getToolsForRole('reader');
    expect(tools.size).toBe(11);
    expect(tools.has('maad.summary')).toBe(true);
    expect(tools.has('maad.get')).toBe(true);
    expect(tools.has('maad.aggregate')).toBe(true);
    expect(tools.has('maad.create')).toBe(false);
    expect(tools.has('maad.delete')).toBe(false);
  });

  it('writer gets 14 tools (reader + create, update, validate)', () => {
    const tools = getToolsForRole('writer');
    expect(tools.size).toBe(14);
    expect(tools.has('maad.create')).toBe(true);
    expect(tools.has('maad.update')).toBe(true);
    expect(tools.has('maad.validate')).toBe(true);
    expect(tools.has('maad.delete')).toBe(false);
    expect(tools.has('maad.reindex')).toBe(false);
  });

  it('admin gets 18 tools (all)', () => {
    const tools = getToolsForRole('admin');
    expect(tools.size).toBe(18);
    expect(tools.has('maad.delete')).toBe(true);
    expect(tools.has('maad.reindex')).toBe(true);
    expect(tools.has('maad.reload')).toBe(true);
    expect(tools.has('maad.health')).toBe(true);
  });

  it('parseRole defaults to reader for invalid input', () => {
    expect(parseRole(undefined)).toBe('reader');
    expect(parseRole('invalid')).toBe('reader');
    expect(parseRole('')).toBe('reader');
  });

  it('parseRole accepts valid roles', () => {
    expect(parseRole('reader')).toBe('reader');
    expect(parseRole('writer')).toBe('writer');
    expect(parseRole('admin')).toBe('admin');
  });
});
