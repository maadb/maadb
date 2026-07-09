// ============================================================================
// 0.8.1 — index-integrity pass regression coverage.
//
// The indexAll stale-row sweep previously pruned any index row whose file
// wasn't seen during the scan — and the scan only walks registered type
// paths, so a registry path mismatch (kebab vs underscore dir) silently
// deleted every affected doc's index row on ANY reindex. Related silent
// failure modes fixed in the same pass: docId collisions resolved by
// INSERT OR REPLACE (last-scanned file silently destroyed the other row),
// schema fingerprints persisting past per-doc index errors (failed forced
// rebuilds lost forever), over-cap/annotation-capped docs with no queryable
// partial state, and list-of-number items indexing numericValue null.
// ============================================================================

import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docId, docType } from '../../src/types.js';
import { computeNumericValue } from '../../src/engine/helpers.js';

const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-index-integrity');

const REGISTRY_OK = 'types:\n  note:\n    path: notes/\n    id_prefix: note\n    schema: note.v1\n';
// The incident shape: registry maps the type to a directory that does not
// exist while the docs live in a sibling dir.
const REGISTRY_MISMATCH = 'types:\n  note:\n    path: nots/\n    id_prefix: note\n    schema: note.v1\n';

function noteMd(id: string, title: string, extra = '', body = 'body\n'): string {
  return `---\ndoc_id: ${id}\ndoc_type: note\nschema: note.v1\ntitle: ${title}\n${extra}---\n\n${body}`;
}

function writeProject(opts?: { registry?: string; schemaExtra?: string }): void {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  mkdirSync(path.join(TEMP_ROOT, '_registry'), { recursive: true });
  mkdirSync(path.join(TEMP_ROOT, '_schema'), { recursive: true });
  mkdirSync(path.join(TEMP_ROOT, 'notes'), { recursive: true });

  writeFileSync(path.join(TEMP_ROOT, '_registry', 'object_types.yaml'), opts?.registry ?? REGISTRY_OK, 'utf-8');
  writeFileSync(
    path.join(TEMP_ROOT, '_schema', 'note.v1.yaml'),
    'type: note\nversion: 1\nrequired:\n  - doc_id\n  - title\nfields:\n  title:\n    type: string\n    index: true\n' +
    (opts?.schemaExtra ?? ''),
    'utf-8',
  );

  writeFileSync(path.join(TEMP_ROOT, 'notes', 'note-one.md'), noteMd('note-one', 'first'), 'utf-8');
  writeFileSync(path.join(TEMP_ROOT, 'notes', 'note-two.md'), noteMd('note-two', 'second'), 'utf-8');
}

// Engines register here and close in afterEach even when an assertion throws
// mid-test — a leaked open SQLite handle makes the next test's rmSync EPERM
// on Windows.
const openEngines: MaadEngine[] = [];

async function freshEngine(): Promise<MaadEngine> {
  const engine = new MaadEngine();
  openEngines.push(engine);
  expect((await engine.init(TEMP_ROOT)).ok).toBe(true);
  return engine;
}

const ENV_KEYS = ['MAAD_MAX_DOC_BYTES', 'MAAD_MAX_DOC_ANNOTATIONS', 'MAAD_BOOT_REINDEX'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const engine of openEngines.splice(0)) {
    try {
      engine.close();
    } catch {
      // already closed by the test body — fine
    }
  }
});

afterAll(() => {
  try {
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    // Windows handle release race — non-fatal
  }
});

describe('stale-row sweep guard', () => {
  it('registry path mismatch: rows are KEPT and warned about, never pruned', async () => {
    writeProject();
    let engine = await freshEngine();
    expect((await engine.indexAll({ force: true })).indexed).toBe(2);
    engine.close();

    // Re-point the registry at a nonexistent dir — the registry-mismatch incident shape.
    writeFileSync(path.join(TEMP_ROOT, '_registry', 'object_types.yaml'), REGISTRY_MISMATCH, 'utf-8');
    engine = await freshEngine();
    const result = await engine.indexAll({ force: true });

    // Pre-0.8.1: both rows were silently deleted as "orphans". Now: kept.
    expect(result.pruned ?? 0).toBe(0);
    expect(result.warnings).toBeDefined();
    // Both warning shapes fire: the registered dir scanned empty while the
    // index holds rows (the registry loader creates the missing dir at load,
    // so the mismatch presents as an empty dir), and kept-not-pruned rows
    // whose files exist outside the scan.
    expect(result.warnings!.some(w => w.includes('contains no markdown files'))).toBe(true);
    expect(result.warnings!.some(w => w.includes('not pruned'))).toBe(true);
    // The docs are still queryable.
    expect((await engine.getDocument(docId('note-one'), 'hot')).ok).toBe(true);
    expect((await engine.getDocument(docId('note-two'), 'hot')).ok).toBe(true);
    engine.close();
  });

  it('genuinely deleted file: row is pruned and counted, no warnings', async () => {
    writeProject();
    const engine = await freshEngine();
    expect((await engine.indexAll({ force: true })).indexed).toBe(2);

    unlinkSync(path.join(TEMP_ROOT, 'notes', 'note-two.md'));
    const result = await engine.indexAll();

    expect(result.pruned).toBe(1);
    expect(result.warnings).toBeUndefined();
    expect((await engine.getDocument(docId('note-two'), 'hot')).ok).toBe(false);
    expect((await engine.getDocument(docId('note-one'), 'hot')).ok).toBe(true);
    engine.close();
  });
});

describe('docId collision guard on the index path', () => {
  it('two live files sharing a doc_id: DUPLICATE_DOC_ID error, first row intact', async () => {
    writeProject();
    // Scan order is alphabetical: note-one.md indexes first, note-zzz.md
    // (same doc_id) must error instead of silently replacing it.
    writeFileSync(path.join(TEMP_ROOT, 'notes', 'note-zzz.md'), noteMd('note-one', 'impostor'), 'utf-8');

    const engine = await freshEngine();
    const result = await engine.indexAll({ force: true });

    const dup = result.errors.filter(e => e.code === 'DUPLICATE_DOC_ID');
    expect(dup.length).toBe(1);
    // The winner is the first-scanned file — pre-0.8.1 the LAST file won by
    // silent REPLACE and which one that was depended on iteration order.
    const got = await engine.getDocument(docId('note-one'), 'hot');
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.frontmatter['title']).toBe('first');
    engine.close();
  });

  it('doc_id renamed in place: superseded row removed, new row live, no error', async () => {
    writeProject();
    const engine = await freshEngine();
    expect((await engine.indexAll({ force: true })).indexed).toBe(2);

    writeFileSync(path.join(TEMP_ROOT, 'notes', 'note-one.md'), noteMd('note-renamed', 'first'), 'utf-8');
    const result = await engine.indexAll();

    expect(result.errors).toHaveLength(0);
    expect((await engine.getDocument(docId('note-renamed'), 'hot')).ok).toBe(true);
    expect((await engine.getDocument(docId('note-one'), 'hot')).ok).toBe(false);
    engine.close();
  });
});

describe('schema-fingerprint persistence gating', () => {
  it('a type with per-doc index errors stays dirty and retries next pass', async () => {
    writeProject();
    let engine = await freshEngine();
    expect((await engine.indexAll({ force: true })).indexed).toBe(2);

    // Mark the type dirty (simulates an indexed-field schema change), then
    // break one doc so the forced rebuild partially fails.
    const FP_KEY = 'schema_index_fp:note';
    engine.getBackend().setMeta(FP_KEY, 'stale-fingerprint');
    writeFileSync(path.join(TEMP_ROOT, 'notes', 'note-two.md'), '---\nbroken: [yaml\n---\nbody\n', 'utf-8');

    let result = await engine.indexAll();
    expect(result.rebuiltTypes).toContain('note');
    expect(result.errors.length).toBeGreaterThan(0);
    // Pre-0.8.1 the fingerprint persisted here anyway, so the failed doc
    // would hash-skip forever once fixed rows matched. Now it stays stale.
    expect(engine.getBackend().getMeta(FP_KEY)).toBe('stale-fingerprint');

    // Fix the doc: the type is STILL dirty, rebuilds, and the fingerprint
    // finally persists.
    writeFileSync(path.join(TEMP_ROOT, 'notes', 'note-two.md'), noteMd('note-two', 'second'), 'utf-8');
    result = await engine.indexAll();
    expect(result.rebuiltTypes).toContain('note');
    expect(result.errors).toHaveLength(0);
    expect(engine.getBackend().getMeta(FP_KEY)).not.toBe('stale-fingerprint');
    engine.close();
  });
});

describe('persisted partial/stale state', () => {
  it('a doc that grows past MAAD_MAX_DOC_BYTES keeps its row, flagged partial', async () => {
    writeProject();
    process.env.MAAD_MAX_DOC_BYTES = '600';
    const engine = await freshEngine();
    expect((await engine.indexAll({ force: true })).indexed).toBe(2);
    expect(engine.summary().warnings.partialDocs).toBe(0);

    // Grow note-one past the cap.
    writeFileSync(path.join(TEMP_ROOT, 'notes', 'note-one.md'), noteMd('note-one', 'first', '', 'x'.repeat(2000)), 'utf-8');
    const result = await engine.indexAll();

    expect(result.errors.some(e => e.code === 'DOC_TOO_LARGE')).toBe(true);
    // The row is retained at its last indexed content and now queryably stale.
    const got = await engine.getDocument(docId('note-one'), 'hot');
    expect(got.ok).toBe(true);
    expect(engine.summary().warnings.partialDocs).toBe(1);

    // Shrink it back: the next index clears the flag.
    writeFileSync(path.join(TEMP_ROOT, 'notes', 'note-one.md'), noteMd('note-one', 'first'), 'utf-8');
    expect((await engine.indexAll()).errors).toHaveLength(0);
    expect(engine.summary().warnings.partialDocs).toBe(0);
    engine.close();
  });

  it('annotation-capped docs persist partial=true and clear on a clean pass', async () => {
    writeProject();
    const annos = Array.from({ length: 8 }, (_, i) => `Ref [[entity:Thing ${i}|t${i}]].`).join('\n');
    writeFileSync(path.join(TEMP_ROOT, 'notes', 'note-anno.md'), noteMd('note-anno', 'annotated', '', `${annos}\n`), 'utf-8');

    process.env.MAAD_MAX_DOC_ANNOTATIONS = '3';
    let engine = await freshEngine();
    let result = await engine.indexAll({ force: true });
    expect(result.partial).toBe(1);
    expect(engine.summary().warnings.partialDocs).toBe(1);
    engine.close();

    // Raise the cap: the forced rebuild indexes the full body and clears it.
    process.env.MAAD_MAX_DOC_ANNOTATIONS = '0';
    engine = await freshEngine();
    result = await engine.indexAll({ force: true });
    expect(result.partial ?? 0).toBe(0);
    expect(engine.summary().warnings.partialDocs).toBe(0);
    engine.close();
  });
});

describe('numeric indexing fixes', () => {
  it('list-of-number items match numeric range filters', async () => {
    writeProject({ schemaExtra: '  scores:\n    type: list\n    item_type: number\n    index: true\n' });
    writeFileSync(
      path.join(TEMP_ROOT, 'notes', 'note-scored.md'),
      noteMd('note-scored', 'scored', 'scores:\n  - 10\n  - 2\n  - 9\n'),
      'utf-8',
    );

    const engine = await freshEngine();
    expect((await engine.indexAll({ force: true })).errors).toHaveLength(0);

    // Pre-0.8.1 list items indexed numericValue null — numeric range filters
    // never matched (and text compare would order "10" < "9" anyway).
    const hit = await engine.findDocuments({ docType: docType('note'), filters: { scores: { op: 'gte', value: 10 } } });
    expect(hit.ok).toBe(true);
    if (hit.ok) expect(hit.value.results.map(r => r.docId as string)).toContain('note-scored');

    const miss = await engine.findDocuments({ docType: docType('note'), filters: { scores: { op: 'gt', value: 10 } } });
    expect(miss.ok).toBe(true);
    if (miss.ok) expect(miss.value.results).toHaveLength(0);
    engine.close();
  });

  it('amount values tolerate currency markers', () => {
    expect(computeNumericValue('$100', 'amount')).toBe(100);
    expect(computeNumericValue('€ 1,500', 'amount')).toBe(1500);
    expect(computeNumericValue('USD 25.50', 'amount')).toBe(25.5);
    expect(computeNumericValue('100', 'amount')).toBe(100);
    expect(computeNumericValue('1,234.56', 'amount')).toBe(1234.56);
    expect(computeNumericValue('n/a', 'amount')).toBeNull();
  });
});

// ============================================================================
// 0.8.4 — boot false-empty index guard.
//
// A persisted index reporting zero documents while registered paths hold
// markdown on disk is the "derived index was lost" shape (fresh clone,
// volume-restore, wiped _backend), NOT a genuinely empty project. The serving
// paths (project pool + single-project startup) pass guardEmptyIndex:true so
// the engine refuses to serve [] over real data; the CLI/test bootstrap path
// (init → reindex) leaves it unset and is unaffected.
// ============================================================================
describe('boot false-empty index guard (0.8.4)', () => {
  function newServingEngine(): MaadEngine {
    const engine = new MaadEngine();
    openEngines.push(engine);
    return engine;
  }

  it('serving init refuses (INDEX_EMPTY) when the index is empty but markdown exists', async () => {
    writeProject();
    const engine = newServingEngine();
    const r = await engine.init(TEMP_ROOT, { guardEmptyIndex: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].code).toBe('INDEX_EMPTY');
      // The count of on-disk markdown is surfaced so it's clear the data is
      // present and the index — not the data — is what's missing.
      expect(r.errors[0].details?.onDiskMarkdownFiles).toBe(2);
      expect(r.errors[0].message).toContain('maad reindex');
    }
  });

  it('read-only serving init refuses and points at reindex (cannot self-heal)', async () => {
    writeProject();
    // _backend/ exists (restored) but holds no populated db — the empty-index
    // sub-case the earlier missing-_backend read-only guard does not cover.
    mkdirSync(path.join(TEMP_ROOT, '_backend'), { recursive: true });
    const engine = newServingEngine();
    const r = await engine.init(TEMP_ROOT, { guardEmptyIndex: true, readOnly: true });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0].code).toBe('INDEX_EMPTY');
      expect(r.errors[0].message).toContain('read-only');
    }
  });

  it('MAAD_BOOT_REINDEX=1 rebuilds the index at boot and serves the docs', async () => {
    writeProject();
    process.env.MAAD_BOOT_REINDEX = '1';
    const engine = newServingEngine();
    const r = await engine.init(TEMP_ROOT, { guardEmptyIndex: true });
    expect(r.ok).toBe(true);
    expect(engine.health().totalDocuments).toBe(2);
    expect((await engine.getDocument(docId('note-one'), 'hot')).ok).toBe(true);
    expect((await engine.getDocument(docId('note-two'), 'hot')).ok).toBe(true);
  });

  it('a genuinely empty project (types registered, no markdown) serves fine — architect mode', async () => {
    writeProject();
    unlinkSync(path.join(TEMP_ROOT, 'notes', 'note-one.md'));
    unlinkSync(path.join(TEMP_ROOT, 'notes', 'note-two.md'));
    const engine = newServingEngine();
    const r = await engine.init(TEMP_ROOT, { guardEmptyIndex: true });
    expect(r.ok).toBe(true);
    expect(engine.health().totalDocuments).toBe(0);
  });

  it('the guard is opt-in: init without it keeps the CLI/test bootstrap (init → reindex)', async () => {
    writeProject();
    const engine = newServingEngine();
    const r = await engine.init(TEMP_ROOT);
    expect(r.ok).toBe(true);
    expect(engine.health().totalDocuments).toBe(0);
    expect((await engine.indexAll({ force: true })).indexed).toBe(2);
  });

  it('a populated index passes the guard untouched', async () => {
    writeProject();
    let engine = newServingEngine();
    expect((await engine.init(TEMP_ROOT)).ok).toBe(true);
    expect((await engine.indexAll({ force: true })).indexed).toBe(2);
    engine.close();

    engine = newServingEngine();
    const r = await engine.init(TEMP_ROOT, { guardEmptyIndex: true });
    expect(r.ok).toBe(true);
    expect(engine.health().totalDocuments).toBe(2);
  });
});
