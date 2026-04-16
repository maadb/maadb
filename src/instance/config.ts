// ============================================================================
// Instance Config — loads and validates instance.yaml
//
// An Instance declares a set of projects that one MCP server serves.
// Real instance.yaml is loaded from disk. A "synthetic" instance wraps a
// single --project path so the legacy CLI path flows through the same code.
// ============================================================================

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseMatter } from '../parser/matter.js';
import { ok, err, singleErr, maadError, type Result } from '../errors.js';
import { parseRole, type Role } from '../mcp/roles.js';

export interface ProjectConfig {
  name: string;
  path: string;
  role: Role;
  description?: string;
}

export interface InstanceConfig {
  name: string;
  projects: ProjectConfig[];
  source: 'file' | 'synthetic';
  configPath?: string;
}

const VALID_PROJECT_NAME = /^[a-z][a-z0-9_-]*$/;

export async function loadInstance(configPath: string): Promise<Result<InstanceConfig>> {
  const resolved = path.resolve(configPath);

  if (!existsSync(resolved)) {
    return singleErr('INSTANCE_CONFIG_NOT_FOUND', `Instance config not found: ${resolved}`);
  }

  let raw: string;
  try {
    raw = await readFile(resolved, 'utf-8');
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown read error';
    return singleErr('FILE_READ_ERROR', `Failed to read instance config: ${message}`);
  }

  let data: Record<string, unknown>;
  try {
    if (raw.trimStart().startsWith('---')) {
      data = parseMatter(raw).data as Record<string, unknown>;
    } else {
      data = parseMatter(`---\n${raw}\n---`).data as Record<string, unknown>;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown parse error';
    return singleErr('PARSE_ERROR', `Failed to parse instance YAML: ${message}`);
  }

  return validateInstance(data, resolved);
}

export function validateInstance(data: Record<string, unknown>, configPath?: string): Result<InstanceConfig> {
  const errors = [];
  const configDir = configPath ? path.dirname(configPath) : process.cwd();

  if (typeof data.name !== 'string' || data.name.length === 0) {
    errors.push(maadError('INSTANCE_CONFIG_INVALID', 'instance.name is required and must be a non-empty string'));
  }
  const name = typeof data.name === 'string' ? data.name : '';

  if (!Array.isArray(data.projects) || data.projects.length === 0) {
    errors.push(maadError('INSTANCE_CONFIG_INVALID', 'instance.projects must be a non-empty array'));
    return err(errors);
  }

  const projects: ProjectConfig[] = [];
  const seenNames = new Set<string>();

  for (let i = 0; i < data.projects.length; i++) {
    const raw = data.projects[i] as Record<string, unknown>;
    const where = `projects[${i}]`;

    if (typeof raw !== 'object' || raw === null) {
      errors.push(maadError('INSTANCE_CONFIG_INVALID', `${where} must be an object`));
      continue;
    }

    const pname = raw.name;
    if (typeof pname !== 'string' || !VALID_PROJECT_NAME.test(pname)) {
      errors.push(maadError('INSTANCE_CONFIG_INVALID', `${where}.name must match /^[a-z][a-z0-9_-]*$/ (got ${JSON.stringify(pname)})`));
      continue;
    }
    if (seenNames.has(pname)) {
      errors.push(maadError('INSTANCE_CONFIG_INVALID', `${where}.name "${pname}" is duplicated`));
      continue;
    }
    seenNames.add(pname);

    const ppath = raw.path;
    if (typeof ppath !== 'string' || ppath.length === 0) {
      errors.push(maadError('INSTANCE_CONFIG_INVALID', `${where}.path is required`));
      continue;
    }
    const absPath = path.isAbsolute(ppath) ? ppath : path.resolve(configDir, ppath);

    const role = parseRole(typeof raw.role === 'string' ? raw.role : undefined);
    const project: ProjectConfig = { name: pname, path: absPath, role };
    if (typeof raw.description === 'string') project.description = raw.description;
    projects.push(project);
  }

  if (errors.length > 0) return err(errors);

  const result: InstanceConfig = { name, projects, source: 'file' };
  if (configPath) result.configPath = configPath;
  return ok(result);
}

// Synthetic single-project instance for legacy --project path.
// Wraps a raw project path + role into the same InstanceConfig shape so
// downstream code (pool, session) does not need two paths.
export function synthesizeLegacyInstance(projectPath: string, role: Role): InstanceConfig {
  const absPath = path.resolve(projectPath);
  const basename = path.basename(absPath).toLowerCase().replace(/[^a-z0-9_-]/g, '-') || 'default';
  return {
    name: `${basename}-legacy`,
    projects: [{ name: 'default', path: absPath, role }],
    source: 'synthetic',
  };
}

export function getProject(instance: InstanceConfig, name: string): ProjectConfig | undefined {
  return instance.projects.find((p) => p.name === name);
}
