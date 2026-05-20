import { describe, it, expect } from 'vitest';
import { getToolsForRole, parseRole } from '../../src/mcp/roles.js';

describe('MCP roles', () => {
  it('reader gets 17 tools', () => {
    const tools = getToolsForRole('reader');
    expect(tools.size).toBe(17);
    expect(tools.has('maad_summary')).toBe(true);
    expect(tools.has('maad_get')).toBe(true);
    expect(tools.has('maad_aggregate')).toBe(true);
    expect(tools.has('maad_changes_since')).toBe(true);
    expect(tools.has('maad_verify')).toBe(true);
    expect(tools.has('maad_find_orphans')).toBe(true);
    expect(tools.has('maad_subscribe')).toBe(true);
    expect(tools.has('maad_unsubscribe')).toBe(true);
    expect(tools.has('maad_create')).toBe(false);
    expect(tools.has('maad_delete')).toBe(false);
  });

  it('writer gets 22 tools (reader + create, update, validate, bulk_create, bulk_update)', () => {
    const tools = getToolsForRole('writer');
    expect(tools.size).toBe(22);
    expect(tools.has('maad_create')).toBe(true);
    expect(tools.has('maad_update')).toBe(true);
    expect(tools.has('maad_validate')).toBe(true);
    expect(tools.has('maad_delete')).toBe(false);
    expect(tools.has('maad_reindex')).toBe(false);
  });

  it('admin gets 37 tools (all)', () => {
    const tools = getToolsForRole('admin');
    expect(tools.size).toBe(37);
    expect(tools.has('maad_delete')).toBe(true);
    expect(tools.has('maad_reindex')).toBe(true);
    expect(tools.has('maad_reload')).toBe(true);
    expect(tools.has('maad_health')).toBe(true);
    expect(tools.has('maad_instance_reload')).toBe(true);
    expect(tools.has('maad_subscribe')).toBe(true);
    expect(tools.has('maad_unsubscribe')).toBe(true);
    expect(tools.has('maad_subscriptions')).toBe(true);
    expect(tools.has('maad_issue_token')).toBe(true);
    expect(tools.has('maad_revoke_token')).toBe(true);
    expect(tools.has('maad_rotate_token')).toBe(true);
    expect(tools.has('maad_list_tokens')).toBe(true);
    expect(tools.has('maad_show_token')).toBe(true);
    // 0.7.10 — destructive cleanup primitives
    expect(tools.has('maad_bulk_delete')).toBe(true);
    expect(tools.has('maad_delete_where')).toBe(true);
    expect(tools.has('maad_purge_soft_deleted')).toBe(true);
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
