import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { MaadEngine } from '../../src/engine.js';
import { docId } from '../../src/types.js';
import { readBlockContent, readFrontmatterSync } from '../../src/engine/helpers.js';
import { hydrateQueryRows } from '../../src/mcp/query-depth.js';

const FIXTURE = path.resolve(__dirname, '../fixtures/simple-crm');
let sandbox: string;
let project: string;
let engine: MaadEngine;

beforeEach(async () => {
  sandbox = mkdtempSync(path.join(realpathSync(tmpdir()), 'maad-read-containment-'));
  project = path.join(sandbox, 'project');
  cpSync(FIXTURE, project, { recursive: true, filter: file => !['_backend', '.git'].includes(path.basename(file)) });
  engine = new MaadEngine();
  expect((await engine.init(project)).ok).toBe(true);
  await engine.indexAll({ force: true });
});

afterEach(async () => {
  await engine.close();
  expect(path.dirname(sandbox)).toBe(realpathSync(tmpdir()));
  rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function replaceClientsWithJunction(outside: boolean): void {
  const clients = path.join(project, 'clients');
  const destination = path.join(outside ? sandbox : project, 'relocated-clients');
  renameSync(clients, destination);
  symlinkSync(destination, clients, 'junction');
}

describe('indexed document read containment', () => {
  it.each(['hot', 'warm', 'cold'] as const)('rejects %s reads after an indexed directory escapes', async depth => {
    replaceClientsWithJunction(true);
    const result = await engine.getDocument(docId('cli-acme'), depth, 'Overview');
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'PATH_OUTSIDE_PROJECT' }] });
  });

  it('guards synchronous frontmatter and direct block helpers', async () => {
    const doc = engine.getBackend().getDocument(docId('cli-acme'))!;
    replaceClientsWithJunction(true);
    expect(readFrontmatterSync(project, doc)).toBeNull();
    await expect(readBlockContent(project, doc, 1, 4, false)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_PROJECT' });
  });

  it('rejects full and verification reads, including referenced records', async () => {
    replaceClientsWithJunction(true);
    expect(await engine.getDocumentFull(docId('cli-acme'))).toMatchObject({ ok: false, errors: [{ code: 'PATH_OUTSIDE_PROJECT' }] });
    expect(await engine.verifyField(docId('cli-acme'), 'name', 'Acme Corp')).toMatchObject({ ok: false, errors: [{ code: 'PATH_OUTSIDE_PROJECT' }] });
    expect(await engine.getDocumentFull(docId('con-jane-smith'))).toMatchObject({ ok: false, errors: [{ code: 'PATH_OUTSIDE_PROJECT' }] });
  });

  it('keeps reads through internal junctions working', async () => {
    replaceClientsWithJunction(false);
    const result = await engine.getDocument(docId('cli-acme'), 'cold');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.body).toBeTruthy();
  });

  it.each(['cold', 'full'] as const)('reports containment errors during %s query hydration', async depth => {
    const query = engine.findDocuments({ docType: 'client' as never });
    expect(query.ok).toBe(true);
    if (!query.ok) return;
    replaceClientsWithJunction(true);
    const hydrated = await hydrateQueryRows(engine, query.value.results, { depth });
    expect(hydrated.rows).toHaveLength(1);
    expect(hydrated.rows[0]).toMatchObject({ _hydrationError: 'PATH_OUTSIDE_PROJECT' });
    expect(hydrated.rows[0]?.body).toBeUndefined();
    expect(hydrated.rows[0]?.composite).toBeUndefined();
  });

  it('rejects a lexical escape in an indexed path', async () => {
    const doc = engine.getBackend().getDocument(docId('cli-acme'))!;
    const outside = path.join(sandbox, 'outside.md');
    writeFileSync(outside, readFileSync(path.join(project, doc.filePath), 'utf8'));
    engine.getBackend().putDocument({ ...doc, filePath: '../outside.md' as typeof doc.filePath });
    expect(await engine.getDocument(doc.docId, 'cold')).toMatchObject({ ok: false, errors: [{ code: 'PATH_OUTSIDE_PROJECT' }] });
  });

  it('fails initialization visibly on a corrupt journal and preserves its bytes', async () => {
    await engine.close();
    const journal = path.join(project, '_backend', 'journal.json');
    writeFileSync(journal, '[{');
    engine = new MaadEngine();
    const result = await engine.init(project);
    expect(result).toMatchObject({ ok: false, errors: [{ code: 'BACKEND_ERROR' }] });
    expect(readFileSync(journal, 'utf8')).toBe('[{');
    // A repaired journal can be opened immediately; failed init released SQLite.
    writeFileSync(journal, '[]');
    expect((await engine.init(project)).ok).toBe(true);
  });
});
