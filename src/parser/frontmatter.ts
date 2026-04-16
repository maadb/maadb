// ============================================================================
// Frontmatter Parser
// Extracts YAML frontmatter from a markdown file using gray-matter.
// ============================================================================

import { parseMatter } from './matter.js';
import { ok, singleErr, type Result } from '../errors.js';
import type { FilePath } from '../types.js';

export interface FrontmatterResult {
  frontmatter: Record<string, unknown>;
  body: string;
  bodyStartLine: number;
}

export function parseFrontmatter(raw: string, filePath: FilePath): Result<FrontmatterResult> {
  try {
    const parsed = parseMatter(raw);

    if (typeof parsed.data !== 'object' || parsed.data === null || Array.isArray(parsed.data)) {
      return singleErr('PARSE_ERROR', 'Frontmatter must be a YAML mapping', { file: filePath, line: 1, col: 1 });
    }

    const frontmatter = parsed.data as Record<string, unknown>;

    // Calculate bodyStartLine: count lines in the raw content up to where the body begins
    // gray-matter.matter gives us the raw frontmatter string between the --- delimiters
    let bodyStartLine = 1;
    if (parsed.matter && parsed.matter.length > 0) {
      // Opening --- (line 1) + frontmatter lines + closing ---
      const fmLines = parsed.matter.split('\n').length;
      bodyStartLine = fmLines + 2; // +1 for opening ---, +1 for closing ---
    }

    return ok({
      frontmatter,
      body: parsed.content,
      bodyStartLine,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown parse error';
    return singleErr('PARSE_ERROR', `Failed to parse frontmatter: ${message}`, { file: filePath, line: 1, col: 1 });
  }
}
