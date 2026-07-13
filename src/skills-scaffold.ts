// ============================================================================
// Skills Scaffold — ensures managed instruction files exist in a project
//
// Called by:
//   - MCP lifecycle after engine.init() succeeds (per-session bootstrap)
//   - `maad init` CLI (full project scaffold)
//   - EnginePool on per-project bind
//
// STRICTLY create-if-absent — never overwrites, so an engine upgrade alone
// modifies zero files in an existing project. Updating existing files is the
// job of `maad instructions refresh` (operator-pulled). New files are written
// stamped via the instructions manifest so their vintage is detectable.
// Failure is non-fatal to the caller; log and continue so an unwritable
// project dir never blocks the engine from starting.
// ============================================================================

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MANAGED_ARTIFACTS, stampContent, checkProject } from './instructions/manifest.js';
import { logInstructionsOutdated } from './logging.js';
import { logger } from './engine/logger.js';

export interface SkillsScaffoldResult {
  created: string[];
  skipped: string[];
  errors: Array<{ file: string; message: string }>;
}

export function ensureProjectSkills(projectRoot: string): SkillsScaffoldResult {
  const result: SkillsScaffoldResult = { created: [], skipped: [], errors: [] };

  for (const artifact of MANAGED_ARTIFACTS) {
    const filePath = path.join(projectRoot, artifact.relPath);
    if (existsSync(filePath)) {
      result.skipped.push(artifact.relPath);
      continue;
    }
    try {
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, stampContent(artifact.name, artifact.generate()), 'utf-8');
      result.created.push(artifact.relPath);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      result.errors.push({ file: artifact.relPath, message });
    }
  }

  return result;
}

/**
 * Advisory-only staleness signal, emitted once per project bind. Never
 * writes: stale files are reported to the ops log so operators (and the
 * daily walkthrough) see them; refresh stays operator-pulled.
 */
export function emitInstructionsAdvisory(projectRoot: string): void {
  try {
    const stale = checkProject(projectRoot).filter(s => s.state !== 'current');
    if (stale.length === 0) return;
    logInstructionsOutdated({
      project_root: projectRoot,
      stale: stale.map(s => ({ file: s.relPath, state: s.state })),
    });
    logger.info('lifecycle', 'instructions',
      `Managed instructions not current (${stale.map(s => `${s.relPath}:${s.state}`).join(', ')}) — run \`maad instructions check\``);
  } catch {
    // Best-effort: an unreadable project dir must never block startup.
  }
}
