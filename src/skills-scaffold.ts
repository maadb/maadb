// ============================================================================
// Skills Scaffold — ensures _skills/ guide files exist in a project
//
// Called by:
//   - MCP lifecycle after engine.init() succeeds (per-session bootstrap)
//   - `maad init` CLI (full project scaffold)
//   - Future EnginePool (0.4.0) on first per-project bind
//
// Never overwrites existing files — protects user customizations. Failure is
// non-fatal to the caller; log and continue so an unwritable _skills/ never
// blocks the engine from starting.
// ============================================================================

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { generateSchemaGuide, generateImportGuide } from './skill-files.js';
import { generateArchitectSkill } from './architect.js';

export interface SkillsScaffoldResult {
  created: string[];
  skipped: string[];
  errors: Array<{ file: string; message: string }>;
}

interface SkillFile {
  name: string;
  generator: () => string;
}

const SKILL_FILES: SkillFile[] = [
  { name: 'architect-core.md', generator: generateArchitectSkill },
  { name: 'schema-guide.md', generator: generateSchemaGuide },
  { name: 'import-guide.md', generator: generateImportGuide },
];

export function ensureProjectSkills(projectRoot: string): SkillsScaffoldResult {
  const result: SkillsScaffoldResult = { created: [], skipped: [], errors: [] };
  const skillDir = path.join(projectRoot, '_skills');

  try {
    if (!existsSync(skillDir)) mkdirSync(skillDir, { recursive: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    result.errors.push({ file: '_skills/', message });
    return result;
  }

  for (const skill of SKILL_FILES) {
    const filePath = path.join(skillDir, skill.name);
    const relPath = path.join('_skills', skill.name);
    if (existsSync(filePath)) {
      result.skipped.push(relPath);
      continue;
    }
    try {
      writeFileSync(filePath, skill.generator(), 'utf-8');
      result.created.push(relPath);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      result.errors.push({ file: relPath, message });
    }
  }

  return result;
}
