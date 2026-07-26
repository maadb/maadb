// ============================================================================
// Discover tools — maad_scan, maad_summary, maad_describe
// ============================================================================

import { z } from 'zod';
import path from 'node:path';
import { statSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { scanFile, scanDirectory } from '../../scanner.js';
import { successResponse, errorResponse, getProvenanceMode } from '../response.js';
import { isContainedIn, isReallyContainedIn } from '../../engine/pathguard.js';
import type { InstanceCtx } from '../ctx.js';
import { withEngine } from '../with-session.js';
import { checkProject } from '../../instructions/manifest.js';

/** Outcome of gating a maad_scan target against the project root. */
export type ScanTarget =
  | { ok: true; absTarget: string; kind: 'file' | 'directory' }
  | { ok: false; code: 'PATH_OUTSIDE_PROJECT' | 'PATH_NOT_FOUND' };

/**
 * Resolve and gate a caller-supplied scan path.
 *
 * Two gates, in this order:
 *
 *  1. Lexical containment — rejects `../` traversal without touching the disk.
 *  2. Canonical containment — rejects paths that resolve outside the root
 *     through a symlink or a Windows junction. The lexical check compares
 *     strings, so `<root>/link/secret.md` passes it while reading from
 *     wherever `link` points; statSync and readFile both follow links, so
 *     containment has to be proven against the real path before any content
 *     is opened.
 *
 * The canonical gate runs after the stat so a genuinely missing file still
 * reports PATH_NOT_FOUND rather than being misreported as an escape —
 * realpath throws on a path that does not exist.
 *
 * Residual: a link retargeted between this check and the subsequent read is
 * not covered. Closing that needs open-then-verify on a handle, which is
 * tracked with the scanner budget work.
 *
 * Exported so the gate is directly testable — the escape it prevents is not
 * observable from the tool's success path.
 */
export function resolveScanTarget(projectRoot: string, requestedPath: string): ScanTarget {
  const absTarget = path.resolve(projectRoot, requestedPath);
  if (!isContainedIn(absTarget, projectRoot)) {
    return { ok: false, code: 'PATH_OUTSIDE_PROJECT' };
  }

  let stat;
  try {
    stat = statSync(absTarget);
  } catch {
    return { ok: false, code: 'PATH_NOT_FOUND' };
  }

  if (!isReallyContainedIn(absTarget, projectRoot)) {
    return { ok: false, code: 'PATH_OUTSIDE_PROJECT' };
  }

  return { ok: true, absTarget, kind: stat.isFile() ? 'file' : 'directory' };
}

export function register(server: McpServer, ctx: InstanceCtx): number {
  server.registerTool('maad_scan', {
    description: 'Analyze raw markdown structure. Works without registry. Use for onboarding new files. Pass a file path for detailed analysis or a directory for corpus-level patterns.',
    inputSchema: z.object({
      path: z.string().describe('File or directory path to scan (relative to project root)'),
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_scan', args, async ({ projectRoot }) => {
    const target = resolveScanTarget(projectRoot, args.path);
    if (!target.ok) {
      const message = target.code === 'PATH_NOT_FOUND'
        ? `Not found: ${args.path}`
        : `Scan path must be within the project root: ${args.path}`;
      return errorResponse([{ code: target.code, message } as any]);
    }

    if (target.kind === 'file') {
      return successResponse(await scanFile(target.absTarget));
    } else {
      return successResponse(await scanDirectory(target.absTarget));
    }
  }));

  server.registerTool('maad_summary', {
    description: 'Lean project snapshot for session bootstrapping. Returns types, counts, sample IDs, totals, warnings. Call maad_describe for subtype inventory detail.',
    inputSchema: z.object({
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_summary', args, ({ engine }) => {
    const baseSummary = engine.summary();
    // 0.12.0 — managed-instruction staleness flag: agents working in the
    // project see drift in their normal boot call; refresh stays
    // operator-pulled (maad_instructions / CLI).
    const staleInstructions = checkProject(engine.getProjectRoot())
      .filter(s => s.state !== 'current')
      .map(s => ({ file: s.relPath, state: s.state }));
    const summary = staleInstructions.length > 0
      ? { ...baseSummary, instructionsStale: staleInstructions }
      : baseSummary;
    const provMode = getProvenanceMode();

    if (provMode === 'off') {
      return successResponse(summary, 'maad_summary');
    }

    const provenanceInstructions = provMode === 'detail'
      ? {
          mode: 'detail',
          instructions: [
            'Tag every data value in your responses with its source:',
            '[T:<tool_name>] = from a specific MAAD tool (e.g. [T:maad_get])',
            '[R] = from memory/recall (unverified)',
            '[R*] = inferred/derived — not directly stated in any source',
            'When mixing sources in a table, add a source column.',
            'If joins require N+1 calls and you skip them, disclose which values were recalled.',
            'Never present recalled data with the same confidence as tool-verified data.',
          ],
        }
      : {
          mode: 'on',
          instructions: [
            'Tag data sources in responses:',
            '[T] = from a MAAD tool call (verified)',
            '[R] = from memory/recall (unverified)',
            'When mixing sources in a table, add a source column or footnote.',
            'Never present recalled data with the same confidence as tool-verified data.',
          ],
        };

    return successResponse({ ...summary, provenance: provenanceInstructions }, 'maad_summary');
  }));

  server.registerTool('maad_describe', {
    description: 'Returns registry types, extraction primitives, document counts, and subtype inventory (deep detail; maad_summary is the lean orientation call).',
    inputSchema: z.object({
      project: z.string().optional().describe('Project name (multi-project mode only)'),
    }),
  }, async (args, extra) => withEngine(ctx, extra, 'maad_describe', args, ({ engine }) => {
    return successResponse(engine.describe());
  }));

  return 3;
}
