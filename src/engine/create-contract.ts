import path from 'node:path';
import { lstatSync } from 'node:fs';
import yaml from 'js-yaml';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { loadSchemas } from '../schema/loader.js';
import { buildSubtypeMap, DEFAULT_SUBTYPE_MAP, PRIMITIVES, docType, schemaRef, type Registry, type SchemaStore } from '../types.js';
import { canonicalJson, rawSha256, readWorkingReceipt } from './document-receipt.js';
import { isSafeProjectRelativePath, isSafeSchemaRef, isWritePathContainedIn } from './pathguard.js';
import { ReceiptError } from '../git/exact-blob.js';
import type { JsonValue } from './document-receipt-types.js';
import type { CreateContract } from './guarded-create-types.js';
import type { EngineContext } from './context.js';

const engineVersion = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
const typeDefinition = z.object({
  path: z.string().min(1), id_prefix: z.string().regex(/^[a-z0-9]{2,5}$/),
  schema: z.string().refine(isSafeSchemaRef), template: z.string().min(1).optional(),
}).passthrough();
const registryDefinition = z.object({
  types: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), typeDefinition),
  extraction: z.object({ subtypes: z.record(z.string(), z.enum(PRIMITIVES)).optional() }).passthrough().optional(),
}).passthrough();

function parseSource(raw: string): unknown {
  const text = raw.replace(/^\uFEFF/, '');
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const value: unknown = yaml.load(match ? match[1]! : text, { schema: yaml.CORE_SCHEMA });
  canonicalJson(value);
  return value;
}

/** Ordered map entries retain schema field ordering, which affects serialization. */
function effectiveContract(registry: Registry, schemas: SchemaStore): JsonValue {
  return JSON.parse(canonicalJson({
    types: [...registry.types], extraction: registry.extraction, subtypeMap: registry.subtypeMap,
    schemas: [...schemas.schemas].map(([ref, schema]) => [ref, { ...schema, fields: [...schema.fields] }]),
  })) as JsonValue;
}

/** No registry activation, directory creation, index rebuild, or stale fallback. */
export async function freshCreateContract(ctx: EngineContext, type: string, signal?: AbortSignal): Promise<{
  contract: CreateContract; registry: Registry; schemaStore: SchemaStore;
}> {
  const sources: Record<string, string> = Object.create(null) as Record<string, string>;
  let total = 0;
  const read = async (relative: string): Promise<string> => {
    if (Object.hasOwn(sources, relative)) return sources[relative]!;
    if (Object.keys(sources).length >= 129) throw new ReceiptError('SCHEMA_INVALID', 'Too many contract dependencies');
    const bytes = await readWorkingReceipt(ctx.projectRoot, relative, signal);
    total += bytes.length;
    if (total > 256 * 1024) throw new ReceiptError('RESPONSE_TOO_LARGE', 'Schema dependency snapshot exceeds 256 KiB');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    sources[relative] = text;
    return text;
  };
  const parsed = registryDefinition.parse(parseSource(await read('_registry/object_types.yaml')));
  const entries = Object.entries(parsed.types);
  if (entries.length === 0 || entries.length > 64) throw new ReceiptError('SCHEMA_INVALID', 'Contract requires 1 to 64 registered types');
  const registry: Registry = { types: new Map(), extraction: { subtypes: parsed.extraction?.subtypes ?? {} },
    subtypeMap: buildSubtypeMap(DEFAULT_SUBTYPE_MAP, parsed.extraction?.subtypes) };
  const prefixes = new Set<string>();
  for (const [name, def] of entries) {
    if (prefixes.has(def.id_prefix)) throw new ReceiptError('REGISTRY_INVALID', 'Duplicate registry prefix');
    prefixes.add(def.id_prefix);
    for (const relative of [def.path, ...(def.template ? [def.template] : [])]) {
      if (!isSafeProjectRelativePath(relative) || !isWritePathContainedIn(path.join(ctx.projectRoot, relative), ctx.projectRoot)) {
        throw new ReceiptError('PATH_OUTSIDE_PROJECT', 'Contract dependency escapes project');
      }
    }
    let directory = ctx.projectRoot;
    for (const component of def.path.split('/').filter(Boolean)) {
      directory = path.join(directory, component);
      try {
        const entry = lstatSync(directory);
        if (entry.isSymbolicLink() || !entry.isDirectory()) throw new ReceiptError('PATH_OUTSIDE_PROJECT', 'Create directory must be a real directory');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    registry.types.set(docType(name), { name: docType(name), path: def.path, idPrefix: def.id_prefix,
      schemaRef: schemaRef(def.schema), template: def.template ?? null });
    const schema = parseSource(await read(`_schema/${def.schema}.yaml`));
    // Refuse malformed top-level shapes that the legacy loader tolerates.
    z.object({ type: z.literal(name), version: z.number().int().positive().optional(),
      required: z.array(z.string()).optional(), fields: z.record(z.string(), z.object({ type: z.string() }).passthrough()),
      template: z.object({ headings: z.array(z.object({ level: z.number().int().min(1).max(6),
        text: z.string(), id: z.string().nullable().optional() }).passthrough()) }).passthrough().optional(),
    }).passthrough().parse(schema);
    if (def.template) await read(def.template);
  }
  if (!registry.types.has(docType(type))) throw new ReceiptError('UNKNOWN_TYPE', 'Unknown contract document type');
  // The shared schema loader performs the complete constraint validation. Reads
  // are bracketed by bounded byte snapshots, never an mtime/size-only cache.
  const loaded = await loadSchemas(ctx.projectRoot, registry);
  if (!loaded.ok) throw new ReceiptError('SCHEMA_INVALID', 'Fresh schema validation failed');
  for (const [relative, expected] of Object.entries(sources)) {
    const actual = await readWorkingReceipt(ctx.projectRoot, relative, signal);
    if (!actual.equals(Buffer.from(expected))) throw new ReceiptError('SCHEMA_CONTRACT_CHANGED', 'Schema changed during observation');
  }
  const schemaContract: JsonValue = {
    projection: 'create-schema-v1', engineVersion,
    contentProjection: 'document-content-v1',
    sources, effective: effectiveContract(registry, loaded.value),
  };
  const canonical = canonicalJson(schemaContract);
  if (Buffer.byteLength(canonical) > 512 * 1024) throw new ReceiptError('RESPONSE_TOO_LARGE', 'Complete schema contract exceeds bound');
  return { registry, schemaStore: loaded.value, contract: {
    contract: 'create-contract-v1', docType: type, schemaDigest: rawSha256(Buffer.from(canonical)),
    schemaProjection: 'create-schema-v1', contentProjection: 'document-content-v1', schemaContract,
    effectiveHistoryMode: ctx.history?.config.effectiveMode ?? 'feed',
  } };
}
