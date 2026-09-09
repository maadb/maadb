import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MaadEngine } from '../../src/engine/index.js';
import { canonicalJson, contentDigest, parseReceiptContent, rawSha256, readWorkingReceipt } from '../../src/engine/document-receipt.js';
import { docId, docType } from '../../src/types.js';
import type { DocumentReceiptRequest } from '../../src/engine/document-receipt-types.js';
import type { HistoryMode } from '../../src/history/types.js';
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));

let root: string;
let engine: MaadEngine;
const request: DocumentReceiptRequest = { contract: 'document-persistence-v1', docType: 'client', docId: 'cli-acme' };
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true }).toString().trim();
const target = () => path.join(root, 'clients', 'cli-acme.md');
const snapshot = () => {
  const result: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else result[path.relative(root, file)] = rawSha256(readFileSync(file));
    }
  };
  walk(root); return result;
};
async function boot(mode: HistoryMode = 'audit', readOnly = false) {
  engine = new MaadEngine();
  const result = await engine.init(root, { readOnly, semantic: false, history: {
    effectiveMode: mode, configuredMode: mode, modeSource: 'project', options: {}, advisories: [],
  } });
  expect(result.ok).toBe(true);
}
beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'receipt-engine-'));
  cpSync(path.resolve(__dirname, '../fixtures/simple-crm'), root, { recursive: true,
    filter: source => !['_backend', '.git'].includes(path.basename(source)) });
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'noreply');
  git('config', 'core.autocrlf', 'false'); git('add', '.'); git('commit', '-m', 'Fixture');
  await boot();
  await engine.indexAll({ force: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await engine?.close();
  const relative = path.relative(tmpdir(), root);
  expect(relative && !relative.startsWith('..') && !path.isAbsolute(relative)).toBeTruthy();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('document receipt observations', () => {
  it('returns complete exact content, including extra fields, without changing any fixture bytes', async () => {
    // Establish SQLite's WAL read mark before the byte-level no-mutation observation.
    await engine.getDocument(docId('cli-acme'), 'hot');
    const before = snapshot();
    const health = engine.health();
    const mutation = vi.spyOn(engine, 'runExclusive');
    const result = await engine.documentReceipt(request, 'example');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe('committed_content_available');
    expect(result.value.committed?.rawMarkdown).toBe(readFileSync(target(), 'utf8'));
    expect(result.value.committed?.rawSha256).toBe(rawSha256(readFileSync(target())));
    expect(result.value.committed?.frontmatter.primary_contact).toBe('con-jane-smith');
    expect(result.value.expectedDigestMatch).toBeNull();
    expect(result.value.workingTree.state).toBe('matches_committed');
    expect(mutation).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
    expect(engine.health().lastWriteAt).toEqual(health.lastWriteAt);
    const digest = result.value.committed!.contentDigest;
    for (const [expectedContentDigest, match] of [[digest, true], ['0'.repeat(64), false]] as const) {
      const compared = await engine.documentReceipt({ ...request, expectedContentDigest }, 'example');
      expect(compared.ok && compared.value.expectedDigestMatch).toBe(match);
      expect(compared.ok && compared.value.status).toBe('committed_content_available');
    }
  });
  it('survives restart and allows an already-ready read-only engine', async () => {
    await engine.close(); await boot('read', true);
    const before = snapshot();
    const result = await engine.documentReceipt(request, 'example');
    expect(result.ok && result.value.status).toBe('committed_content_available');
    expect(snapshot()).toEqual(before);
  });
  it('keeps missing index distinct from an existing working file', async () => {
    const orphan = path.join(root, 'clients', 'cli-orphan.md');
    writeFileSync(orphan, readFileSync(target(), 'utf8').replace('cli-acme', 'cli-orphan'));
    const result = await engine.documentReceipt({ ...request, docId: 'cli-orphan', expectedContentDigest: '0'.repeat(64) }, 'example');
    expect(result.ok && result.value).toMatchObject({ reason: 'index_missing', status: 'unverified', committed: null, expectedDigestMatch: null });
  });
  it('rejects indexed path/schema/type conflicts', async () => {
    const backend = (engine as unknown as { backend: { getDocument: (id: unknown) => unknown } }).backend;
    const original = backend.getDocument(docId('cli-acme')) as Record<string, unknown>;
    for (const conflict of [{ filePath: 'other.md' }, { schemaRef: 'client.v2' }, { docType: 'contact' }, { docId: 'cli-other' }]) {
      const spy = vi.spyOn(backend, 'getDocument').mockReturnValue({ ...original, ...conflict });
      const result = await engine.documentReceipt(request, 'example');
      expect(result.ok && result.value.reason).toBe('index_identity_mismatch');
      spy.mockRestore();
    }
  });
  it('keeps edited or missing working files unverified with null committed evidence', async () => {
    writeFileSync(target(), readFileSync(target(), 'utf8') + '\nChanged');
    const diverged = await engine.documentReceipt(request, 'example');
    expect(diverged.ok && diverged.value).toMatchObject({ reason: 'working_tree_diverged', committed: null, expectedDigestMatch: null });
    unlinkSync(target());
    const missing = await engine.documentReceipt(request, 'example');
    expect(missing.ok && missing.value.reason).toBe('working_tree_missing');
  });
  it.each(['feed', 'batch', 'snapshot'] as const)('does not flush or infer persistence in %s mode', async mode => {
    await engine.close(); await boot(mode);
    const created = await engine.createDocument(docType('client'), { name: 'Pending', status: 'active' }, '', 'cli-pending');
    expect(created.ok).toBe(true);
    await engine.getDocument(docId('cli-pending'), 'hot');
    const before = snapshot();
    const flush = vi.spyOn(engine, 'flushHistory');
    const result = await engine.documentReceipt({ ...request, docId: 'cli-pending' }, 'example');
    expect(result.ok && result.value.reason).toBe(mode === 'feed' ? 'history_unavailable' : 'uncommitted');
    expect(flush).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });
  it('does not turn a failed commit with readable working content into evidence', async () => {
    const layer = (engine as unknown as { gitLayer: { commit: (...args: unknown[]) => Promise<unknown> } }).gitLayer;
    vi.spyOn(layer, 'commit').mockResolvedValue({ status: 'failed', code: 'GIT_ERROR', message: 'Fixture failure' });
    const created = await engine.createDocument(docType('client'), { name: 'Failed', status: 'active' }, '', 'cli-failed');
    expect(created.ok).toBe(true);
    const result = await engine.documentReceipt({ ...request, docId: 'cli-failed' }, 'example');
    expect(result.ok && result.value).toMatchObject({ status: 'unverified', reason: 'uncommitted', committed: null });
  });
  it('normalizes BOM/CRLF/body whitespace while preserving different raw hashes', async () => {
    const original = readFileSync(target(), 'utf8');
    writeFileSync(target(), '\uFEFF' + original.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') + ' \r\n');
    const result = await engine.documentReceipt(request, 'example');
    expect(result.ok && result.value.status).toBe('committed_content_available');
    if (result.ok) expect(result.value.workingTree.rawSha256).not.toBe(result.value.committed?.rawSha256);
  });
  it('rejects malformed, identity-conflicting and invalid UTF-8 committed bytes', async () => {
    for (const bytes of [Buffer.from('not frontmatter'), Buffer.from([0xff]),
      Buffer.from('---\ndoc_id: wrong\ndoc_type: client\nschema: client.v1\n---\n')]) {
      writeFileSync(target(), bytes); git('add', 'clients/cli-acme.md'); git('commit', '-m', 'Invalid fixture');
      const result = await engine.documentReceipt(request, 'example');
      expect(!result.ok && result.errors[0]?.code).toBe('RECEIPT_CONTENT_INVALID');
    }
  });
  it('returns unreadable separately and never silently substitutes an empty body', async () => {
    vi.spyOn(fs, 'open').mockRejectedValue(Object.assign(new Error('Denied'), { code: 'EACCES' }));
    const result = await engine.documentReceipt(request, 'example');
    expect(result.ok && result.value).toMatchObject({ reason: 'working_tree_unreadable', committed: null });
  });
  it('checks index identity again after storage reads', async () => {
    const backend = (engine as unknown as { backend: { getDocument: (id: unknown) => unknown } }).backend;
    const original = backend.getDocument(docId('cli-acme'));
    vi.spyOn(backend, 'getDocument').mockReturnValueOnce(original).mockReturnValue(undefined);
    const result = await engine.documentReceipt(request, 'example');
    expect(!result.ok && result.errors[0]?.code).toBe('RECEIPT_OBSERVATION_CHANGED');
  });
  it('does not repair stale schemas', async () => {
    const schema = path.join(root, '_schema', 'client.v1.yaml');
    writeFileSync(schema, readFileSync(schema, 'utf8') + '\n# changed fixture\n');
    const reload = vi.spyOn(engine, 'runExclusive');
    const result = await engine.documentReceipt(request, 'example');
    expect(!result.ok && result.errors[0]?.code).toBe('RECEIPT_OBSERVATION_CHANGED');
    expect(reload).not.toHaveBeenCalled();
  });
  it('bounds working reads and propagates unexpected storage errors', async () => {
    writeFileSync(target(), Buffer.alloc(256 * 1024 + 1));
    let result = await engine.documentReceipt(request, 'example');
    expect(!result.ok && result.errors[0]?.code).toBe('RESPONSE_TOO_LARGE');
    vi.spyOn(fs, 'open').mockRejectedValue(Object.assign(new Error('Device failure'), { code: 'EIO' }));
    result = await engine.documentReceipt(request, 'example');
    expect(!result.ok && result.errors[0]?.code).toBe('RECEIPT_STORAGE_ERROR');
  });
  it('detects modification during bounded consumption', async () => {
    const original = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      const read = handle.read.bind(handle);
      let changed = false;
      handle.read = (async (...readArgs: Parameters<typeof read>) => {
        const result = await read(...readArgs);
        if (!changed) { changed = true; writeFileSync(target(), 'changed during read'); }
        return result;
      }) as typeof handle.read;
      return handle;
    });
    const result = await engine.documentReceipt(request, 'example');
    expect(result.ok && result.value.reason).toBe('working_tree_changed');
  });
  it('detects a replaced pathname before handle consumption', async () => {
    const original = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const replacement = target() + '.replacement';
      writeFileSync(replacement, readFileSync(target()));
      await fs.rename(replacement, target());
      return original(...args);
    });
    const result = await engine.documentReceipt(request, 'example');
    expect(result.ok && result.value.reason).toBe('working_tree_changed');
  });
  it('blocks local writes under a read-safe lock and checks cancellation before reads', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    const held = engine.runExclusive('fixture', async () => { entered(); await gate; });
    await started;
    const controller = new AbortController();
    const pending = engine.documentReceipt(request, 'example', controller.signal);
    controller.abort(); release(); await held;
    const result = await pending;
    expect(!result.ok && result.errors[0]?.code).toBe('REQUEST_TIMEOUT');
  });
  it('rejects a symlinked working directory', async () => {
    const linked = path.join(root, 'linked');
    await fs.symlink(path.join(root, 'clients'), linked, 'junction');
    await expect(readWorkingReceipt(root, 'linked/cli-acme.md')).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
  });
});

describe('document-content-v1 conformance', () => {
  const frontmatter = { schema: 'note.v1', doc_type: 'note', doc_id: 'n-1', extra: { z: [null, true, 2, '2'], a: 'é' } };
  it('uses fixed outer order, UTF-16 nested key order, typed arrays, and exact strings', () => {
    expect(canonicalJson({ '2': 2, '10': 10, '\uE000': 'bmp', '😀': 'pair' })).toBe('{"10":10,"2":2,"😀":"pair","":"bmp"}');
    expect(contentDigest('n-1', 'note', frontmatter, 'Hello\nworld')).toBe('b7e51ca832ac1a9946494df57efd3172879b3dff5ba25e31ecf81c1843edfe3c');
    expect(contentDigest('n-1', 'note', frontmatter, '')).toBe('46f9e3ef1f549437f099541239a4172cbec097fd1dc018e6f7d9f4b7d83877cc');
    expect(contentDigest('n-1', 'note', frontmatter, '')).not.toBe(contentDigest('n-1', 'note', frontmatter, 'Hello\nworld'));
  });
  it('conforms to the fixed LF and BOM/CRLF raw-byte vectors', () => {
    const lf = '---\ndoc_id: n-1\ndoc_type: note\nschema: note.v1\nextra:\n  z: [null, true, 2, "2"]\n  a: é\n---\n\nHello\nworld\n';
    const variants = [
      [lf, 105, '519bc953fcb54e75b160f28f69bc6a0ff27aa513fa4e87a99deafc44fc4e5942'],
      ['\uFEFF' + lf.replace(/\n/g, '\r\n') + ' \r\n', 122, '04b14d25fae9123d52044e4ae4d29e18a450f4a44b5410b1b78c2a854b93b475'],
    ] as const;
    for (const [text, size, hash] of variants) {
      const bytes = Buffer.from(text);
      expect(bytes.length).toBe(size);
      expect(rawSha256(bytes)).toBe(hash);
      const parsed = parseReceiptContent(bytes, 'n-1', 'note', 'note.v1');
      expect(parsed.rawMarkdown).toBe(text);
      expect(parsed.frontmatter).toEqual(frontmatter);
      expect(parsed.contentDigest).toBe('b7e51ca832ac1a9946494df57efd3172879b3dff5ba25e31ecf81c1843edfe3c');
    }
  });
  it('parses explicit empty body, complete typed JSON values, and duplicate rejection', () => {
    const source = '---\ndoc_id: n-1\ndoc_type: note\nschema: note.v1\nextra: [null, true, 2, "2"]\n---\n';
    expect(parseReceiptContent(Buffer.from(source), 'n-1', 'note', 'note.v1')).toMatchObject({ body: '', frontmatter: { extra: [null, true, 2, '2'] } });
    for (const invalid of [source.replace('extra:', 'doc_id: n-1\nextra:'), source.replace('extra:', 'extra: .inf\nother:'), source.replace('extra:', 'extra: &a [*a]\nother:')]) {
      expect(() => parseReceiptContent(Buffer.from(invalid), 'n-1', 'note', 'note.v1')).toThrow();
    }
    for (const value of [undefined, NaN, Infinity, new Date(), Object.create({ inherited: true }), [undefined]]) {
      expect(() => canonicalJson(value)).toThrow();
    }
  });
});
