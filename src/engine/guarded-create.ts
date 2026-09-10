import { z } from 'zod';
import { err, ok, singleErr, type Result } from '../errors.js';
import { HISTORY_MODES } from '../history/types.js';
import { docType, type Registry, type SchemaStore } from '../types.js';
import { ReceiptError } from '../git/exact-blob.js';
import { canonicalJson, parseReceiptContent } from './document-receipt.js';
import { checkDocIdSafe } from './docid-safe.js';
import { freshCreateContract } from './create-contract.js';
import { prepareCreateDocument, publishPreparedCreate } from './writes.js';
import type { EngineContext } from './context.js';
import type { GuardedCreateRequest, GuardedCreateOptions, GuardedCreateResult } from './guarded-create-types.js';

export const createContractRequestSchema = z.object({
  contract: z.literal('create-contract-v1'), docType: z.string().min(1).max(256),
}).strict();
export const guardedCreateRequestSchema = z.object({
  contract: z.literal('guarded-create-v1'), docType: z.string().min(1).max(256),
  docId: z.string().min(1).max(128).refine(id => !checkDocIdSafe(id) && !checkDocIdSafe(id.split('.')[0]!)),
  fields: z.record(z.string(), z.unknown()), body: z.string(),
  expectedSchemaDigest: z.string().regex(/^[0-9a-f]{64}$/),
  expectedContentDigest: z.string().regex(/^[0-9a-f]{64}$/),
  allowedHistoryModes: z.array(z.enum(HISTORY_MODES)).min(1).max(HISTORY_MODES.length)
    .refine(modes => new Set(modes).size === modes.length),
}).strict();

export function admissionError(error: unknown): Result<never> {
  return error instanceof ReceiptError ? singleErr(error.code, error.message)
    : singleErr('SCHEMA_INVALID', 'Cannot read a complete valid schema contract');
}

export async function guardedCreate(ctx: EngineContext, request: GuardedCreateRequest,
  options: GuardedCreateOptions, isReady: () => boolean,
  onAdmitted: (registry: Registry, schemaStore: SchemaStore) => void): Promise<Result<GuardedCreateResult>> {
  // Freeze caller data before the first await. In-process objects have the same
  // strict JSON requirements as wire input, including prototypes and accessors.
  let frozen: GuardedCreateRequest;
  try {
    const json = canonicalJson(request);
    if (Buffer.byteLength(json) > 256 * 1024) return singleErr('RESPONSE_TOO_LARGE', 'Create request exceeds 256 KiB');
    frozen = JSON.parse(json) as GuardedCreateRequest;
    if (!guardedCreateRequestSchema.safeParse(frozen).success) return singleErr('INVALID_FIELDS', 'Invalid guarded create request');
  } catch { return singleErr('INVALID_FIELDS', 'Guarded create requires bounded JSON data'); }
  const check = (): Result<never> | null => {
    const denied = options.validateAccess?.();
    if (denied) return err([denied]);
    if (options.signal?.aborted) return singleErr('REQUEST_TIMEOUT', 'Guarded create cancelled before publication');
    if (!isReady()) return singleErr('CREATE_ENGINE_NOT_READY', 'Create engine is not ready');
    if (ctx.readOnly || ctx.history?.config.effectiveMode === 'read') return singleErr('READ_ONLY', 'Project is read-only');
    if (!frozen.allowedHistoryModes.includes(ctx.history?.config.effectiveMode ?? 'feed')) {
      return singleErr('HISTORY_MODE_MISMATCH', 'Effective history mode is not allowed');
    }
    return null;
  };
  let published = false;
  try {
    const initial = check();
    if (initial) return initial;
    const snapshot = await freshCreateContract(ctx, frozen.docType, options.signal);
    if (snapshot.contract.schemaDigest !== frozen.expectedSchemaDigest) {
      return singleErr('SCHEMA_CONTRACT_CHANGED', 'Complete schema contract differs from expectation');
    }
    const preparedCtx = { ...ctx, registry: snapshot.registry, schemaStore: snapshot.schemaStore };
    const prepared = prepareCreateDocument(preparedCtx, docType(frozen.docType), frozen.fields, frozen.body, frozen.docId);
    if (!prepared.ok) return prepared;
    const registered = snapshot.registry.types.get(docType(frozen.docType))!;
    const parsed = parseReceiptContent(Buffer.from(prepared.value.markdown), frozen.docId, frozen.docType, registered.schemaRef);
    const expectedFrontmatter = { ...frozen.fields, doc_id: frozen.docId, doc_type: frozen.docType, schema: registered.schemaRef };
    if (canonicalJson(parsed.frontmatter) !== canonicalJson(expectedFrontmatter)
      || parsed.body !== frozen.body.replace(/\r\n/g, '\n').trim()) {
      return singleErr('INVALID_FIELDS', 'Document serialization does not preserve supplied JSON content');
    }
    if (parsed.contentDigest !== frozen.expectedContentDigest) return singleErr('CONTENT_DIGEST_MISMATCH', 'Complete document digest differs from expectation');
    // Bracket preparation with fresh schema observations. Routing callbacks
    // are synchronous: the final authority check has no await before publication.
    const denied = check();
    if (denied) return denied;
    const verified = await freshCreateContract(ctx, frozen.docType, options.signal);
    if (verified.contract.schemaDigest !== snapshot.contract.schemaDigest) return singleErr('SCHEMA_CONTRACT_CHANGED', 'Schema changed during admission');
    const final = check();
    if (final) return final;
    const effectiveHistoryMode = ctx.history?.config.effectiveMode ?? 'feed';
    onAdmitted(snapshot.registry, snapshot.schemaStore);
    published = true;
    const result = await publishPreparedCreate(preparedCtx, prepared.value);
    return result.ok ? ok({ ...result.value, contract: 'guarded-create-v1', schemaDigest: frozen.expectedSchemaDigest,
      contentDigest: parsed.contentDigest, effectiveHistoryMode }) : result;
  } catch (error) {
    return published ? singleErr('WRITE_ERROR', 'Create publication outcome is uncertain; reconcile using document receipt') : admissionError(error);
  }
}
