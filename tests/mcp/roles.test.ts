import { describe, it, expect } from 'vitest';
import { getMinRoleForTool, getToolsForRole, parseRole } from '../../src/mcp/roles.js';

describe('MCP roles', () => {
  it('classifies guarded operations by authority', () => {
    expect(getMinRoleForTool('maad_create_contract')).toBe('reader');
    expect(getMinRoleForTool('maad_create_guarded')).toBe('writer');
    expect(getToolsForRole('reader').has('maad_create_guarded')).toBe(false);
  });

  it('requires reader role for the document receipt', () => {
    expect(getMinRoleForTool('maad_document_receipt')).toBe('reader');
  });

  it('reader gets 21 tools', () => {
    const tools = getToolsForRole('reader');
    expect(tools.size).toBe(22);
    expect(tools.has('maad_document_receipt')).toBe(true);
    expect(tools.has('maad_summary')).toBe(true);
    expect(tools.has('maad_get')).toBe(true);
    expect(tools.has('maad_aggregate')).toBe(true);
    expect(tools.has('maad_changes_since')).toBe(true);
    expect(tools.has('maad_verify')).toBe(true);
    expect(tools.has('maad_find_orphans')).toBe(true);
    expect(tools.has('maad_semantic_search')).toBe(true);
    expect(tools.has('maad_relationship_paths')).toBe(true);
    expect(tools.has('maad_subscribe')).toBe(true);
    expect(tools.has('maad_unsubscribe')).toBe(true);
    expect(tools.has('maad_create')).toBe(false);
    expect(tools.has('maad_delete')).toBe(false);
  });

  it('writer gets 27 tools (reader + create, update, validate, bulk_create, bulk_update)', () => {
    const tools = getToolsForRole('writer');
    expect(tools.size).toBe(28);
    expect(tools.has('maad_document_receipt')).toBe(true);
    expect(tools.has('maad_create')).toBe(true);
    expect(tools.has('maad_update')).toBe(true);
    expect(tools.has('maad_validate')).toBe(true);
    expect(tools.has('maad_delete')).toBe(false);
    expect(tools.has('maad_reindex')).toBe(false);
  });

  it('admin gets 44 tools (all)', () => {
    const tools = getToolsForRole('admin');
    expect(tools.size).toBe(45);
    expect(tools.has('maad_document_receipt')).toBe(true);
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
    expect(tools.has('maad_repair_where')).toBe(true);
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

describe('MCP roles — completeness', () => {
  it('every tool routed through the session role gate has a role assignment', async () => {
    const { readdirSync, readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const dir = path.resolve(__dirname, '../../src/mcp/tools');
    const gated = new Set<string>();
    for (const file of readdirSync(dir).filter(f => f.endsWith('.ts'))) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      for (const m of source.matchAll(/with(?:Engine|Session)\(\s*ctx,\s*extra,\s*'(maad_[a-z_]+)'/g)) gated.add(m[1]!);
    }
    expect(gated.size).toBeGreaterThan(30);
    const missing = [...gated].filter(name => getMinRoleForTool(name) === null);
    expect(missing).toEqual([]);
  });

  it('reports no role for an unknown tool, which the session gate refuses', () => {
    expect(getMinRoleForTool('maad_not_a_tool')).toBeNull();
  });
});
