// ============================================================================
// MCP Lifecycle — startup validation, engine init, shutdown hooks
// Extracted from server.ts to keep server focused on transport.
// ============================================================================

import { existsSync } from 'node:fs';
import path from 'node:path';
import { MaadEngine } from '../engine.js';
import { logger } from '../engine/logger.js';
import { ensureProjectSkills, emitInstructionsAdvisory } from '../skills-scaffold.js';

export interface StartupResult {
  engine: MaadEngine;
  warnings: string[];
}

export async function startupEngine(projectRoot: string): Promise<StartupResult> {
  const resolved = path.resolve(projectRoot);
  const warnings: string[] = [];

  // Validate project exists
  if (!existsSync(resolved)) {
    throw new Error(`Project directory not found: ${resolved}`);
  }

  // Init engine — self-heals _registry, _schema, _backend on empty projects.
  // 0.8.4 — serving path: guard against a false-empty index (lost/unbuilt
  // derived index over existing markdown) rather than silently serving [].
  const engine = new MaadEngine();
  const initResult = await engine.init(resolved, { guardEmptyIndex: true });
  if (!initResult.ok) {
    const messages = initResult.errors.map(e => `${e.code}: ${e.message}`).join('; ');
    throw new Error(`Engine initialization failed: ${messages}`);
  }

  // Ensure _skills/ guide files exist for the agent. Non-blocking: a failed
  // write (permissions, read-only FS) logs a warning but does not crash the
  // server — engine is already up and usable without the skills.
  if (!engine.isReadOnly()) {
    const skillsResult = ensureProjectSkills(resolved);
    if (skillsResult.created.length > 0) {
      logger.info('lifecycle', 'startup', `Scaffolded skills: ${skillsResult.created.join(', ')}`);
    }
    for (const e of skillsResult.errors) {
      logger.bestEffort('lifecycle', 'startup', `Failed to write ${e.file}: ${e.message}`);
      warnings.push(`skills scaffold: ${e.file} — ${e.message}`);
    }
  }

  // Advisory only — boot never mutates existing instruction files. Refresh
  // is operator-pulled via `maad instructions refresh`.
  emitInstructionsAdvisory(resolved);

  // Check for recovery actions
  const recovery = engine.getStartupRecovery();
  if (recovery.length > 0) {
    for (const action of recovery) {
      logger.info('lifecycle', 'startup', action);
      warnings.push(action);
    }
  }

  // Log health
  const health = engine.health();
  logger.info('lifecycle', 'startup', `Engine ready: ${health.totalDocuments} docs, ${health.registeredTypes} types, git: ${health.gitAvailable}`);

  return { engine, warnings };
}

export function registerShutdownHooks(engine: MaadEngine | null, cleanup?: () => Promise<void>): void {
  // Legacy shim retained for any caller that still uses the single-engine
  // flow. The modern path is installSignalHandlers(target, opts) from
  // src/mcp/shutdown.ts with pool + rate limiter. Server.ts uses that path.
  const shutdown = async () => {
    logger.info('lifecycle', 'shutdown', 'Shutting down...');
    if (engine) await engine.close();
    if (cleanup) await cleanup();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
