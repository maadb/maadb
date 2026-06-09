// ============================================================================
// 0.7.13 — per-doc index-time memory guards.
//
// A single document can allocate far beyond its byte size in V8 heap while
// indexing (body annotations → objects → relationships, all live with the
// SQLite bind params). Unbounded, one pathological doc FATALs the whole engine
// process and crash-loops on restart as reindex re-touches it. Two layered
// guards keep the document FINDABLE instead of silently dropping it:
//
//   - Annotation cap (MAAD_MAX_DOC_ANNOTATIONS): body extraction stops at the
//     cap; the record + frontmatter still index in full (partial body). The
//     doc stays queryable by id and frontmatter. Counted in IndexResult.partial.
//   - Byte backstop (MAAD_MAX_DOC_BYTES): a file too large to even read safely
//     is skipped entirely with DOC_TOO_LARGE (lands in errors[], indexes none).
// ============================================================================

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import path from 'node:path';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { MaadEngine } from '../../src/engine.js';
import { docId } from '../../src/types.js';

const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-doc-size-guard');
const SMALL_ID = 'note-small';
const ANNOTATED_ID = 'note-annotated';
const BIG_ID = 'note-big';

function writeProject(): void {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true });
  mkdirSync(path.join(TEMP_ROOT, '_registry'), { recursive: true });
  mkdirSync(path.join(TEMP_ROOT, '_schema'), { recursive: true });
  mkdirSync(path.join(TEMP_ROOT, 'notes'), { recursive: true });

  writeFileSync(
    path.join(TEMP_ROOT, '_registry', 'object_types.yaml'),
    'types:\n  note:\n    path: notes/\n    id_prefix: note\n    schema: note.v1\n',
    'utf-8',
  );
  writeFileSync(
    path.join(TEMP_ROOT, '_schema', 'note.v1.yaml'),
    'type: note\nversion: 1\nrequired:\n  - doc_id\n  - title\nfields:\n  title:\n    type: string\n    index: true\n',
    'utf-8',
  );

  writeFileSync(
    path.join(TEMP_ROOT, 'notes', `${SMALL_ID}.md`),
    `---\ndoc_id: ${SMALL_ID}\ndoc_type: note\nschema: note.v1\ntitle: small\n---\n\nshort body\n`,
    'utf-8',
  );

  // Doc with several body annotations — drives the annotation-cap partial path.
  const annos = Array.from({ length: 8 }, (_, i) => `Ref [[entity:Thing ${i}|t${i}]].`).join('\n');
  writeFileSync(
    path.join(TEMP_ROOT, 'notes', `${ANNOTATED_ID}.md`),
    `---\ndoc_id: ${ANNOTATED_ID}\ndoc_type: note\nschema: note.v1\ntitle: annotated\n---\n\n${annos}\n`,
    'utf-8',
  );

  // Big doc — for the byte backstop. ~4 KB of body.
  writeFileSync(
    path.join(TEMP_ROOT, 'notes', `${BIG_ID}.md`),
    `---\ndoc_id: ${BIG_ID}\ndoc_type: note\nschema: note.v1\ntitle: big\n---\n\n${'x'.repeat(4000)}\n`,
    'utf-8',
  );
}

const ENV_KEYS = ['MAAD_MAX_DOC_BYTES', 'MAAD_MAX_DOC_ANNOTATIONS'] as const;
let saved: Record<string, string | undefined> = {};

beforeAll(() => {
  saved = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  writeProject();
});

beforeEach(() => {
  // Each scenario indexes the same files under a different cap config, so the
  // backend must start empty — otherwise a doc indexed by a prior test (e.g.
  // under a disabled cap) would leave a row that a later skip can't reconcile.
  const backend = path.join(TEMP_ROOT, '_backend');
  if (existsSync(backend)) rmSync(backend, { recursive: true, force: true });
});

afterEach(() => {
  // Restore env after each test so per-test overrides don't leak.
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterAll(() => {
  try {
    if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true });
  } catch {
    // Windows handle release race — non-fatal
  }
});

describe('indexAll — per-doc memory guards', () => {
  it('annotation cap: oversized-body doc is PARTIALLY indexed, not dropped', async () => {
    process.env.MAAD_MAX_DOC_BYTES = '0';        // disable byte backstop
    process.env.MAAD_MAX_DOC_ANNOTATIONS = '3';  // annotated doc has 8

    const engine = new MaadEngine();
    expect((await engine.init(TEMP_ROOT)).ok).toBe(true);
    const result = await engine.indexAll({ force: true });

    // Every doc indexed — nothing skipped to errors[].
    expect(result.indexed).toBe(3);
    expect(result.errors.length).toBe(0);
    // The annotated doc is flagged partial.
    expect(result.partial).toBe(1);

    // Crucially, the partially-indexed doc is still findable + frontmatter intact.
    const got = await engine.getDocument(docId(ANNOTATED_ID), 'hot');
    expect(got.ok).toBe(true);
    engine.close();
  });

  it('byte backstop: a file over the read cap is skipped with DOC_TOO_LARGE', async () => {
    process.env.MAAD_MAX_DOC_BYTES = '800';        // big doc (~4 KB) exceeds this
    process.env.MAAD_MAX_DOC_ANNOTATIONS = '0';    // isolate the byte path

    const engine = new MaadEngine();
    expect((await engine.init(TEMP_ROOT)).ok).toBe(true);
    const result = await engine.indexAll({ force: true });

    const tooLarge = result.errors.filter(e => e.code === 'DOC_TOO_LARGE');
    expect(tooLarge.length).toBe(1);
    expect(tooLarge[0]!.details).toMatchObject({ capBytes: 800 });
    // The big doc has no index row; the others are fine.
    expect((await engine.getDocument(docId(BIG_ID), 'hot')).ok).toBe(false);
    expect((await engine.getDocument(docId(SMALL_ID), 'hot')).ok).toBe(true);
    engine.close();
  });

  it('guards disabled (both 0): every doc fully indexed, none partial', async () => {
    process.env.MAAD_MAX_DOC_BYTES = '0';
    process.env.MAAD_MAX_DOC_ANNOTATIONS = '0';

    const engine = new MaadEngine();
    expect((await engine.init(TEMP_ROOT)).ok).toBe(true);
    const result = await engine.indexAll({ force: true });

    expect(result.indexed).toBe(3);
    expect(result.errors.length).toBe(0);
    expect(result.partial ?? 0).toBe(0);
    engine.close();
  });
});
