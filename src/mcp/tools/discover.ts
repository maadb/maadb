// ============================================================================
// Discover tools — maad.scan, maad.summary, maad.describe
// ============================================================================

import { z } from 'zod';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MaadEngine } from '../../engine.js';
import { scanFile, scanDirectory } from '../../scanner.js';
import { successResponse, errorResponse, getProvenanceMode } from '../response.js';
import { isContainedIn } from '../../engine/pathguard.js';

export function register(server: McpServer, engine: MaadEngine, projectRoot: string): void {
  server.registerTool('maad.scan', {
    description: 'Analyze raw markdown structure. Works without registry. Use for onboarding new files. Pass a file path for detailed analysis or a directory for corpus-level patterns.',
    inputSchema: z.object({
      path: z.string().describe('File or directory path to scan (relative to project root)'),
    }),
  }, async (args) => {
    const absTarget = path.resolve(projectRoot, args.path);
    if (!isContainedIn(absTarget, projectRoot)) {
      return errorResponse([{ code: 'PATH_OUTSIDE_PROJECT', message: `Scan path must be within the project root: ${args.path}` } as any]);
    }

    const { statSync } = await import('node:fs');
    let stat;
    try {
      stat = statSync(absTarget);
    } catch {
      return errorResponse([{ code: 'PATH_NOT_FOUND', message: `Not found: ${args.path}` } as any]);
    }

    if (stat.isFile()) {
      return successResponse(await scanFile(absTarget));
    } else {
      return successResponse(await scanDirectory(absTarget));
    }
  });

  server.registerTool('maad.summary', {
    description: 'Returns the live indexed project snapshot for session bootstrapping. Use this first every session. Returns types, counts, sample IDs, and object inventory.',
    inputSchema: z.object({}),
  }, () => {
    const summary = engine.summary();
    const provMode = getProvenanceMode();

    if (provMode === 'off') {
      return successResponse(summary, 'maad.summary');
    }

    const provenanceInstructions = provMode === 'detail'
      ? {
          mode: 'detail',
          instructions: [
            'Tag every data value in your responses with its source:',
            '[T:<tool_name>] = from a specific MAAD tool (e.g. [T:maad.get])',
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

    return successResponse({ ...summary, provenance: provenanceInstructions }, 'maad.summary');
  });

  server.registerTool('maad.describe', {
    description: 'Returns registry types, extraction primitives, and document counts.',
    inputSchema: z.object({}),
  }, () => {
    return successResponse(engine.describe());
  });
}
