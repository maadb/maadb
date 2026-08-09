// ============================================================================
// Managed-instruction manifest — single registry for every generated
// instruction artifact, plus the stamp/classify/refresh machinery.
//
// Contract (accepted design, 2026-07-13):
// - Every managed file opens with a stamp:
//     <!-- maadb:managed name=<artifact> engine=<semver> hash=sha256:<hex> -->
//   The hash covers the content BELOW the stamp line, so classification is
//   a pure content comparison:
//     on-disk hash matches stamp + body matches current generator  -> current
//     on-disk hash matches stamp + generator differs               -> outdated
//     on-disk hash differs from stamp                              -> modified
//     no stamp (pre-lifecycle vintage)                             -> unmanaged
//     file absent                                                  -> missing
// - Refresh applies to `outdated` (and creates `missing`); `modified` and
//   `unmanaged` are never touched without an explicit force — legacy files
//   cannot prove they are pristine, so migrating them is a deliberate,
//   git-revertible operator step.
// - Boot paths NEVER call refresh. Scaffolding remains create-if-absent.
// ============================================================================

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { generateMaadMd } from '../maad-md.js';
import { generateSchemaGuide, generateImportGuide } from '../skill-files.js';
import { generateArchitectSkill } from '../architect.js';
import { generateGraphOntologySkill } from '../skills/graph-ontology.js';
import { generateCorpusExplorerSkill } from '../skills/corpus-explorer.js';

const require = createRequire(import.meta.url);

/** Engine version = template version. Resolved from the shipped package.json. */
export function engineVersion(): string {
  try {
    const pkg = require('../../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface ManagedArtifact {
  /** Stable artifact name carried in the stamp. */
  name: string;
  /** Path relative to the project root, POSIX separators. */
  relPath: string;
  generate: () => string;
}

/**
 * The complete managed set. CLAUDE.md / AGENTS.md are deliberately NOT here —
 * they are created-once thin pointers that users own after creation.
 * SCHEMA.md is a data-derived artifact, not an instruction template.
 */
export const MANAGED_ARTIFACTS: readonly ManagedArtifact[] = [
  { name: 'maad-md', relPath: 'MAAD.md', generate: generateMaadMd },
  { name: 'architect-core', relPath: '_skills/architect-core.md', generate: generateArchitectSkill },
  { name: 'schema-guide', relPath: '_skills/schema-guide.md', generate: generateSchemaGuide },
  { name: 'import-guide', relPath: '_skills/import-guide.md', generate: generateImportGuide },
  { name: 'graph-ontology', relPath: '_skills/graph-ontology.md', generate: generateGraphOntologySkill },
  { name: 'corpus-explorer', relPath: '_skills/corpus-explorer.md', generate: generateCorpusExplorerSkill },
];

const STAMP_RE = /^<!-- maadb:managed name=([A-Za-z0-9_-]+) engine=([^\s]+) hash=sha256:([0-9a-f]{64}) -->\r?\n?/;

export function hashBody(body: string): string {
  // Normalize line endings before hashing so a CRLF checkout or editor
  // round-trip doesn't misclassify an untouched file as modified.
  return createHash('sha256').update(body.replace(/\r\n/g, '\n'), 'utf-8').digest('hex');
}

/** Prepend the managed stamp to a generated body. */
export function stampContent(name: string, body: string, version: string = engineVersion()): string {
  return `<!-- maadb:managed name=${name} engine=${version} hash=sha256:${hashBody(body)} -->\n${body}`;
}

export interface ParsedStamp {
  name: string;
  engine: string;
  hash: string;
  /** File content below the stamp line. */
  body: string;
}

export function parseStamp(content: string): ParsedStamp | null {
  const m = STAMP_RE.exec(content);
  if (!m) return null;
  return { name: m[1]!, engine: m[2]!, hash: m[3]!, body: content.slice(m[0].length) };
}

export type InstructionState = 'current' | 'outdated' | 'modified' | 'unmanaged' | 'missing';

export interface InstructionStatus {
  name: string;
  relPath: string;
  state: InstructionState;
  /** Engine version recorded in the on-disk stamp, when present. */
  stampedEngine: string | null;
}

export function classifyContent(onDisk: string | null, artifact: ManagedArtifact): InstructionStatus {
  const base = { name: artifact.name, relPath: artifact.relPath };
  if (onDisk === null) return { ...base, state: 'missing', stampedEngine: null };
  const stamp = parseStamp(onDisk);
  if (!stamp) return { ...base, state: 'unmanaged', stampedEngine: null };
  if (hashBody(stamp.body) !== stamp.hash) {
    return { ...base, state: 'modified', stampedEngine: stamp.engine };
  }
  const current = hashBody(stamp.body) === hashBody(artifact.generate());
  return { ...base, state: current ? 'current' : 'outdated', stampedEngine: stamp.engine };
}

function readIfExists(absPath: string): string | null {
  if (!existsSync(absPath)) return null;
  try {
    return readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

/** Read-only status of every managed artifact in a project. */
export function checkProject(projectRoot: string): InstructionStatus[] {
  return MANAGED_ARTIFACTS.map(a =>
    classifyContent(readIfExists(path.join(projectRoot, a.relPath)), a));
}

export interface RefreshPlan {
  /** Written (or would be written, in dry-run): outdated + missing (+ forced). */
  refresh: InstructionStatus[];
  /** Skipped because user-edited and force was not given. */
  skippedModified: InstructionStatus[];
  /** Skipped because pre-lifecycle vintage and force was not given. */
  skippedUnmanaged: InstructionStatus[];
  /** Already current — untouched. */
  current: InstructionStatus[];
}

export function planRefresh(projectRoot: string, opts: { force: boolean }): RefreshPlan {
  const plan: RefreshPlan = { refresh: [], skippedModified: [], skippedUnmanaged: [], current: [] };
  for (const status of checkProject(projectRoot)) {
    switch (status.state) {
      case 'current': plan.current.push(status); break;
      case 'outdated':
      case 'missing': plan.refresh.push(status); break;
      case 'modified':
        (opts.force ? plan.refresh : plan.skippedModified).push(status); break;
      case 'unmanaged':
        (opts.force ? plan.refresh : plan.skippedUnmanaged).push(status); break;
    }
  }
  return plan;
}

/** Apply a refresh plan — writes stamped current content for each entry. */
export function applyRefresh(projectRoot: string, plan: RefreshPlan): string[] {
  const written: string[] = [];
  for (const status of plan.refresh) {
    const artifact = MANAGED_ARTIFACTS.find(a => a.name === status.name);
    if (!artifact) continue;
    const absPath = path.join(projectRoot, artifact.relPath);
    mkdirSync(path.dirname(absPath), { recursive: true });
    writeFileSync(absPath, stampContent(artifact.name, artifact.generate()), 'utf-8');
    written.push(artifact.relPath);
  }
  return written;
}
