// Agent-instruction steering rules. Originally 0.7.1 (aggregate/join trigger
// rules); rewritten for the instruction-lifecycle rework: MAAD.md is the
// static canonical instruction file and must keep the composed-primitive
// steering; CLAUDE.md/AGENTS.md are thin created-once pointers.

import { describe, it, expect } from 'vitest';
import { generateMaadMd } from '../../src/maad-md.js';
import { generateClaudeMd, generateAgentsMd } from '../../src/claude-md.js';

describe('generateMaadMd — composed-primitive steering', () => {
  const md = generateMaadMd();

  it('pushes aggregate over iterating records', () => {
    expect(md).toContain('maad_aggregate');
    expect(md).toContain('Use instead of iterating records');
  });

  it('mentions multi-hop ref-chain grammar for cross-type work', () => {
    expect(md).toContain('a->b->c');
  });

  it('pushes join over query/get chains', () => {
    expect(md).toContain('maad_join');
    expect(md).toContain('Use instead of query → get → get chains');
  });

  it('keeps schema-first, sequential-mutation, and warnings-inspection invariants', () => {
    expect(md).toContain('maad_schema');
    expect(md).toContain('Sequential mutations');
    expect(md).toContain('_meta.warnings');
    expect(md).toContain('FRONTMATTER_GUARD');
    expect(md).toContain('expectedVersion');
  });

  it('covers multi-project boot, subscriptions, and recovery routing', () => {
    expect(md).toContain('maad_use_project');
    expect(md).toContain('maad_subscribe');
    expect(md).toContain('maad_changes_since');
    expect(md).toContain('INDEX_EMPTY');
    expect(md).toContain('READ_ONLY');
  });
});

describe('provider pointers — thin, created-once', () => {
  it('CLAUDE.md and AGENTS.md point at MAAD.md and stay small', () => {
    for (const md of [generateClaudeMd(), generateAgentsMd()]) {
      expect(md).toContain('MAAD.md');
      expect(md).toContain('MCP tools');
      expect(md).toContain('never overwritten by the engine');
      expect(md.split('\n').length).toBeLessThan(25);
    }
  });
});
