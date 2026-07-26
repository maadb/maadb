// ============================================================================
// 0.7.6 — Doc ID safety validator unit tests.
// ============================================================================

import { describe, it, expect } from 'vitest';
import { checkDocIdSafe, DOC_ID_MAX_LEN } from '../../src/engine/docid-safe.js';

describe('checkDocIdSafe — accepts safe IDs', () => {
  it.each([
    'cli-acme',
    'cas-2026-001',
    'note-some-thing-here',
    'a',
    'jrn-2026-001',
    'mem-a-long-hyphenated-identifier-truncated-x',
    'agt-claude-dev',
    // Mixed case is allowed
    'Acme123',
    // Internal dots are fine (e.g. schema refs)
    'client.v1',
    // Internal underscores
    'snake_case_id',
  ])('accepts %s', (id) => {
    expect(checkDocIdSafe(id)).toBeNull();
  });
});

describe('checkDocIdSafe — rejects path-traversal attempts', () => {
  it('rejects "../" prefix', () => {
    const r = checkDocIdSafe('../escape');
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('LEADING_DOT');
  });

  it('rejects ".." substring', () => {
    const r = checkDocIdSafe('foo..bar');
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('CONTAINS_DOTDOT');
  });

  it('rejects forward slash', () => {
    const r = checkDocIdSafe('foo/bar');
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('INVALID_CHARS');
  });

  it('rejects backslash (Windows path separator)', () => {
    const r = checkDocIdSafe('foo\\bar');
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('INVALID_CHARS');
  });

  it('rejects absolute Unix-style path', () => {
    const r = checkDocIdSafe('/etc/passwd');
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('INVALID_CHARS');
  });

  it('rejects absolute Windows-style path', () => {
    const r = checkDocIdSafe('C:\\Windows\\System32');
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('INVALID_CHARS');
  });
});

describe('checkDocIdSafe — rejects control chars and null bytes', () => {
  it('rejects NUL byte', () => {
    const r = checkDocIdSafe('foo\x00bar');
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('CONTROL_CHARS');
  });

  it('rejects newline', () => {
    const r = checkDocIdSafe('foo\nbar');
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('CONTROL_CHARS');
  });

  it('rejects tab', () => {
    const r = checkDocIdSafe('foo\tbar');
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('CONTROL_CHARS');
  });

  it('rejects carriage return', () => {
    const r = checkDocIdSafe('foo\rbar');
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('CONTROL_CHARS');
  });
});

describe('checkDocIdSafe — rejects Windows reserved device names', () => {
  it.each(['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'COM9', 'LPT1', 'LPT9'])(
    'rejects %s as Windows-reserved',
    (id) => {
      const r = checkDocIdSafe(id);
      expect(r).not.toBeNull();
      expect(r!.reason).toBe('WINDOWS_RESERVED');
    },
  );

  it('accepts CON as a substring of a longer name', () => {
    expect(checkDocIdSafe('console-log')).toBeNull();
  });
});

describe('checkDocIdSafe — length and emptiness', () => {
  it('rejects empty string', () => {
    const r = checkDocIdSafe('');
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('EMPTY');
  });

  it('accepts at exactly the max length', () => {
    const id = 'a' + 'b'.repeat(DOC_ID_MAX_LEN - 1);
    expect(id.length).toBe(DOC_ID_MAX_LEN);
    expect(checkDocIdSafe(id)).toBeNull();
  });

  it('rejects one over the max length', () => {
    const id = 'a' + 'b'.repeat(DOC_ID_MAX_LEN);
    expect(id.length).toBe(DOC_ID_MAX_LEN + 1);
    const r = checkDocIdSafe(id);
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('TOO_LONG');
  });
});

describe('checkDocIdSafe — rejects unicode and exotic chars', () => {
  it.each([
    'café',          // accented latin
    '日本語',         // CJK
    'foo🚀bar',      // emoji
    'foo bar',       // space
    'foo;rm -rf',    // shell metachars
    '$(whoami)',     // command substitution lookalike
    '`backtick`',    // backtick
    'foo|bar',       // pipe
    'foo*bar',       // glob
    'foo?bar',       // glob
    'foo[bar]',      // glob
    '<script>',      // angle brackets
  ])('rejects %s', (id) => {
    const r = checkDocIdSafe(id);
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('INVALID_CHARS');
  });
});

describe('checkDocIdSafe — rejects edge-case shapes', () => {
  it('rejects trailing dot', () => {
    const r = checkDocIdSafe('foo.');
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('INVALID_CHARS');
  });

  it('rejects trailing dash', () => {
    const r = checkDocIdSafe('foo-');
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('INVALID_CHARS');
  });

  it('rejects leading dash', () => {
    const r = checkDocIdSafe('-foo');
    expect(r).not.toBeNull();
    expect(r!.reason).toBe('INVALID_CHARS');
  });
});
