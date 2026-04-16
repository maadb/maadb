// ============================================================================
// Registry Loader
// Reads and validates _registry/object_types.yaml
// ============================================================================

import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseMatter } from '../parser/matter.js';
import { ok, err, singleErr, maadError, type Result } from '../errors.js';
import { isContainedIn } from '../engine/pathguard.js';
import {
  docType,
  schemaRef,
  PRIMITIVES,
  DEFAULT_SUBTYPE_MAP,
  buildSubtypeMap,
  type Registry,
  type RegistryType,
  type ExtractionConfig,
  type Primitive,
} from '../types.js';

const VALID_NAME_REGEX = /^[a-z][a-z0-9_]*$/;
const VALID_PREFIX_REGEX = /^[a-z0-9]{2,5}$/;

export async function loadRegistry(projectRoot: string): Promise<Result<Registry>> {
  const registryPath = path.join(projectRoot, '_registry', 'object_types.yaml');

  if (!existsSync(registryPath)) {
    return singleErr('REGISTRY_NOT_FOUND', `Registry file not found: ${registryPath}`);
  }

  let raw: string;
  try {
    raw = await readFile(registryPath, 'utf-8');
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown read error';
    return singleErr('FILE_READ_ERROR', `Failed to read registry: ${message}`);
  }

  let data: Record<string, unknown>;
  try {
    // gray-matter can parse bare YAML files (no frontmatter delimiters needed)
    // but we need to handle both cases
    if (raw.trimStart().startsWith('---')) {
      const parsed = parseMatter(raw);
      data = parsed.data as Record<string, unknown>;
    } else {
      // Parse as bare YAML — wrap in frontmatter delimiters for gray-matter
      const parsed = parseMatter(`---\n${raw}\n---`);
      data = parsed.data as Record<string, unknown>;
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown parse error';
    return singleErr('PARSE_ERROR', `Failed to parse registry YAML: ${message}`);
  }

  const errors = [];
  const types = new Map<string, RegistryType>();
  const seenPrefixes = new Map<string, string>();

  // Parse types
  const typesRaw = data['types'];
  if (typesRaw === undefined || typesRaw === null || typeof typesRaw !== 'object') {
    return singleErr('REGISTRY_INVALID', 'Registry must contain a "types" mapping');
  }

  for (const [name, def] of Object.entries(typesRaw as Record<string, unknown>)) {
    if (typeof def !== 'object' || def === null) {
      errors.push(maadError('REGISTRY_INVALID', `Type "${name}" must be a mapping`));
      continue;
    }

    const typeDef = def as Record<string, unknown>;

    // Validate name
    if (!VALID_NAME_REGEX.test(name)) {
      errors.push(maadError('REGISTRY_INVALID', `Type name "${name}" must be lowercase alphanumeric with underscores, starting with a letter`));
    }

    // Validate path
    const typePath = typeDef['path'];
    if (typeof typePath !== 'string' || typePath.length === 0) {
      errors.push(maadError('REGISTRY_INVALID', `Type "${name}" must have a "path" string`));
      continue;
    }

    const resolvedPath = path.join(projectRoot, typePath);
    if (!isContainedIn(resolvedPath, projectRoot)) {
      errors.push(maadError('REGISTRY_INVALID', `Type "${name}" path escapes project root: ${typePath}`));
      continue;
    }
    if (!existsSync(resolvedPath)) {
      mkdirSync(resolvedPath, { recursive: true });
    }

    // Validate id_prefix
    const idPrefix = typeDef['id_prefix'];
    if (typeof idPrefix !== 'string' || !VALID_PREFIX_REGEX.test(idPrefix)) {
      errors.push(maadError('REGISTRY_INVALID', `Type "${name}" id_prefix must be 2-5 lowercase alphanumeric characters, got: ${String(idPrefix)}`));
      continue;
    }

    // Check for duplicate prefixes
    const existingType = seenPrefixes.get(idPrefix);
    if (existingType !== undefined) {
      errors.push(maadError('DUPLICATE_PREFIX', `Type "${name}" has duplicate id_prefix "${idPrefix}" (also used by "${existingType}")`));
    }
    seenPrefixes.set(idPrefix, name);

    // Validate schema ref
    const schemaValue = typeDef['schema'];
    if (typeof schemaValue !== 'string' || schemaValue.length === 0) {
      errors.push(maadError('REGISTRY_INVALID', `Type "${name}" must have a "schema" string`));
      continue;
    }

    const schemaFilePath = path.join(projectRoot, '_schema', `${schemaValue}.yaml`);
    if (!existsSync(schemaFilePath)) {
      errors.push(maadError('SCHEMA_NOT_FOUND', `Type "${name}" references schema "${schemaValue}" but file not found: ${schemaFilePath}`));
    }

    // Optional template
    const template = typeof typeDef['template'] === 'string' ? typeDef['template'] : null;
    if (template !== null) {
      const templatePath = path.join(projectRoot, template);
      if (!isContainedIn(templatePath, projectRoot)) {
        errors.push(maadError('REGISTRY_INVALID', `Type "${name}" template escapes project root: ${template}`));
      } else if (!existsSync(templatePath)) {
        errors.push(maadError('FILE_NOT_FOUND', `Type "${name}" references template "${template}" but file not found`));
      }
    }

    types.set(name, {
      name: docType(name),
      path: typePath,
      idPrefix: idPrefix,
      schemaRef: schemaRef(schemaValue),
      template,
    });
  }

  // Parse extraction config
  let extraction: ExtractionConfig = { subtypes: {} };
  const extractionRaw = data['extraction'];
  if (extractionRaw !== undefined && typeof extractionRaw === 'object' && extractionRaw !== null) {
    const extDef = extractionRaw as Record<string, unknown>;
    const subtypesRaw = extDef['subtypes'];
    if (subtypesRaw !== undefined && typeof subtypesRaw === 'object' && subtypesRaw !== null) {
      const subtypes: Record<string, Primitive> = {};
      for (const [subtype, primitive] of Object.entries(subtypesRaw as Record<string, unknown>)) {
        if (typeof primitive === 'string' && (PRIMITIVES as readonly string[]).includes(primitive)) {
          subtypes[subtype] = primitive as Primitive;
        } else {
          errors.push(maadError('REGISTRY_INVALID', `Extraction subtype "${subtype}" maps to invalid primitive "${String(primitive)}". Valid: ${PRIMITIVES.join(', ')}`));
        }
      }
      extraction = { subtypes };
    }
  }

  if (errors.length > 0) {
    return err(errors);
  }

  const subtypeMap = buildSubtypeMap(DEFAULT_SUBTYPE_MAP, extraction.subtypes);

  return ok({
    types: types as Map<import('../types.js').DocType, RegistryType>,
    extraction,
    subtypeMap,
  });
}
