import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { ok, singleErr, type Result } from '../errors.js';
import { readExactBlob, ReceiptError, RECEIPT_MAX_BYTES, checkReceiptAbort } from '../git/exact-blob.js';
import { checkDocIdSafe } from './docid-safe.js';
import { isContainedIn } from './pathguard.js';
import type { EngineContext } from './context.js';
import type { DocumentReceipt, DocumentReceiptRequest, JsonValue } from './document-receipt-types.js';
import { docId, docType } from '../types.js';

const version = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;
export const rawSha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Explicit serialization preserves UTF-16 key ordering even for integer-like keys. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const encode = (v: unknown, depth: number): string => {
    if (++nodes > 65536 || depth > 64) throw new ReceiptError('RECEIPT_CONTENT_INVALID', 'Content structure exceeds bounds');
    if (v === null || typeof v === 'boolean' || typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))) {
      const text = JSON.stringify(v);
      bytes += Buffer.byteLength(text);
      if (bytes > 1024 * 1024) throw new ReceiptError('RESPONSE_TOO_LARGE', 'Canonical content exceeds bound');
      return text;
    }
    if (typeof v !== 'object' || !v || seen.has(v)) throw new ReceiptError('RECEIPT_CONTENT_INVALID', 'Unsupported JSON content');
    const proto = Object.getPrototypeOf(v);
    if (Array.isArray(v) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) {
      throw new ReceiptError('RECEIPT_CONTENT_INVALID', 'Unsupported content prototype');
    }
    if (Reflect.ownKeys(v).some(key => typeof key !== 'string')) throw new ReceiptError('RECEIPT_CONTENT_INVALID', 'Unsupported content key');
    const descriptors = Object.getOwnPropertyDescriptors(v);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(v) && key === 'length') continue;
      if (!('value' in descriptor) || !descriptor.enumerable) throw new ReceiptError('RECEIPT_CONTENT_INVALID', 'Unsupported content property');
    }
    seen.add(v);
    let result: string;
    if (Array.isArray(v)) {
      if (Object.keys(v).length !== v.length) throw new ReceiptError('RECEIPT_CONTENT_INVALID', 'Sparse or decorated array');
      result = '[' + Array.from(v, item => encode(item, depth + 1)).join(',') + ']';
    } else {
      result = '{' + Object.keys(v).sort().map(key => {
        const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
        if (!('value' in descriptor)) throw new ReceiptError('RECEIPT_CONTENT_INVALID', 'Unsupported content accessor');
        return encode(key, depth + 1) + ':' + encode(descriptor.value, depth + 1);
      }).join(',') + '}';
    }
    seen.delete(v);
    return result;
  };
  return encode(value, 0);
}

export function contentDigest(id: string, type: string, frontmatter: Record<string, JsonValue>, body: string): string {
  const canonical = `{"docId":${canonicalJson(id)},"docType":${canonicalJson(type)},"frontmatter":${canonicalJson(frontmatter)},"body":${canonicalJson(body)}}`;
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function parseReceiptContent(bytes: Buffer, id: string, type: string, schema: string) {
  if (bytes.length > RECEIPT_MAX_BYTES) throw new ReceiptError('RESPONSE_TOO_LARGE', 'Receipt content exceeds bound');
  try {
    // ignoreBOM preserves it in rawMarkdown; parsing alone removes one BOM.
    const rawMarkdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const text = rawMarkdown.replace(/^\uFEFF/, '');
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) throw new Error('Missing frontmatter delimiters');
    const parsed: unknown = yaml.load(match[1]!, { schema: yaml.CORE_SCHEMA, json: false });
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Frontmatter must be a mapping');
    canonicalJson(parsed);
    const frontmatter = parsed as Record<string, JsonValue>;
    for (const [key, expected] of [['doc_id', id], ['doc_type', type], ['schema', schema]]) {
      if (!Object.hasOwn(frontmatter, key!) || frontmatter[key!] !== expected) throw new Error('Document identity conflict');
    }
    const body = text.slice(match[0].length).replace(/\r\n/g, '\n').trim();
    return { rawMarkdown, frontmatter, body, contentDigest: contentDigest(id, type, frontmatter, body) };
  } catch (error) {
    if (error instanceof ReceiptError) throw error;
    throw new ReceiptError('RECEIPT_CONTENT_INVALID', 'Receipt requires valid UTF-8, strict YAML, JSON values, and matching identity');
  }
}

async function checkedPath(root: string, relative: string): Promise<string> {
  const target = path.resolve(root, relative);
  if (!isContainedIn(target, root)) throw new ReceiptError('PATH_OUTSIDE_PROJECT', 'Receipt path escapes project');
  const actualRoot = await realpath(root);
  let current = root;
  for (const component of relative.split('/')) {
    current = path.join(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new ReceiptError('PATH_OUTSIDE_PROJECT', 'Receipt path contains a symbolic link');
  }
  if (!isContainedIn(await realpath(target), actualRoot)) throw new ReceiptError('PATH_OUTSIDE_PROJECT', 'Receipt path escapes project');
  return target;
}

export async function readWorkingReceipt(root: string, relative: string, signal?: AbortSignal): Promise<Buffer> {
  return (await readWorkingReceiptSnapshot(root, relative, signal)).bytes;
}

/** One bounded handle read; compare both handle and pathname identity around it. */
export async function readWorkingReceiptSnapshot(root: string, relative: string, signal?: AbortSignal): Promise<{
  bytes: Buffer; mtimeMs: number; size: number;
}> {
  checkReceiptAbort(signal);
  const target = await checkedPath(root, relative);
  const before = await lstat(target, { bigint: true });
  if (!before.isFile()) throw new ReceiptError('RECEIPT_CONTENT_INVALID', 'Receipt target must be regular');
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const same = (a: typeof before, b: typeof before) => a.dev === b.dev && a.ino === b.ino
    && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && b.isFile();
  try {
    const opened = await handle.stat({ bigint: true });
    if (!same(before, opened)) throw new ReceiptError('RECEIPT_OBSERVATION_CHANGED', 'Working file changed before read');
    if (opened.size > BigInt(RECEIPT_MAX_BYTES)) throw new ReceiptError('RESPONSE_TOO_LARGE', 'Working file exceeds bound');
    // Cache hints come from this same handle. Bigint nanosecond identity checks
    // below remain authoritative; retain native numeric stat precision for the
    // existing legacy mtime/size cache comparisons.
    const cached = await handle.stat();
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      checkReceiptAbort(signal);
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    let named: typeof before;
    try {
      await checkedPath(root, relative);
      named = await lstat(target, { bigint: true });
    } catch { throw new ReceiptError('RECEIPT_OBSERVATION_CHANGED', 'Working pathname changed during read'); }
    if (!same(opened, after) || !same(after, named) || BigInt(length) !== opened.size) {
      throw new ReceiptError('RECEIPT_OBSERVATION_CHANGED', 'Working file changed during read');
    }
    checkReceiptAbort(signal);
    return { bytes: buffer.subarray(0, length), mtimeMs: cached.mtimeMs, size: cached.size };
  } finally { await handle.close(); }
}

export async function documentReceipt(ctx: EngineContext, request: DocumentReceiptRequest, project: string,
  signal?: AbortSignal): Promise<Result<DocumentReceipt>> {
  try {
    checkReceiptAbort(signal);
    if (request.contract !== 'document-persistence-v1' || typeof request.docType !== 'string'
      || Buffer.byteLength(request.docType) > 256 || !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(request.docType)
      || (request.expectedContentDigest !== undefined && !/^[0-9a-f]{64}$/.test(request.expectedContentDigest))) {
      return singleErr('INVALID_FIELDS', 'Invalid document receipt request');
    }
    const unsafe = checkDocIdSafe(request.docId);
    if (unsafe) return singleErr('INVALID_DOC_ID', unsafe.message);
    const registered = ctx.registry.types.get(docType(request.docType));
    if (!registered) return singleErr('UNKNOWN_TYPE', 'Unknown receipt document type');
    const target = path.resolve(ctx.projectRoot, registered.path, `${request.docId}.md`);
    if (!isContainedIn(target, ctx.projectRoot)) return singleErr('PATH_OUTSIDE_PROJECT', 'Receipt path escapes project');
    const relative = path.relative(ctx.projectRoot, target).split(path.sep).join('/');
    const identity = () => {
      const row = ctx.backend.getDocument(docId(request.docId));
      if (!row) return 'missing' as const;
      return row.docId === request.docId && row.docType === request.docType && row.schemaRef === registered.schemaRef
        && (row.filePath as string).replace(/\\/g, '/') === relative ? 'present' as const : 'identity_mismatch' as const;
    };
    const initial = identity();
    const registeredIdentity = `${registered.path}\0${registered.schemaRef}`;
    const receipt: DocumentReceipt = {
      contract: 'document-persistence-v1', engineVersion: version, project, docId: request.docId, docType: request.docType,
      observedAt: new Date().toISOString(), effectiveHistoryMode: ctx.history?.config.effectiveMode ?? 'feed',
      projection: 'document-content-v1', expectedContentDigest: request.expectedContentDigest ?? null,
      status: 'unverified', reason: null, index: { state: initial },
      workingTree: { state: 'not_checked', rawSha256: null, contentDigest: null }, committed: null, expectedDigestMatch: null,
    };
    const finish = (): Result<DocumentReceipt> => {
      checkReceiptAbort(signal);
      if (identity() !== initial || ctx.registry.types.get(docType(request.docType)) !== registered
        || `${registered.path}\0${registered.schemaRef}` !== registeredIdentity || ctx.schemaStore.isStale()) {
        throw new ReceiptError('RECEIPT_OBSERVATION_CHANGED', 'Receipt index or configuration changed');
      }
      receipt.observedAt = new Date().toISOString();
      return ok(receipt);
    };
    if (initial !== 'present') { receipt.reason = initial === 'missing' ? 'index_missing' : 'index_identity_mismatch'; return finish(); }
    if (!ctx.gitLayer || !ctx.history || receipt.effectiveHistoryMode === 'feed') {
      receipt.reason = 'history_unavailable'; return finish();
    }
    const evidence = await readExactBlob(ctx.projectRoot, relative, signal);
    if (!evidence) { receipt.reason = 'uncommitted'; return finish(); }
    const committed = parseReceiptContent(evidence.bytes, request.docId, request.docType, registered.schemaRef as string);
    let working: Buffer;
    try { working = await readWorkingReceipt(ctx.projectRoot, relative, signal); }
    catch (error) {
      if (error instanceof ReceiptError && error.code === 'RECEIPT_OBSERVATION_CHANGED') {
        receipt.reason = 'working_tree_changed'; receipt.workingTree.state = 'changed';
      } else if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        receipt.reason = 'working_tree_missing'; receipt.workingTree.state = 'missing';
      } else if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        receipt.reason = 'working_tree_unreadable'; receipt.workingTree.state = 'unreadable';
      } else throw error;
      return finish();
    }
    const parsedWorking = parseReceiptContent(working, request.docId, request.docType, registered.schemaRef as string);
    receipt.workingTree.rawSha256 = rawSha256(working);
    receipt.workingTree.contentDigest = parsedWorking.contentDigest;
    if (parsedWorking.contentDigest !== committed.contentDigest) {
      receipt.reason = 'working_tree_diverged'; receipt.workingTree.state = 'diverged'; return finish();
    }
    receipt.workingTree.state = 'matches_committed';
    receipt.committed = { evidenceKind: 'git_commit_visible', objectFormat: evidence.objectFormat,
      commitOid: evidence.commitOid, treeOid: evidence.treeOid, blobOid: evidence.blobOid,
      byteLength: evidence.bytes.length, rawSha256: rawSha256(evidence.bytes), ...committed };
    receipt.status = 'committed_content_available';
    receipt.expectedDigestMatch = request.expectedContentDigest === undefined ? null : request.expectedContentDigest === committed.contentDigest;
    return finish();
  } catch (error) {
    return error instanceof ReceiptError ? singleErr(error.code, error.message)
      : singleErr('RECEIPT_STORAGE_ERROR', 'Receipt storage could not be read');
  }
}
