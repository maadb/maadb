// ============================================================================
// Engine-owned project registration (0.23.0).
//
// Adds one project to a file-backed instance.yaml: creates the project folder
// inside the instance folder, scaffolds the files the engine needs to open it,
// initializes Git when the history mode commits, then appends the entry and
// publishes the file atomically. Hosts call this through maad_register_project
// instead of writing instance.yaml, running `git init` or committing.
//
// Write boundary (live-repo-as-MCP-host checklist):
//   - Every path derives from the instance config's folder, which the operator
//     chose with --instance. Nothing resolves against process.cwd() or the
//     engine install folder, and a project path inside the engine install
//     folder is refused.
//   - No env var chooses a path. No new well-known folder is introduced; the
//     scaffold creates `_schema/` and `_registry/`, already in .gitignore.
//   - The only temp file is instance.yaml's own atomic-write sibling.
// ============================================================================

import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { ok, singleErr, type Result } from '../errors.js';
import type { Role } from '../mcp/roles.js';
import type { HistoryMode, HistoryOptions } from '../history/types.js';
import { atomicWrite } from '../engine/journal.js';
import { GitLayer } from '../git/index.js';
import { writeFileIfAbsent } from '../write-if-absent.js';
import { parseInstanceText, validateInstance, type InstanceConfig } from './config.js';

const VALID_PROJECT_NAME = /^[a-z][a-z0-9_-]*$/;
const GIT_REQUIRED_MODES = new Set<HistoryMode>(['audit', 'batch', 'snapshot']);

/** Package root: two levels above this module in both src/ and dist/. */
const ENGINE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface RegisterProjectSpec {
  name: string;
  /** Folder relative to the instance config's folder. Defaults to `name`. */
  path?: string;
  role: Role;
  historyMode: HistoryMode;
  historyOptions?: HistoryOptions;
  description?: string;
}

export interface RegisterProjectOutcome {
  name: string;
  /** Absolute project folder. */
  path: string;
  role: Role;
  historyMode: HistoryMode;
  /** False when instance.yaml already declared this project the same way. */
  registered: boolean;
  directoryCreated: boolean;
  gitInitialized: boolean;
}

export interface RegisterProjectOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam. Defaults to this package's root. */
  engineRoot?: string;
}

// One registration at a time per instance file: read, append and publish
// must not interleave with another registration in this process.
const locks = new Map<string, Promise<unknown>>();

async function withConfigLock<T>(configPath: string, fn: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? configPath.toLowerCase() : configPath;
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  locks.set(key, tail);
  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) locks.delete(key);
  }
}

function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** True when `child` is `parent` or inside it. */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function nearestExisting(p: string): string {
  let current = p;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function invalidPath(message: string, details: Record<string, unknown>): Result<never> {
  return singleErr('PROJECT_PATH_INVALID', message, undefined, details);
}

export function registerProject(
  configPath: string,
  spec: RegisterProjectSpec,
  options: RegisterProjectOptions = {},
): Promise<Result<RegisterProjectOutcome>> {
  const resolvedConfig = path.resolve(configPath);
  return withConfigLock(resolvedConfig, () => registerLocked(resolvedConfig, spec, options));
}

async function registerLocked(
  configPath: string,
  spec: RegisterProjectSpec,
  options: RegisterProjectOptions,
): Promise<Result<RegisterProjectOutcome>> {
  const env = options.env ?? process.env;
  const engineRoot = path.resolve(options.engineRoot ?? ENGINE_ROOT);

  if (!VALID_PROJECT_NAME.test(spec.name)) {
    return singleErr('PROJECT_REGISTER_FAILED',
      `name must match /^[a-z][a-z0-9_-]*$/ (got ${JSON.stringify(spec.name)})`);
  }

  // --- Current instance file -------------------------------------------------
  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (e) {
    return singleErr('PROJECT_REGISTER_FAILED',
      `Cannot read instance config ${configPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const parsed = parseInstanceText(raw);
  if (!parsed.ok) return parsed;
  const current = validateInstance(parsed.value, configPath, env);
  if (!current.ok) {
    return singleErr('PROJECT_REGISTER_FAILED',
      `Instance config is invalid; fix it before registering a project: ${current.errors.map(e => e.message).join('; ')}`);
  }

  // --- Project path ------------------------------------------------------------
  const configDir = path.dirname(configPath);
  const requested = spec.path ?? spec.name;
  if (requested.length === 0 || path.isAbsolute(requested) || path.win32.isAbsolute(requested)) {
    return invalidPath('path must be relative to the instance config folder', { path: requested });
  }
  const absPath = path.resolve(configDir, requested);

  // --- Already declared? -------------------------------------------------------
  // Checked before the containment rules so an operator-written entry that
  // lives elsewhere can still be confirmed (pass no path to accept it).
  const existing = current.value.projects.find(p => p.name === spec.name);
  if (existing) {
    const conflicts: string[] = [];
    if (spec.path !== undefined && !samePath(existing.path, absPath)) conflicts.push('path');
    if (existing.role !== spec.role) conflicts.push('role');
    if (existing.configuredHistoryMode !== spec.historyMode) conflicts.push('historyMode');
    if (conflicts.length > 0) {
      return singleErr('PROJECT_ALREADY_REGISTERED',
        `Project "${spec.name}" is already registered with a different ${conflicts.join(', ')}. Changing a registered project needs an instance.yaml edit and an engine restart.`,
        undefined,
        {
          conflicts,
          registered: {
            path: existing.path,
            role: existing.role,
            historyMode: existing.configuredHistoryMode ?? null,
          },
        });
    }
    return ok({
      name: spec.name,
      path: existing.path,
      role: existing.role,
      historyMode: spec.historyMode,
      registered: false,
      directoryCreated: false,
      gitInitialized: false,
    });
  }

  if (samePath(absPath, configDir) || !isWithin(configDir, absPath)) {
    return invalidPath('path must name a folder inside the instance config folder', { path: requested });
  }
  if (isWithin(engineRoot, absPath) || isWithin(absPath, engineRoot)) {
    return invalidPath('path must not overlap the MAADB engine install folder', { path: requested });
  }

  for (const other of current.value.projects) {
    if (isWithin(other.path, absPath) || isWithin(absPath, other.path)) {
      return invalidPath(`path overlaps project "${other.name}"`, { path: requested, project: other.name });
    }
  }

  // A symlinked ancestor must not lead outside the instance folder.
  const realConfigDir = realpathSync(configDir);
  const anchor = nearestExisting(absPath);
  const realAnchor = realpathSync(anchor);
  if (!isWithin(realConfigDir, realAnchor)) {
    return invalidPath('path resolves outside the instance config folder', { path: requested });
  }
  if (existsSync(absPath) && !statSync(absPath).isDirectory()) {
    return invalidPath('path exists and is not a folder', { path: requested });
  }

  // --- Folder, scaffold, Git ---------------------------------------------------
  let directoryCreated = false;
  let gitInitialized = false;
  try {
    directoryCreated = !existsSync(absPath);
    mkdirSync(path.join(absPath, '_schema'), { recursive: true });
    mkdirSync(path.join(absPath, '_registry'), { recursive: true });
    // An existing folder may hold links; every folder written into must
    // still resolve inside the instance folder.
    for (const dir of [absPath, path.join(absPath, '_schema'), path.join(absPath, '_registry')]) {
      if (!isWithin(realConfigDir, realpathSync(dir))) {
        return invalidPath('a project folder resolves outside the instance config folder', { path: requested, folder: path.relative(configDir, dir) });
      }
    }
    writeFileIfAbsent(path.join(absPath, '_registry', 'object_types.yaml'), 'types: {}\n');
    writeFileIfAbsent(path.join(absPath, '.gitignore'), '_backend/\n_import/\n');
    if (GIT_REQUIRED_MODES.has(spec.historyMode) && !existsSync(path.join(absPath, '.git'))) {
      // Commits only .gitignore. Files a host adds later are committed by the
      // engine's own writes, never by a blanket `git add -A`.
      await new GitLayer(absPath).initRepo();
      gitInitialized = true;
    }
  } catch (e) {
    return singleErr('PROJECT_REGISTER_FAILED',
      `Cannot prepare project folder ${absPath}: ${e instanceof Error ? e.message : String(e)}`,
      undefined, { directoryCreated, gitInitialized });
  }

  // --- New instance file -------------------------------------------------------
  const entry: Record<string, unknown> = {
    name: spec.name,
    path: path.relative(configDir, absPath).split(path.sep).join('/'),
    role: spec.role,
  };
  if (spec.description !== undefined) entry.description = spec.description;
  entry.history_mode = spec.historyMode;
  if (spec.historyOptions !== undefined && Object.keys(spec.historyOptions).length > 0) {
    entry.history_options = { ...spec.historyOptions };
  }

  const text = appendEntry(raw, parsed.value, entry);
  const reparsed = parseInstanceText(text);
  if (!reparsed.ok) return reparsed;
  const next = validateInstance(reparsed.value, configPath, env);
  if (!next.ok) {
    return singleErr('PROJECT_REGISTER_FAILED',
      `The new entry does not validate: ${next.errors.map(e => e.message).join('; ')}`,
      undefined, { directoryCreated, gitInitialized });
  }
  if (!sameProjectsPlusOne(current.value, next.value, spec.name)) {
    return singleErr('PROJECT_REGISTER_FAILED',
      'Appending the entry would change other projects; instance.yaml left unchanged.',
      undefined, { directoryCreated, gitInitialized });
  }

  try {
    await atomicWrite(configPath, text);
  } catch (e) {
    return singleErr('PROJECT_REGISTER_FAILED',
      `Cannot write instance config ${configPath}: ${e instanceof Error ? e.message : String(e)}`,
      undefined, { directoryCreated, gitInitialized });
  }

  const added = next.value.projects.find(p => p.name === spec.name)!;
  return ok({
    name: spec.name,
    path: added.path,
    role: added.role,
    historyMode: spec.historyMode,
    registered: true,
    directoryCreated,
    gitInitialized,
  });
}

/**
 * Append the entry as text so the operator's comments and layout survive.
 * Falls back to a full YAML dump when the file is fenced or the append does
 * not parse back to the same data plus one entry.
 */
function appendEntry(raw: string, data: Record<string, unknown>, entry: Record<string, unknown>): string {
  const projects = Array.isArray(data.projects) ? data.projects : [];
  const expected = { ...data, projects: [...projects, entry] };

  if (!raw.trimStart().startsWith('---')) {
    const indent = /^([ \t]*)-[ \t]+name[ \t]*:/m.exec(raw)?.[1] ?? '  ';
    const item = yaml.dump([entry], { lineWidth: -1, noRefs: true })
      .trimEnd()
      .split('\n')
      .map(line => indent + line)
      .join('\n');
    const candidate = `${raw.trimEnd()}\n${item}\n`;
    const back = parseInstanceText(candidate);
    if (back.ok && JSON.stringify(back.value) === JSON.stringify(expected)) return candidate;
  }
  return yaml.dump(expected, { lineWidth: -1, noRefs: true });
}

function sameProjectsPlusOne(before: InstanceConfig, after: InstanceConfig, name: string): boolean {
  if (after.name !== before.name) return false;
  if (after.projects.length !== before.projects.length + 1) return false;
  const key = (p: InstanceConfig['projects'][number]) =>
    JSON.stringify([p.name, p.path, p.role, p.description ?? null, p.configuredHistoryMode ?? null, p.historyOptions ?? null]);
  const beforeKeys = before.projects.map(key);
  const afterOthers = after.projects.filter(p => p.name !== name).map(key);
  return JSON.stringify(beforeKeys) === JSON.stringify(afterOthers);
}
