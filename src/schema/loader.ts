// ============================================================================
// Schema Loader
// Reads and validates _schema/*.yaml files referenced by the registry.
// ============================================================================

import { readFile, stat } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { parseMatter } from '../parser/matter.js';
import { ok, err, maadError, type Result, type MaadError } from '../errors.js';
import { isPrecision, comparePrecision, type Precision } from './precision.js';
import { isSafeSchemaRef, isWritePathContainedIn } from '../engine/pathguard.js';
import {
  docType,
  schemaRef as toSchemaRef,
  type Registry,
  type SchemaDefinition,
  type SchemaRef,
  type FieldDefinition,
  type FieldType,
  type TemplateHeading,
  type DocType,
  type SchemaStore,
} from '../types.js';

const VALID_FIELD_TYPES: FieldType[] = ['string', 'number', 'date', 'enum', 'ref', 'boolean', 'list', 'amount'];

export async function loadSchemas(projectRoot: string, registry: Registry): Promise<Result<SchemaStore>> {
  const errors: MaadError[] = [];
  const schemas = new Map<SchemaRef, SchemaDefinition>();
  const typeToSchema = new Map<string, SchemaRef>();
  // 0.7.7 — capture mtime+size per file for staleness checks.
  // Includes the registry file too, so registry edits (new/removed types,
  // path/schemaRef remap) trigger reload alongside per-schema edits.
  const cachedFiles = new Map<string, { mtimeMs: number; size: number }>();
  const registryPath = path.join(projectRoot, '_registry', 'object_types.yaml');
  try {
    const st = await stat(registryPath);
    cachedFiles.set(registryPath, { mtimeMs: st.mtimeMs, size: st.size });
  } catch {
    // Empty / missing registry — leave out of cache; isStale will pick up
    // the file when it appears via stat throwing on a cached entry that
    // doesn't exist. For an absent registry the schemas map is empty anyway.
  }

  for (const [, regType] of registry.types) {
    if (!isSafeSchemaRef(regType.schemaRef as string)) {
      errors.push(maadError('SCHEMA_INVALID', `Unsafe schema reference for type "${regType.name as string}": ${regType.schemaRef as string}`));
      continue;
    }

    const schemaFile = path.join(projectRoot, '_schema', `${regType.schemaRef}.yaml`);
    let raw: string;

    try {
      if (!isWritePathContainedIn(schemaFile, projectRoot)) {
        errors.push(maadError('SCHEMA_INVALID', `Schema path escapes project root: ${regType.schemaRef as string}`));
        continue;
      }
      raw = await readFile(schemaFile, 'utf-8');
      const st = await stat(schemaFile);
      cachedFiles.set(schemaFile, { mtimeMs: st.mtimeMs, size: st.size });
    } catch (e) {
      errors.push(maadError('SCHEMA_NOT_FOUND', `Schema file not found for type "${regType.name}": ${schemaFile}`));
      continue;
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
      errors.push(maadError('PARSE_ERROR', `Failed to parse schema "${regType.schemaRef}": ${message}`));
      continue;
    }

    const result = parseSchemaDefinition(data, regType.schemaRef, registry);
    if (!result.ok) {
      errors.push(...result.errors);
      continue;
    }

    schemas.set(regType.schemaRef, result.value);
    typeToSchema.set(result.value.type as string, regType.schemaRef);
  }

  if (errors.length > 0) {
    return err(errors);
  }

  const store: SchemaStore = {
    schemas,
    cachedFiles,
    getSchema(ref: SchemaRef) {
      return schemas.get(ref);
    },
    getSchemaForType(type: DocType) {
      const ref = typeToSchema.get(type as string);
      if (ref === undefined) return undefined;
      return schemas.get(ref);
    },
    isStale() {
      // Sync stat — called on every write entry so latency matters; for the
      // typical project (5-20 schemas) this is microseconds. Any disagreement
      // with cached mtime/size is treated as stale; an absent file (cached
      // but stat throws ENOENT) is also stale.
      for (const [absPath, cached] of cachedFiles) {
        try {
          const st = statSync(absPath);
          if (st.mtimeMs !== cached.mtimeMs || st.size !== cached.size) return true;
        } catch {
          return true;
        }
      }
      return false;
    },
  };

  return ok(store);
}

function parseSchemaDefinition(
  data: Record<string, unknown>,
  ref: SchemaRef,
  registry: Registry,
): Result<SchemaDefinition> {
  const errors: MaadError[] = [];

  // Type
  const typeName = data['type'];
  if (typeof typeName !== 'string') {
    errors.push(maadError('SCHEMA_INVALID', `Schema "${ref}" must have a "type" string`));
    return err(errors);
  }

  // Version
  const version = data['version'];
  const versionNum = typeof version === 'number' ? version : parseVersionFromRef(ref);

  // Required fields
  const requiredRaw = data['required'];
  const required: string[] = [];
  if (Array.isArray(requiredRaw)) {
    for (const r of requiredRaw) {
      if (typeof r === 'string') required.push(r);
    }
  }

  // Fields
  const fieldsRaw = data['fields'];
  const fields = new Map<string, FieldDefinition>();

  if (fieldsRaw !== undefined && typeof fieldsRaw === 'object' && fieldsRaw !== null) {
    for (const [fieldName, fieldDef] of Object.entries(fieldsRaw as Record<string, unknown>)) {
      if (typeof fieldDef !== 'object' || fieldDef === null) {
        errors.push(maadError('SCHEMA_INVALID', `Schema "${ref}" field "${fieldName}" must be a mapping`));
        continue;
      }

      const fd = fieldDef as Record<string, unknown>;
      const fieldResult = parseFieldDefinition(fieldName, fd, ref, registry);
      if (!fieldResult.ok) {
        errors.push(...fieldResult.errors);
        continue;
      }
      fields.set(fieldName, fieldResult.value);
    }
  }

  // Validate required fields exist in fields map
  for (const req of required) {
    if (req === 'doc_id' || req === 'doc_type' || req === 'schema') continue;
    if (!fields.has(req)) {
      errors.push(maadError('SCHEMA_INVALID', `Schema "${ref}" lists "${req}" as required but it is not defined in fields`));
    }
  }

  // Template
  let template: TemplateHeading[] | null = null;
  const templateRaw = data['template'];
  if (templateRaw !== undefined && typeof templateRaw === 'object' && templateRaw !== null) {
    const tpl = templateRaw as Record<string, unknown>;
    const headingsRaw = tpl['headings'];
    if (Array.isArray(headingsRaw)) {
      template = [];
      for (const h of headingsRaw) {
        if (typeof h === 'object' && h !== null) {
          const hDef = h as Record<string, unknown>;
          template.push({
            level: typeof hDef['level'] === 'number' ? hDef['level'] : 1,
            text: typeof hDef['text'] === 'string' ? hDef['text'] : '',
            id: typeof hDef['id'] === 'string' ? hDef['id'] : null,
          });
        }
      }
    }
  }

  if (errors.length > 0) {
    return err(errors);
  }

  return ok({
    type: docType(typeName),
    version: versionNum,
    required,
    fields,
    template,
  });
}

// 0.12.0 capability gate — the complete field-definition key vocabulary.
// Unknown keys FAIL schema activation (SCHEMA_INVALID) instead of being
// silently ignored: a schema requesting a constraint this engine doesn't
// implement must refuse to load rather than run with unenforced policy.
// Every future constraint key added here is automatically version-gated —
// engines older than the key (but carrying this gate) reject it by name.
const KNOWN_FIELD_KEYS: ReadonlySet<string> = new Set([
  'type', 'index', 'role', 'format', 'target', 'values', 'item_type', 'default',
  'store_precision', 'on_coarser', 'display_precision',
  'max_length', 'soft_max_length', 'multiline',
]);

function parseFieldDefinition(
  name: string,
  fd: Record<string, unknown>,
  schemaRef: SchemaRef,
  registry: Registry,
): Result<FieldDefinition> {
  const errors: MaadError[] = [];

  for (const key of Object.keys(fd)) {
    if (!KNOWN_FIELD_KEYS.has(key)) {
      errors.push(maadError('SCHEMA_INVALID',
        `Schema "${schemaRef}" field "${name}" declares unknown key "${key}". ` +
        `This engine cannot enforce it, so the schema is refused rather than loaded with unenforced policy. ` +
        `Known keys: ${[...KNOWN_FIELD_KEYS].join(', ')}. If "${key}" is from a newer MAADb, upgrade this engine before activating the schema.`));
    }
  }

  const typeStr = fd['type'];
  if (typeof typeStr !== 'string' || !VALID_FIELD_TYPES.includes(typeStr as FieldType)) {
    errors.push(maadError('SCHEMA_INVALID',
      `Schema "${schemaRef}" field "${name}" has invalid type "${String(typeStr)}". Valid: ${VALID_FIELD_TYPES.join(', ')}`));
    return err(errors);
  }
  const fieldType = typeStr as FieldType;

  const index = fd['index'] === true;
  const role = typeof fd['role'] === 'string' ? fd['role'] : null;
  const format = typeof fd['format'] === 'string' ? fd['format'] : (fieldType === 'date' ? 'YYYY-MM-DD' : null);

  // Ref target validation — applies to ref fields AND list fields with item_type: ref
  let target: DocType | null = null;
  const needsTarget = fieldType === 'ref' || (fieldType === 'list' && fd['item_type'] === 'ref');
  if (needsTarget) {
    const targetStr = fd['target'];
    if (typeof targetStr !== 'string') {
      errors.push(maadError('SCHEMA_INVALID', `Schema "${schemaRef}" field "${name}" has ref target but no "target" type specified`));
    } else {
      if (!registry.types.has(docType(targetStr))) {
        errors.push(maadError('SCHEMA_INVALID', `Schema "${schemaRef}" field "${name}" references unknown type "${targetStr}"`));
      }
      target = docType(targetStr);
    }
  }

  // Enum values
  let values: string[] | null = null;
  if (fieldType === 'enum' || (fieldType === 'list' && fd['item_type'] === 'enum')) {
    const valuesRaw = fd['values'];
    if (!Array.isArray(valuesRaw) || valuesRaw.length === 0) {
      errors.push(maadError('SCHEMA_INVALID', `Schema "${schemaRef}" field "${name}" has enum values but no "values" array`));
    } else {
      values = valuesRaw.map(String);
    }
  }

  // List item type
  let itemType: FieldType | null = null;
  if (fieldType === 'list') {
    const itemTypeStr = fd['item_type'];
    if (typeof itemTypeStr === 'string' && VALID_FIELD_TYPES.includes(itemTypeStr as FieldType)) {
      itemType = itemTypeStr as FieldType;
    } else if (itemTypeStr !== undefined) {
      errors.push(maadError('SCHEMA_INVALID',
        `Schema "${schemaRef}" field "${name}" has invalid item_type "${String(itemTypeStr)}". Valid: ${VALID_FIELD_TYPES.join(', ')}`));
    }
    // item_type is optional for lists — default to string items
  }

  const defaultValue = fd['default'] ?? null;

  // --- 0.6.7 schema precision hints (only meaningful on date fields) -----
  let storePrecision: Precision | null = null;
  let onCoarser: 'warn' | 'error' | null = null;
  let displayPrecision: Precision | null = null;

  if (fieldType === 'date') {
    const spRaw = fd['store_precision'];
    if (spRaw !== undefined) {
      if (!isPrecision(spRaw)) {
        errors.push(maadError('SCHEMA_INVALID',
          `Schema "${schemaRef}" field "${name}" has invalid store_precision "${String(spRaw)}". ` +
          `Valid: year, month, day, hour, minute, second, millisecond`));
      } else {
        storePrecision = spRaw;
      }
    }

    const ocRaw = fd['on_coarser'];
    if (ocRaw !== undefined) {
      if (ocRaw !== 'warn' && ocRaw !== 'error') {
        errors.push(maadError('SCHEMA_INVALID',
          `Schema "${schemaRef}" field "${name}" has invalid on_coarser "${String(ocRaw)}". ` +
          `Valid: warn, error`));
      } else {
        onCoarser = ocRaw;
      }
    } else if (storePrecision !== null) {
      // Default to warn when store_precision is declared — the non-breaking
      // rollout target. Callers who want strict behavior must opt in.
      onCoarser = 'warn';
    }

    const dpRaw = fd['display_precision'];
    if (dpRaw !== undefined) {
      if (!isPrecision(dpRaw)) {
        errors.push(maadError('SCHEMA_INVALID',
          `Schema "${schemaRef}" field "${name}" has invalid display_precision "${String(dpRaw)}". ` +
          `Valid: year, month, day, hour, minute, second, millisecond`));
      } else {
        displayPrecision = dpRaw;
      }
    }

    // display_precision must be coarser-or-equal to store_precision (i.e.
    // display no finer than storage). Inverted is nonsense — render finer
    // than what's actually captured.
    if (storePrecision !== null && displayPrecision !== null) {
      if (comparePrecision(displayPrecision, storePrecision) > 0) {
        errors.push(maadError('SCHEMA_INVALID',
          `Schema "${schemaRef}" field "${name}" has display_precision "${displayPrecision}" finer than ` +
          `store_precision "${storePrecision}". display must be coarser-or-equal to store.`));
      }
    }
  } else {
    // Non-date fields must not declare precision keys.
    for (const k of ['store_precision', 'on_coarser', 'display_precision']) {
      if (fd[k] !== undefined) {
        errors.push(maadError('SCHEMA_INVALID',
          `Schema "${schemaRef}" field "${name}" of type "${fieldType}" cannot declare "${k}" — only valid on date fields`));
      }
    }
  }

  // --- 0.12.0 structural constraints (only meaningful on string fields) ----
  let maxLength: number | null = null;
  let softMaxLength: number | null = null;
  let multiline: boolean | null = null;

  if (fieldType === 'string') {
    const parseLimit = (key: 'max_length' | 'soft_max_length'): number | null => {
      const raw = fd[key];
      if (raw === undefined) return null;
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
        errors.push(maadError('SCHEMA_INVALID',
          `Schema "${schemaRef}" field "${name}" has invalid ${key} "${String(raw)}" — must be a positive integer (Unicode code points)`));
        return null;
      }
      return raw;
    };
    maxLength = parseLimit('max_length');
    softMaxLength = parseLimit('soft_max_length');

    const mlRaw = fd['multiline'];
    if (mlRaw !== undefined) {
      if (typeof mlRaw !== 'boolean') {
        errors.push(maadError('SCHEMA_INVALID',
          `Schema "${schemaRef}" field "${name}" has invalid multiline "${String(mlRaw)}" — must be true or false`));
      } else {
        multiline = mlRaw;
      }
    }

    if (maxLength !== null && softMaxLength !== null && softMaxLength > maxLength) {
      errors.push(maadError('SCHEMA_INVALID',
        `Schema "${schemaRef}" field "${name}" has soft_max_length ${softMaxLength} > max_length ${maxLength} — the advisory limit must not exceed the hard limit`));
    }
  } else {
    // Constraint keys on non-string fields are configuration errors — same
    // posture as precision keys on non-date fields.
    for (const k of ['max_length', 'soft_max_length', 'multiline']) {
      if (fd[k] !== undefined) {
        errors.push(maadError('SCHEMA_INVALID',
          `Schema "${schemaRef}" field "${name}" of type "${fieldType}" cannot declare "${k}" — only valid on string fields`));
      }
    }
  }

  if (errors.length > 0) return err(errors);

  return ok({
    name,
    type: fieldType,
    index,
    role,
    format,
    target,
    values,
    defaultValue,
    itemType,
    storePrecision,
    onCoarser,
    displayPrecision,
    maxLength,
    softMaxLength,
    multiline,
  });
}

function parseVersionFromRef(ref: SchemaRef): number {
  const match = /\.v(\d+)$/.exec(ref as string);
  return match ? parseInt(match[1]!, 10) : 1;
}
