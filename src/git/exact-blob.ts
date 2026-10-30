import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { ErrorCode } from '../errors.js';

export const RECEIPT_MAX_BYTES = 256 * 1024;
// The batch read also returns the commit object, whose message is unbounded.
const COMMIT_MAX_BYTES = 1024 * 1024;
export class ReceiptError extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); }
}
export function checkReceiptAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ReceiptError('REQUEST_TIMEOUT', 'Receipt observation cancelled');
}

/** No shell, replace objects, optional locks, lazy fetch, filters, or text conversion. */
async function git(root: string, args: string[], cap: number, signal?: AbortSignal, input?: string): Promise<Buffer> {
  checkReceiptAbort(signal);
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
    Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1',
      GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' });
    const child = spawn('git', ['--no-pager', '--literal-pathspecs', '-c', 'maintenance.auto=false',
      '-c', 'gc.auto=0', ...args], { cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    // A child stopped at the cap closes this pipe early; its close event reports it.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    const chunks: Buffer[] = [];
    let size = 0;
    let stderrSize = 0;
    let failure: ReceiptError | undefined;
    const stop = (error: ReceiptError) => { failure ??= error; child.kill(); };
    const abort = () => stop(new ReceiptError('REQUEST_TIMEOUT', 'Receipt observation cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new ReceiptError('REQUEST_TIMEOUT', 'Receipt Git read timed out')), 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) stop(new ReceiptError('RESPONSE_TOO_LARGE', 'Receipt Git output exceeds bound'));
      else if (!failure) chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > 8192) stop(new ReceiptError('RECEIPT_STORAGE_ERROR', 'Receipt Git diagnostic exceeds bound'));
    });
    child.on('error', () => { failure ??= new ReceiptError('RECEIPT_STORAGE_ERROR', 'Cannot start receipt Git reader'); });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new ReceiptError('RECEIPT_STORAGE_ERROR', 'Cannot read committed Git objects'));
      else resolve(Buffer.concat(chunks, size));
    });
    if (signal?.aborted) abort();
  });
}

/** One `cat-file --batch` record: `<oid> <type> <size>\n<content>\n`. */
function batchRecord(output: Buffer, start: number, oid: string, type: string): { size: number; bytes: Buffer; next: number } {
  const headerEnd = output.indexOf(0x0a, start);
  const header = headerEnd < 0 ? null : /^(\S+) (\S+) (\d+)$/.exec(output.toString('ascii', start, headerEnd));
  if (!header || header[1] !== oid || header[2] !== type) throw new ReceiptError('RECEIPT_STORAGE_ERROR', 'Invalid blob metadata');
  const size = Number(header[3]);
  const bytes = output.subarray(headerEnd + 1, headerEnd + 1 + size);
  return { size, bytes, next: headerEnd + 1 + size + 1 };
}

export interface ExactBlob {
  objectFormat: 'sha1' | 'sha256';
  commitOid: string;
  treeOid: string;
  blobOid: string;
  bytes: Buffer;
}

/** Pins HEAD once. All subsequent object reads use immutable full object IDs. */
export async function readExactBlob(root: string, relative: string, signal?: AbortSignal): Promise<ExactBlob | null> {
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  checkReceiptAbort(signal);
  if (!path.isAbsolute(root) || relative.includes('\\') || relative.split('/').some(p => !p || p === '.' || p === '..')
      || path.isAbsolute(relative) || relative.includes(':') || relative.includes('\0')) {
    throw new ReceiptError('PATH_OUTSIDE_PROJECT', 'Invalid receipt target');
  }
  // Do not discover a parent repository or follow a linked object store.
  const marker = await lstat(path.join(root, '.git'));
  if (!marker.isDirectory() || marker.isSymbolicLink()) throw new ReceiptError('RECEIPT_STORAGE_ERROR', 'Receipt requires a local Git directory');
  const [format, commitOid] = (await git(root, ['rev-parse', '--show-object-format', '--verify', 'HEAD^{commit}'], 128, signal))
    .toString('ascii').trim().split('\n');
  if (format !== 'sha1' && format !== 'sha256') throw new ReceiptError('RECEIPT_STORAGE_ERROR', 'Unsupported Git object format');
  const oidPattern = format === 'sha1' ? /^[0-9a-f]{40}$/ : /^[0-9a-f]{64}$/;
  if (!commitOid || !oidPattern.test(commitOid)) throw new ReceiptError('RECEIPT_STORAGE_ERROR', 'Invalid commit object ID');
  const entry = await git(root, ['ls-tree', '-z', commitOid, '--', relative], 4096, signal);
  if (entry.length === 0) return null;
  const match = /^(100644|100755) blob ([0-9a-f]+)\t([^\0]+)\0$/.exec(entry.toString('utf8'));
  if (!match || match[3] !== relative || !oidPattern.test(match[2]!)) {
    throw new ReceiptError('RECEIPT_CONTENT_INVALID', 'Committed target is not an exact regular file');
  }
  const blobOid = match[2]!;
  const objects = await git(root, ['cat-file', '--batch'], RECEIPT_MAX_BYTES + COMMIT_MAX_BYTES, signal, `${commitOid}\n${blobOid}\n`);
  const commit = batchRecord(objects, 0, commitOid, 'commit');
  const treeOid = /^tree (\S+)\n/.exec(commit.bytes.toString('ascii', 0, 128))?.[1];
  if (!treeOid || !oidPattern.test(treeOid)) throw new ReceiptError('RECEIPT_STORAGE_ERROR', 'Invalid tree object ID');
  const { size, bytes } = batchRecord(objects, commit.next, blobOid, 'blob');
  if (size > RECEIPT_MAX_BYTES) throw new ReceiptError('RESPONSE_TOO_LARGE', 'Receipt blob exceeds bound');
  const actualOid = createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  if (bytes.length !== size || actualOid !== blobOid) throw new ReceiptError('RECEIPT_STORAGE_ERROR', 'Blob identity or size mismatch');
  return { objectFormat: format, commitOid, treeOid, blobOid, bytes };
}
