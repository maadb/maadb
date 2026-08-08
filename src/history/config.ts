// ============================================================================
// History configuration - validation, precedence, and compatibility inference
// ============================================================================

import { existsSync } from 'node:fs';
import path from 'node:path';
import { err, maadError, ok, singleErr, type MaadError, type Result } from '../errors.js';
import {
  HISTORY_MODES,
  type HistoryAdvisory,
  type HistoryMode,
  type HistoryOptions,
  type ResolvedHistoryConfig,
} from './types.js';

export const HISTORY_MODE_DEFAULT_ENV = 'MAAD_HISTORY_MODE_DEFAULT';

const HISTORY_OPTION_KEYS = new Set(['max_writes', 'max_delay_ms']);
const GIT_REQUIRED_MODES = new Set<HistoryMode>(['audit', 'batch', 'snapshot']);

export interface RawHistoryConfig {
  history_mode?: unknown;
  history_options?: unknown;
}

export function isHistoryMode(value: unknown): value is HistoryMode {
  return typeof value === 'string' && (HISTORY_MODES as readonly string[]).includes(value);
}

function invalid(message: string): MaadError {
  return maadError('INSTANCE_CONFIG_INVALID', message);
}

function validateHistoryOptions(value: unknown, where: string): Result<HistoryOptions> {
  if (value === undefined) return ok({});
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return singleErr('INSTANCE_CONFIG_INVALID', `${where} must be an object`);
  }

  const raw = value as Record<string, unknown>;
  const errors: MaadError[] = [];
  for (const key of Object.keys(raw)) {
    if (!HISTORY_OPTION_KEYS.has(key)) {
      errors.push(invalid(`${where}.${key} is not supported`));
    }
  }

  const options: HistoryOptions = {};
  for (const key of HISTORY_OPTION_KEYS) {
    const candidate = raw[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== 'number' || !Number.isSafeInteger(candidate) || candidate <= 0) {
      errors.push(invalid(`${where}.${key} must be a positive integer`));
      continue;
    }
    if (key === 'max_writes') options.max_writes = candidate;
    else options.max_delay_ms = candidate;
  }

  return errors.length > 0 ? err(errors) : ok(options);
}

function parseMode(value: unknown, where: string): Result<HistoryMode> {
  if (isHistoryMode(value)) return ok(value);
  return singleErr(
    'INSTANCE_CONFIG_INVALID',
    `${where} must be one of ${HISTORY_MODES.join(', ')} (got ${JSON.stringify(value)})`,
  );
}

function inferMode(projectRoot: string): HistoryMode {
  return existsSync(path.join(projectRoot, '.git')) ? 'audit' : 'feed';
}

function inferredAdvisory(mode: HistoryMode): HistoryAdvisory {
  return {
    code: 'HISTORY_MODE_INFERRED',
    message: `history_mode is not configured; inferred ${mode}. Set history_mode explicitly to silence this advisory.`,
  };
}

/**
 * Resolve one project's history configuration.
 *
 * Precedence: project `history_mode`, then MAAD_HISTORY_MODE_DEFAULT, then
 * compatibility inference (`audit` with a project-root .git entry, otherwise
 * `feed`). Inference emits exactly one migration advisory.
 */
export function resolveHistoryConfig(
  raw: RawHistoryConfig,
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  where = 'project',
): Result<ResolvedHistoryConfig> {
  const optionsResult = validateHistoryOptions(raw.history_options, `${where}.history_options`);
  if (!optionsResult.ok) return optionsResult;

  let effectiveMode: HistoryMode;
  let configuredMode: HistoryMode | null = null;
  let modeSource: ResolvedHistoryConfig['modeSource'];
  let advisories: HistoryAdvisory[] = [];

  if (raw.history_mode !== undefined) {
    const modeResult = parseMode(raw.history_mode, `${where}.history_mode`);
    if (!modeResult.ok) return modeResult;
    configuredMode = modeResult.value;
    effectiveMode = modeResult.value;
    modeSource = 'project';
  } else if (env[HISTORY_MODE_DEFAULT_ENV] !== undefined) {
    const modeResult = parseMode(env[HISTORY_MODE_DEFAULT_ENV], HISTORY_MODE_DEFAULT_ENV);
    if (!modeResult.ok) return modeResult;
    effectiveMode = modeResult.value;
    modeSource = 'environment';
  } else {
    effectiveMode = inferMode(projectRoot);
    modeSource = 'inferred';
    advisories = [inferredAdvisory(effectiveMode)];
  }

  if (GIT_REQUIRED_MODES.has(effectiveMode) && !existsSync(path.join(projectRoot, '.git'))) {
    return singleErr(
      'GIT_NOT_INITIALIZED',
      `history_mode ${effectiveMode} requires a Git repository at the project root`,
      undefined,
      { historyMode: effectiveMode, modeSource },
    );
  }

  return ok({
    effectiveMode,
    configuredMode,
    modeSource,
    options: optionsResult.value,
    advisories,
  });
}

export function historyOptionsEqual(a: HistoryOptions, b: HistoryOptions): boolean {
  return a.max_writes === b.max_writes && a.max_delay_ms === b.max_delay_ms;
}
