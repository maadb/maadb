import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import * as schemaLoader from '../../src/schema/loader.js';
import { MaadEngine, contentDigest, canonicalJson, type GuardedCreateRequest } from '../../src/engine.js';
import type { EngineContext } from '../../src/engine/context.js';
import { docId, docType } from '../../src/types.js';
import type { HistoryRuntime } from '../../src/history/types.js';
import { GitLayer } from '../../src/git/index.js';
import { parseMatter } from '../../src/parser/matter.js';

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));

const TEMP_PARENT = realpathSync(tmpdir());
let root: string;
let engine: MaadEngine;
const registry = 'types:\n  note:\n    path: notes\n    id_prefix: nt\n    schema: note.v1\n';
const schema = 'type: note\nversion: 1\nrequired: [title]\nfields:\n  title:\n    type: string\n  tags:\n    type: list\n    item_type: string\n';
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, windowsHide: true }).toString().trim();
const schemaPath = () => path.join(root, '_schema/note.v1.yaml');
const registryPath = () => path.join(root, '_registry/object_types.yaml');
const target = () => path.join(root, 'notes/nt-one.md');
// Independent client implementation: no engine canonicalization helper used.
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  return JSON.stringify(value);
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const expected = (fields: Record<string, unknown>, body = '', id = 'nt-one') => hash(
  '{"docId":' + JSON.stringify(id) + ',"docType":"note","frontmatter":' + canonical({ ...fields, doc_id: id, doc_type: 'note', schema: 'note.v1' }) + ',"body":' + JSON.stringify(body.replace(/\r\n/g, '\n').trim()) + '}');
const snapshot = () => {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { files[path.relative(root, file) + '/'] = ''; walk(file); }
      else files[path.relative(root, file)] = hash(readFileSync(file).toString('base64'));
    }
  };
  walk(root); return files;
};
async function contract() {
  const result = await engine.createContract({ contract: 'create-contract-v1', docType: 'note' });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error('contract failed');
  expect(hash(canonical(result.value.schemaContract))).toBe(result.value.schemaDigest);
  return result.value;
}
async function request(): Promise<GuardedCreateRequest> {
  return { contract: 'guarded-create-v1', docType: 'note', docId: 'nt-one', fields: { title: 'Hello' }, body: '',
    expectedSchemaDigest: (await contract()).schemaDigest, expectedContentDigest: expected({ title: 'Hello' }), allowedHistoryModes: ['audit'] };
}
async function unchanged(req: GuardedCreateRequest, code?: string) {
  await engine.getDocument(docId('nt-missing'), 'hot');
  const before = snapshot();
  const journal = engine.health().history;
  const result = await engine.createGuarded(req);
  expect(result.ok).toBe(false);
  if (code) expect(!result.ok && result.errors[0]!.code).toBe(code);
  expect(snapshot()).toEqual(before);
  expect(engine.health().history).toEqual(journal);
  return result;
}
beforeEach(async () => {
  root = mkdtempSync(path.join(TEMP_PARENT, 'guarded-engine-'));
  mkdirSync(path.join(root, '_registry')); mkdirSync(path.join(root, '_schema'));
  writeFileSync(registryPath(), registry); writeFileSync(schemaPath(), schema);
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'noreply');
  git('config', 'core.autocrlf', 'false'); git('add', '.'); git('commit', '-m', 'Fixture');
  engine = new MaadEngine();
  expect((await engine.init(root, { semantic: false, history: { effectiveMode: 'audit', configuredMode: 'audit', modeSource: 'project', options: {}, advisories: [] } })).ok).toBe(true);
});
afterEach(async () => {
  vi.restoreAllMocks(); await engine?.close();
  const resolved = realpathSync(root);
  expect(path.dirname(resolved)).toBe(TEMP_PARENT);
  expect(path.basename(resolved)).toMatch(/^guarded-engine-/);
  rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('guarded create admission', () => {
  const preservedStores = async () => {
    await engine.getDocument(docId('nt-missing'), 'hot');
    const ctx = (engine as unknown as { ctx(): EngineContext }).ctx();
    const files = snapshot();
    const stats = ctx.backend.getStats();
    const history = engine.health().history;
    const begin = vi.spyOn(ctx.journal, 'begin');
    return () => {
      const current = (engine as unknown as { ctx(): EngineContext }).ctx();
      expect(current.registry).toBe(ctx.registry);
      expect(current.schemaStore).toBe(ctx.schemaStore);
      expect(current.backend.getStats()).toEqual(stats);
      expect(current.backend.getDocument(docId('nt-one'))).toBeFalsy();
      expect(engine.health().history).toEqual(history);
      expect(snapshot()).toEqual(files);
      expect(begin).not.toHaveBeenCalled();
    };
  };

  it('uses captured schema text for contract and preparation without an unbounded loader read', async () => {
    const req = await request();
    // An intermediate legacy read must never get a chance to consume this
    // oversized alternate schema, even if bounded rereads see the original.
    const alternate = schema.replace('type: string', 'type: string\n    max_length: 1') + '#' + 'x'.repeat(300 * 1024);
    expect(Buffer.byteLength(alternate)).toBeGreaterThan(256 * 1024);
    const original = fs.readFile;
    const read = vi.spyOn(fs, 'readFile').mockImplementation(async (...args) =>
      String(args[0]) === schemaPath() ? alternate : original(...args));
    expect((await contract()).schemaDigest).toBe(req.expectedSchemaDigest);
    const result = await engine.createGuarded(req);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(read.mock.calls.filter(args => String(args[0]) === schemaPath())).toHaveLength(0);
    expect(readFileSync(target(), 'utf8')).toBe('---\ndoc_id: nt-one\ndoc_type: note\nschema: note.v1\ntitle: Hello\n---\n');
  });

  it.each(['schema', 'total'])('rejects oversized %s capture before admission without activating stores', async kind => {
    const req = await request();
    if (kind === 'schema') writeFileSync(schemaPath(), schema + '#' + 'x'.repeat(256 * 1024));
    else {
      writeFileSync(schemaPath(), schema + '#' + 'x'.repeat(140 * 1024));
      writeFileSync(registryPath(), registry + '#' + 'x'.repeat(140 * 1024));
    }
    const preserved = await preservedStores();
    const read = vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('No unbounded reads'));
    const observed = await engine.createContract({ contract: 'create-contract-v1', docType: 'note' });
    expect(!observed.ok && observed.errors[0]!.code).toBe('RESPONSE_TOO_LARGE');
    const result = await engine.createGuarded(req);
    expect(!result.ok && result.errors[0]!.code).toBe('RESPONSE_TOO_LARGE');
    expect(read).not.toHaveBeenCalled(); preserved();
  });

  it('retains the legacy schema parser rejection for a captured BOM', async () => {
    const req = await request(); writeFileSync(schemaPath(), '\uFEFF' + schema);
    const preserved = await preservedStores();
    const observed = await engine.createContract({ contract: 'create-contract-v1', docType: 'note' });
    expect(!observed.ok && observed.errors[0]!.code).toBe('SCHEMA_INVALID');
    const result = await engine.createGuarded(req);
    expect(!result.ok && result.errors[0]!.code).toBe('SCHEMA_INVALID');
    preserved();
  });

  it.each(['oversized', 'changed'])('rejects %s dependencies on the bounded verification reread', async kind => {
    const req = await request(); const preserved = await preservedStores();
    const original = fs.open;
    let changed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (String(args[0]) === schemaPath() && !changed) {
        const close = handle.close.bind(handle);
        vi.spyOn(handle, 'close').mockImplementation(async () => {
          await close(); changed = true;
          writeFileSync(schemaPath(), kind === 'oversized' ? schema + '#' + 'x'.repeat(300 * 1024) : schema + '# changed\n');
        });
      }
      return handle;
    });
    const result = await engine.createGuarded(req);
    expect(changed).toBe(true);
    expect(!result.ok && result.errors[0]!.code).toBe(kind === 'oversized' ? 'RESPONSE_TOO_LARGE' : 'SCHEMA_CONTRACT_CHANGED');
    // Undo only the synthetic external writer's edit before comparing stores.
    writeFileSync(schemaPath(), schema); preserved();
  });

  it.each(['grow', 'cancel'])('bounds consumption and closes the schema handle on %s during capture', async action => {
    const req = await request(); const preserved = await preservedStores();
    const controller = new AbortController(); const original = fs.open;
    let consumed = false; let closed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await original(...args);
      if (String(args[0]) === schemaPath()) {
        const read = handle.read.bind(handle); const close = handle.close.bind(handle);
        handle.read = (async (...readArgs: Parameters<typeof read>) => {
          const result = await read(...readArgs);
          if (!consumed) {
            consumed = true;
            if (action === 'grow') writeFileSync(schemaPath(), schema + '#' + 'x'.repeat(300 * 1024));
            else controller.abort();
          }
          return result;
        }) as typeof handle.read;
        vi.spyOn(handle, 'close').mockImplementation(async () => { await close(); closed = true; });
      }
      return handle;
    });
    const result = await engine.createGuarded(req, { signal: controller.signal });
    expect(consumed).toBe(true); expect(closed).toBe(true);
    expect(!result.ok && result.errors[0]!.code).toBe(action === 'grow' ? 'RECEIPT_OBSERVATION_CHANGED' : 'REQUEST_TIMEOUT');
    writeFileSync(schemaPath(), schema); preserved();
  });

  it('cancels during shared snapshot validation without rereading or activating stores', async () => {
    const req = await request();
    // Exercise a cold preparation; warm cancellation is covered separately.
    expect((await engine.reload()).ok).toBe(true);
    const preserved = await preservedStores();
    const controller = new AbortController(); const original = schemaLoader.loadSchemasFromSnapshot;
    const open = vi.spyOn(fs, 'open');
    const validate = vi.spyOn(schemaLoader, 'loadSchemasFromSnapshot').mockImplementation((...args) => {
      const pending = original(...args); controller.abort(); return pending;
    });
    const result = await engine.createGuarded(req, { signal: controller.signal });
    expect(!result.ok && result.errors[0]!.code).toBe('REQUEST_TIMEOUT');
    expect(validate).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(2); // registry and schema capture only
    preserved();
  });

  it('reloads later legacy schema edits after a guarded snapshot is admitted', async () => {
    expect((await engine.createGuarded(await request())).ok).toBe(true);
    writeFileSync(schemaPath(), schema.replace('type: string', 'type: string\n    max_length: 1'));
    const result = await engine.createDocument(docType('note'), { title: 'Too long' }, '', 'nt-two');
    expect(result.ok).toBe(false);
    expect(readdirSync(path.join(root, 'notes'))).toEqual(['nt-one.md']);
  });

  it('matches an independent digest, publishes explicit empty body once, and reconciles by receipt', async () => {
    const req = await request();
    const before = snapshot(); await contract(); expect(snapshot()).toEqual(before);
    const result = await engine.createGuarded(req);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(readFileSync(target(), 'utf8')).toBe('---\ndoc_id: nt-one\ndoc_type: note\nschema: note.v1\ntitle: Hello\n---\n');
    const receipt = await engine.documentReceipt({ contract: 'document-persistence-v1', docType: 'note', docId: 'nt-one', expectedContentDigest: req.expectedContentDigest }, 'example');
    expect(receipt.ok && receipt.value.expectedDigestMatch).toBe(true);
    await unchanged(req, 'DUPLICATE_DOC_ID');
  });
  it.each<{ name: string; fields: GuardedCreateRequest['fields']; lines: string[] }>([
    {
      name: 'comma extra',
      fields: { title: 'Hello', extra: ['a,b'] },
      lines: ['extra: ["a,b"]'],
    },
    {
      name: 'punctuation paths',
      fields: {
        title: 'Hello',
        tags: ['src/routes/[itemId]/route.ts', 'src/a,b.ts'],
        extra: ['a,b'],
        scope_paths: ['src/routes/[itemId]/route.ts', 'src/a,b.ts', 'src/{draft}/route.ts'],
      },
      lines: [
        'tags: ["src/routes/[itemId]/route.ts", "src/a,b.ts"]',
        'extra: ["a,b"]',
        'scope_paths: ["src/routes/[itemId]/route.ts", "src/a,b.ts", "src/{draft}/route.ts"]',
      ],
    },
  ])('preserves $name through guarded create, reindex, reopen, and receipts', async ({ fields, lines }) => {
    const body = '# Flow strings\n\nKeep each path intact.';
    const req = { ...await request(), fields, body, expectedContentDigest: expected(fields, body) };
    const frontmatter = { ...fields, doc_id: 'nt-one', doc_type: 'note', schema: 'note.v1' };
    const raw = ['---', 'doc_id: nt-one', 'doc_type: note', 'schema: note.v1', 'title: Hello',
      ...lines, '---', '', body, ''].join('\n');
    const result = await engine.createGuarded(req);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    expect(result.value.contentDigest).toBe(req.expectedContentDigest);
    expect(result.value.schemaDigest).toBe(req.expectedSchemaDigest);
    expect(result.value.writeDurable).toBe(true);

    const verify = async () => {
      expect(readFileSync(target(), 'utf8')).toBe(raw);
      expect(parseMatter(raw).data).toStrictEqual(frontmatter);
      const cold = await engine.getDocument(docId('nt-one'), 'cold');
      expect(cold.ok).toBe(true);
      if (!cold.ok) throw new Error(JSON.stringify(cold.errors));
      expect(cold.value.frontmatter).toStrictEqual(frontmatter);
      expect(cold.value.body).toBe(body);
      const receipt = await engine.documentReceipt({ contract: 'document-persistence-v1', docType: 'note',
        docId: 'nt-one', expectedContentDigest: req.expectedContentDigest }, 'example');
      expect(receipt.ok, JSON.stringify(receipt)).toBe(true);
      if (!receipt.ok) throw new Error(JSON.stringify(receipt.errors));
      expect(receipt.value.status).toBe('committed_content_available');
      expect(receipt.value.expectedDigestMatch).toBe(true);
      expect(receipt.value.workingTree).toStrictEqual({ state: 'matches_committed',
        rawSha256: hash(raw), contentDigest: req.expectedContentDigest });
      expect(receipt.value.committed?.rawMarkdown).toBe(raw);
      expect(receipt.value.committed?.rawSha256).toBe(hash(raw));
      expect(receipt.value.committed?.frontmatter).toStrictEqual(frontmatter);
      expect(receipt.value.committed?.body).toBe(body);
      expect(receipt.value.committed?.contentDigest).toBe(req.expectedContentDigest);
    };
    await verify();
    const reindexed = await engine.reindex({ docId: docId('nt-one'), force: true });
    expect(reindexed.ok).toBe(true);
    if (!reindexed.ok) throw new Error(JSON.stringify(reindexed.errors));
    expect(reindexed.value.errors).toStrictEqual([]);
    expect(reindexed.value.indexed).toBe(1);
    await verify();
    await engine.close();
    engine = new MaadEngine();
    expect((await engine.init(root, { semantic: false, history: { effectiveMode: 'audit', configuredMode: 'audit', modeSource: 'project', options: {}, advisories: [] } })).ok).toBe(true);
    expect(await engine.indexAll({ force: true })).toMatchObject({ errors: [] });
    await verify();
  });

  it('rejects the original digest after adding a lossless comma item', async () => {
    const req = await request();
    // This deliberately retains the old digest; the positive cases recompute it.
    await unchanged({ ...req, fields: { ...req.fields, extra: ['a,b'] } }, 'CONTENT_DIGEST_MISMATCH');
  });

  it('retains legacy auto IDs and template defaults, while guarded empty body is explicit', async () => {
    writeFileSync(schemaPath(), schema + 'template:\n  headings:\n    - level: 1\n      text: Generated\n');
    const req = await request();
    expect((await engine.createGuarded(req)).ok).toBe(true);
    expect(readFileSync(target(), 'utf8')).not.toContain('Generated');
    const legacy = await engine.createDocument(docType('note'), { title: 'Legacy' });
    expect(legacy.ok).toBe(true);
    if (legacy.ok) expect(readFileSync(path.join(root, legacy.value.filePath), 'utf8')).toContain('# Generated');
  });
  it.each([
    ['required', schema.replace('[title]', '[title, tags]')],
    ['constraint', schema.replace('type: string', 'type: string\n    max_length: 20')],
    ['default', schema.replace('type: string', 'type: string\n    default: fallback')],
    ['type', schema.replace('type: string', 'type: number')],
    ['precision', schema + '  observed:\n    type: date\n    store_precision: second\n'],
    ['template', schema + 'template:\n  headings:\n    - level: 1\n      text: Content\n'],
    ['reference', schema + '  parent:\n    type: ref\n    target: note\n'],
  ])('rejects same-version %s changes before effects', async (_name, changed) => {
    const req = await request(); writeFileSync(schemaPath(), changed);
    await unchanged(req, 'SCHEMA_CONTRACT_CHANGED');
    expect((await contract()).schemaDigest).not.toBe(req.expectedSchemaDigest);
  });
  it.each(['mapping', 'schemaRef', 'extraction', 'prefix', 'externalTemplate'])('covers registry %s dependencies without mkdir', async kind => {
    const req = await request();
    let changed = registry;
    if (kind === 'mapping') changed = registry.replace('path: notes', 'path: new-notes');
    if (kind === 'schemaRef') { writeFileSync(path.join(root, '_schema/note.v2.yaml'), schema); changed = registry.replace('note.v1', 'note.v2'); }
    if (kind === 'prefix') changed = registry.replace('id_prefix: nt', 'id_prefix: new');
    if (kind === 'extraction') changed += 'extraction:\n  subtypes:\n    marker: entity\n';
    if (kind === 'externalTemplate') { writeFileSync(path.join(root, 'template.md'), '# Example'); changed += '    template: template.md\n'; }
    writeFileSync(registryPath(), changed); await unchanged(req, 'SCHEMA_CONTRACT_CHANGED');
  });
  it('detects equal-size schema edits with restored mtime', async () => {
    const req = await request(); const st = statSync(schemaPath());
    writeFileSync(schemaPath(), schema.replace('type: string', 'type: number')); utimesSync(schemaPath(), st.atime, st.mtime);
    expect(statSync(schemaPath()).size).toBe(st.size);
    await unchanged(req);
  });
  it.each(['deleted', 'invalid', 'unreadable', 'registryDeleted'])('fails closed for %s dependencies', async kind => {
    const req = await request();
    if (kind === 'deleted') unlinkSync(schemaPath());
    if (kind === 'registryDeleted') unlinkSync(registryPath());
    if (kind === 'invalid') writeFileSync(schemaPath(), 'type: [');
    if (kind === 'unreadable') { unlinkSync(schemaPath()); mkdirSync(schemaPath()); }
    await unchanged(req);
  });
  it.each(['snapshot', 'feed', 'read', 'batch'] as const)('rejects audit to %s history drift while queued', async mode => {
    const req = await request();
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    const held = engine.runGuardedExclusive(async () => { entered(); await gate; }); await started;
    const before = snapshot(); const pending = engine.createGuarded(req);
    (engine as unknown as { historyRuntime: HistoryRuntime }).historyRuntime.config.effectiveMode = mode;
    release(); await held;
    const result = await pending; expect(result.ok).toBe(false);
    expect(!result.ok && result.errors[0]!.code).toBe(mode === 'read' ? 'READ_ONLY' : 'HISTORY_MODE_MISMATCH');
    expect(snapshot()).toEqual(before);
  });
  it.each([
    { expectedContentDigest: '0'.repeat(64) }, { fields: { title: 2 } },
    { fields: { title: 'Changed' } }, { fields: { title: 'Hello', tags: ['changed'] } },
    { fields: { title: 'Hello', doc_id: 'nt-forged' } },
    { fields: { title: 'Hello', extra: { nested: true } } },
    { fields: { title: 'Hello', extra: ['a,b'] } }, { fields: {} },
  ])('rejects mismatches and serialization loss %# with unchanged stores', async override => {
    await unchanged({ ...await request(), ...override } as GuardedCreateRequest);
  });
  it('rejects digest over omitted identity and excessive content', async () => {
    const req = await request();
    await unchanged({ ...req, expectedContentDigest: hash(canonical(req.fields)) }, 'CONTENT_DIGEST_MISMATCH');
    await unchanged({ ...req, body: 'x'.repeat(256 * 1024) }, 'RESPONSE_TOO_LARGE');
  });
  it('excludes non-JSON values, accessors and unknown arguments for direct engine callers', async () => {
    const req = await request();
    for (const value of [NaN, Infinity, undefined, new Date(), 1n, new Map(), () => 1]) {
      await unchanged({ ...req, fields: { title: 'Hello', extra: value } } as unknown as GuardedCreateRequest, 'INVALID_FIELDS');
    }
    const accessor = Object.defineProperty([], '0', { enumerable: true, get: () => { throw new Error('must not execute'); } });
    await unchanged({ ...req, fields: { title: 'Hello', extra: accessor } }, 'INVALID_FIELDS');
    await unchanged({ ...req, authority: 'admin' } as GuardedCreateRequest, 'INVALID_FIELDS');
  });
  it('exclusively creates once under concurrency and refuses unindexed on-disk IDs', async () => {
    const req = await request();
    const both = await Promise.all([engine.createGuarded(req), engine.createGuarded(req)]);
    expect(both.filter(r => r.ok)).toHaveLength(1);
    const orphan = { ...req, docId: 'nt-orphan', expectedContentDigest: expected(req.fields, '', 'nt-orphan') };
    writeFileSync(path.join(root, 'notes/nt-orphan.md'), 'keep these bytes');
    await unchanged(orphan, 'DUPLICATE_DOC_ID');
  });
  it('cancels queued work and rechecks access after schema awaits', async () => {
    const req = await request(); await engine.getDocument(docId('nt-missing'), 'hot'); const before = snapshot(); const abort = new AbortController();
    let release!: () => void;
    const held = engine.runGuardedExclusive(() => new Promise<void>(r => { release = r; }));
    await Promise.resolve(); await Promise.resolve();
    const pending = engine.createGuarded(req, { signal: abort.signal });
    abort.abort(); release(); await held;
    expect((await pending).ok).toBe(false);
    let calls = 0;
    const denied = await engine.createGuarded(req, { validateAccess: () => ++calls > 1 ? { code: 'TOKEN_REVOKED', message: 'Revoked' } : null });
    expect(!denied.ok && denied.errors[0]!.code).toBe('TOKEN_REVOKED');
    expect(snapshot()).toEqual(before);
  });
  it('preserves commit failure uncertainty without claiming persistence or retrying', async () => {
    const req = await request();
    const commit = vi.spyOn(GitLayer.prototype, 'commit').mockResolvedValue({ status: 'failed', code: 'GIT_ERROR', message: 'Synthetic failure' });
    const result = await engine.createGuarded(req);
    expect(result.ok && result.value.writeDurable).toBe(false);
    expect(result.ok && result.value.commitFailure).toBeTruthy(); expect(commit).toHaveBeenCalledTimes(1);
    expect(readFileSync(target(), 'utf8')).toContain('title: Hello');
  });
  it('implements fixed canonicalization conformance vectors', () => {
    expect(canonicalJson({ '2': 'b', '10': 'a', z: [true, null, '007'], a: -0 })).toBe('{"10":"a","2":"b","a":0,"z":[true,null,"007"]}');
    const fm = { doc_id: 'nt-one', doc_type: 'note', schema: 'note.v1', title: 'Hello' };
    expect(contentDigest('nt-one', 'note', fm, '')).toBe('a680267ffb809101d5d97c16b5fc62b432693e5013079d733922a5ebf066b63d');
    expect(expected({ title: 'Hello' })).toBe('a680267ffb809101d5d97c16b5fc62b432693e5013079d733922a5ebf066b63d');
  });
});


describe('content-keyed preparation reuse', () => {
  it('compiles once across setup, repeated observation and both guarded-write checks', async () => {
    const compile = vi.spyOn(schemaLoader, 'loadSchemasFromSnapshot');
    const req = await request();
    const observed = await contract();
    expect(compile).toHaveBeenCalledTimes(1);
    // Mutating a returned contract cannot poison cached validation.
    observed.schemaContract = null;
    expect((await engine.createGuarded(req)).ok).toBe(true);
    expect(compile).toHaveBeenCalledTimes(1);
  });
  it('discards preparation on reload and checks cancellation on a warm cache', async () => {
    const req = await request();
    const controller = new AbortController(); controller.abort();
    const denied = await engine.createGuarded(req, { signal: controller.signal });
    expect(!denied.ok && denied.errors[0]!.code).toBe('REQUEST_TIMEOUT');
    expect((await engine.reload()).ok).toBe(true);
    const compile = vi.spyOn(schemaLoader, 'loadSchemasFromSnapshot');
    await contract();
    expect(compile).toHaveBeenCalledTimes(1);
  });
});
