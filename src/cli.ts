#!/usr/bin/env node
// ============================================================================
// MAAD CLI
// Human-facing interface wrapping the engine.
// Usage: maad <command> [options]
// ============================================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { MaadEngine } from './engine.js';
import { GitLayer } from './git/index.js';
import { docId, docType } from './types.js';
import { generateMaadMd, generateStubMaadMd } from './maad-md.js';
import { generateSchemaMd } from './schema-md.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse --project flag out of args before command dispatch
const rawArgs = process.argv.slice(2);
let projectRoot = '.';
const args: string[] = [];

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--project' && rawArgs[i + 1]) {
    projectRoot = rawArgs[i + 1]!;
    i++; // skip next
  } else {
    args.push(rawArgs[i]!);
  }
}

const command = args[0];

async function main(): Promise<void> {
  switch (command) {
    case 'init':
      await cmdInit();
      break;
    case 'parse':
      await cmdParse();
      break;
    case 'validate':
      await cmdValidate();
      break;
    case 'reindex':
      await cmdReindex();
      break;
    case 'query':
      await cmdQuery();
      break;
    case 'describe':
      await cmdDescribe();
      break;
    case 'get':
      await cmdGet();
      break;
    case 'search':
      await cmdSearch();
      break;
    case 'related':
      await cmdRelated();
      break;
    case 'history':
      await cmdHistory();
      break;
    case 'audit':
      await cmdAudit();
      break;
    case 'create':
      await cmdCreate();
      break;
    case 'update':
      await cmdUpdate();
      break;
    case 'inspect':
      await cmdInspect();
      break;
    case 'serve':
      console.log('MCP server is on the roadmap. Use the engine library or CLI for now.');
      break;
    case 'help':
    case '--help':
    case '-h':
    case undefined:
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

// --- Commands --------------------------------------------------------------

async function cmdInit(): Promise<void> {
  const dir = args[1] ?? '.';
  const root = path.resolve(dir);

  console.log(`Initializing MAAD project in ${root}`);

  // Create directories
  const dirs = ['_registry', '_schema', '_backend'];
  for (const d of dirs) {
    const p = path.join(root, d);
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true });
      console.log(`  Created ${d}/`);
    }
  }

  // Create stub registry
  const registryPath = path.join(root, '_registry', 'object_types.yaml');
  if (!existsSync(registryPath)) {
    writeFileSync(registryPath, 'types: {}\n', 'utf-8');
    console.log('  Created _registry/object_types.yaml');
  }

  // Create .gitignore
  const gitignorePath = path.join(root, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, '_backend/\n', 'utf-8');
    console.log('  Created .gitignore');
  }

  // Generate MAAD.md stub
  const maadMdPath = path.join(root, 'MAAD.md');
  if (!existsSync(maadMdPath)) {
    const enginePath = path.resolve(__dirname, 'cli.js');
    writeFileSync(maadMdPath, generateStubMaadMd(enginePath, root), 'utf-8');
    console.log('  Created MAAD.md');
  }

  // Init git
  const git = new GitLayer(root);
  if (!(await git.isRepo())) {
    await git.initRepo();
    console.log('  Initialized git repository');
  }

  console.log('\nDone. Next steps:');
  console.log('  1. Define types in _registry/object_types.yaml');
  console.log('  2. Create schemas in _schema/');
  console.log('  3. Add markdown records');
  console.log('  4. Run: maad reindex');
}

async function cmdParse(): Promise<void> {
  const filePath = args[1];
  if (!filePath) {
    console.error('Usage: maad parse <file.md>');
    process.exit(1);
  }

  const engine = await initEngine();
  const { parseDocument } = await import('./parser/index.js');
  const registry = engine.getRegistry();

  const absPath = path.resolve(filePath);
  const result = await parseDocument(
    absPath as any,
    registry.subtypeMap,
  );

  if (!result.ok) {
    console.error('Parse errors:');
    for (const e of result.errors) console.error(`  ${e.code}: ${e.message}`);
    process.exit(1);
  }

  const doc = result.value;
  console.log(JSON.stringify({
    filePath: doc.filePath,
    fileHash: doc.fileHash,
    frontmatter: doc.frontmatter,
    blocks: doc.blocks.map(b => ({ id: b.id, heading: b.heading, level: b.level })),
    valueCalls: doc.valueCalls.map(v => v.field),
    annotations: doc.annotations.map(a => ({
      type: a.rawType,
      primitive: a.primitive,
      value: a.value,
      label: a.label,
    })),
  }, null, 2));

  engine.close();
}

async function cmdValidate(): Promise<void> {
  const id = args[1];
  const engine = await initEngine();
  await engine.indexAll();

  const result = await engine.validate(id ? docId(id) : undefined);
  if (!result.ok) {
    console.error('Validation failed:');
    for (const e of result.errors) console.error(`  ${e.code}: ${e.message}`);
    engine.close();
    process.exit(1);
  }

  const report = result.value;
  console.log(`Total: ${report.total} | Valid: ${report.valid} | Invalid: ${report.invalid}`);
  if (report.errors.length > 0) {
    for (const docErr of report.errors) {
      console.log(`\n  ${docErr.docId as string}:`);
      for (const e of docErr.errors) {
        console.log(`    ${e.field}: ${e.message}`);
      }
    }
  }

  engine.close();
}

async function cmdReindex(): Promise<void> {
  const force = args.includes('--force');
  const engine = await initEngine();

  console.log('Indexing...');
  const result = await engine.reindex({ force });
  if (!result.ok) {
    console.error('Reindex errors:');
    for (const e of result.errors) console.error(`  ${e.code}: ${e.message}`);
    engine.close();
    process.exit(1);
  }

  const r = result.value;
  console.log(`Scanned: ${r.scanned} | Indexed: ${r.indexed} | Skipped: ${r.skipped}`);
  if (r.errors.length > 0) {
    console.log(`Errors: ${r.errors.length}`);
    for (const e of r.errors) console.log(`  ${e.code}: ${e.message}`);
  }

  // Regenerate MAAD.md (tool knowledge) and SCHEMA.md (data knowledge)
  try {
    const { loadSchemas } = await import('./schema/index.js');
    const registry = engine.getRegistry();
    const schemaResult = await loadSchemas(engine.getProjectRoot(), registry);
    if (schemaResult.ok) {
      const stats = engine.getBackend().getStats();
      const enginePath = path.resolve(__dirname, 'cli.js');

      // MAAD.md — only write if it doesn't exist (tool knowledge is stable)
      const maadMdPath = path.join(engine.getProjectRoot(), 'MAAD.md');
      if (!existsSync(maadMdPath)) {
        const maadMd = generateMaadMd({
          projectRoot: engine.getProjectRoot(),
          enginePath,
          registry,
          schemaStore: schemaResult.value,
          stats,
        });
        writeFileSync(maadMdPath, maadMd, 'utf-8');
        console.log('Created MAAD.md');
      }

      // SCHEMA.md — always regenerate (data knowledge changes with the index)
      const schemaMd = generateSchemaMd({
        registry,
        schemaStore: schemaResult.value,
        stats,
      });
      writeFileSync(path.join(engine.getProjectRoot(), 'SCHEMA.md'), schemaMd, 'utf-8');
      console.log('Updated SCHEMA.md');
    }
  } catch (e) {
    console.warn(`MAAD.md generation failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  engine.close();
}

async function cmdQuery(): Promise<void> {
  const typeArg = args[1];
  if (!typeArg) {
    console.error('Usage: maad query <doc_type> [--filter field=value]');
    process.exit(1);
  }

  const engine = await initEngine();
  await engine.indexAll();

  const filters: Record<string, { op: 'eq'; value: string }> = {};
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--filter' && args[i + 1]) {
      const [key, val] = args[i + 1]!.split('=');
      if (key && val) filters[key] = { op: 'eq', value: val };
      i++;
    }
  }

  const hasFilters = Object.keys(filters).length > 0;
  const result = engine.findDocuments(
    hasFilters
      ? { docType: docType(typeArg), filters, includeFrontmatter: true }
      : { docType: docType(typeArg), includeFrontmatter: true },
  );

  if (!result.ok) {
    console.error('Query failed:');
    for (const e of result.errors) console.error(`  ${e.code}: ${e.message}`);
    engine.close();
    process.exit(1);
  }

  console.log(JSON.stringify(result.value.results, null, 2));
  engine.close();
}

async function cmdDescribe(): Promise<void> {
  const engine = await initEngine();
  await engine.indexAll();

  const desc = engine.describe();
  console.log(JSON.stringify(desc, null, 2));

  engine.close();
}

async function cmdGet(): Promise<void> {
  const id = args[1];
  const depth = (args[2] ?? 'hot') as 'hot' | 'warm' | 'cold';
  const block = args[3];

  if (!id) {
    console.error('Usage: maad get <doc_id> [hot|warm|cold] [block_id]');
    process.exit(1);
  }

  const engine = await initEngine();
  await engine.indexAll();

  const result = await engine.getDocument(docId(id), depth, block);
  if (!result.ok) {
    console.error('Get failed:');
    for (const e of result.errors) console.error(`  ${e.code}: ${e.message}`);
    engine.close();
    process.exit(1);
  }

  console.log(JSON.stringify(result.value, null, 2));
  engine.close();
}

async function cmdSearch(): Promise<void> {
  const primitive = args[1];
  if (!primitive) {
    console.error('Usage: maad search <primitive> [--subtype type] [--value val] [--contains text]');
    process.exit(1);
  }

  const engine = await initEngine();
  await engine.indexAll();

  const query: Record<string, unknown> = { primitive };
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--subtype' && args[i + 1]) { query['subtype'] = args[++i]; }
    if (args[i] === '--value' && args[i + 1]) { query['value'] = args[++i]; }
    if (args[i] === '--contains' && args[i + 1]) { query['contains'] = args[++i]; }
  }

  const result = engine.searchObjects(query as any);
  if (!result.ok) {
    console.error('Search failed:');
    for (const e of result.errors) console.error(`  ${e.code}: ${e.message}`);
    engine.close();
    process.exit(1);
  }

  console.log(JSON.stringify(result.value.results, null, 2));
  engine.close();
}

async function cmdRelated(): Promise<void> {
  const id = args[1];
  const direction = (args[2] ?? 'both') as 'outgoing' | 'incoming' | 'both';

  if (!id) {
    console.error('Usage: maad related <doc_id> [outgoing|incoming|both]');
    process.exit(1);
  }

  const engine = await initEngine();
  await engine.indexAll();

  const result = engine.listRelated(docId(id), direction);
  if (!result.ok) {
    console.error('Related failed:');
    for (const e of result.errors) console.error(`  ${e.code}: ${e.message}`);
    engine.close();
    process.exit(1);
  }

  console.log(JSON.stringify(result.value, null, 2));
  engine.close();
}

async function cmdHistory(): Promise<void> {
  const id = args[1];
  if (!id) {
    console.error('Usage: maad history <doc_id>');
    process.exit(1);
  }

  const engine = await initEngine();
  await engine.indexAll();

  const result = await engine.history(docId(id));
  if (!result.ok) {
    console.error('History failed:');
    for (const e of result.errors) console.error(`  ${e.code}: ${e.message}`);
    engine.close();
    process.exit(1);
  }

  console.log(JSON.stringify(result.value, null, 2));
  engine.close();
}

async function cmdAudit(): Promise<void> {
  const sinceIdx = args.indexOf('--since');
  const since = sinceIdx >= 0 ? args[sinceIdx + 1] : undefined;

  const engine = await initEngine();
  await engine.indexAll();

  const result = await engine.audit(since ? { since } : {});
  if (!result.ok) {
    console.error('Audit failed:');
    for (const e of result.errors) console.error(`  ${e.code}: ${e.message}`);
    engine.close();
    process.exit(1);
  }

  console.log(JSON.stringify(result.value, null, 2));
  engine.close();
}

async function cmdCreate(): Promise<void> {
  const typeArg = args[1];
  if (!typeArg) {
    console.error('Usage: maad create <doc_type> --field key=value [--body "text"] [--id custom-id]');
    process.exit(1);
  }

  const engine = await initEngine();
  await engine.indexAll();

  // Parse --field flags
  const fields: Record<string, unknown> = {};
  let body: string | undefined;
  let customId: string | undefined;

  for (let i = 2; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    if (arg === '--field' && next) {
      const eqIdx = next.indexOf('=');
      if (eqIdx > 0) {
        const key = next.slice(0, eqIdx);
        let val: unknown = next.slice(eqIdx + 1);
        // Parse arrays: "tags=[a,b,c]"
        if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
          val = val.slice(1, -1).split(',').map(s => s.trim());
        }
        fields[key] = val;
      }
      i++;
    } else if (arg === '--body' && next) {
      body = next;
      i++;
    } else if (arg === '--id' && next) {
      customId = next;
      i++;
    }
  }

  const result = await engine.createDocument(docType(typeArg), fields, body, customId);
  if (!result.ok) {
    console.error('Create failed:');
    for (const e of result.errors) console.error(`  ${e.code}: ${e.message}`);
    engine.close();
    process.exit(1);
  }

  console.log(JSON.stringify(result.value, null, 2));
  engine.close();
}

async function cmdUpdate(): Promise<void> {
  const id = args[1];
  if (!id) {
    console.error('Usage: maad update <doc_id> --field key=value [--body "text"] [--append "text"]');
    process.exit(1);
  }

  const engine = await initEngine();
  await engine.indexAll();

  const fields: Record<string, unknown> = {};
  let body: string | undefined;
  let appendBody: string | undefined;

  for (let i = 2; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];
    if (arg === '--field' && next) {
      const eqIdx = next.indexOf('=');
      if (eqIdx > 0) {
        const key = next.slice(0, eqIdx);
        let val: unknown = next.slice(eqIdx + 1);
        if (typeof val === 'string' && val.startsWith('[') && val.endsWith(']')) {
          val = val.slice(1, -1).split(',').map(s => s.trim());
        }
        fields[key] = val;
      }
      i++;
    } else if (arg === '--body' && next) {
      body = next;
      i++;
    } else if (arg === '--append' && next) {
      appendBody = next;
      i++;
    }
  }

  const hasFields = Object.keys(fields).length > 0;
  const result = await engine.updateDocument(
    docId(id),
    hasFields ? fields : undefined,
    body,
    appendBody,
  );

  if (!result.ok) {
    console.error('Update failed:');
    for (const e of result.errors) console.error(`  ${e.code}: ${e.message}`);
    engine.close();
    process.exit(1);
  }

  console.log(JSON.stringify(result.value, null, 2));
  engine.close();
}

async function cmdInspect(): Promise<void> {
  const id = args[1];
  if (!id) {
    console.error('Usage: maad inspect <doc_id>');
    process.exit(1);
  }

  const engine = await initEngine();
  await engine.indexAll();

  const result = await engine.inspect(docId(id));
  if (!result.ok) {
    console.error('Inspect failed:');
    for (const e of result.errors) console.error(`  ${e.code}: ${e.message}`);
    engine.close();
    process.exit(1);
  }

  console.log(JSON.stringify(result.value, null, 2));
  engine.close();
}

// --- Helpers ---------------------------------------------------------------

async function initEngine(): Promise<MaadEngine> {
  const engine = new MaadEngine();
  const result = await engine.init(path.resolve(projectRoot));
  if (!result.ok) {
    console.error('Failed to initialize engine:');
    for (const e of result.errors) console.error(`  ${e.code}: ${e.message}`);
    process.exit(1);
  }
  return engine;
}

function printHelp(): void {
  console.log(`
MAAD — Markdown Augmented Adaptive Database

Usage: maad <command> [options]

Commands:
  init [dir]                        Initialize a new MAAD project
  describe                          Show project overview
  get <doc_id> [depth] [block]      Read a document (hot/warm/cold)
  query <type> [--filter k=v]       Find documents by type and filters
  search <primitive> [--subtype s]  Search extracted objects
  related <doc_id> [direction]      Show related documents
  inspect <doc_id>                  Show full engine internals for a document
  create <type> --field k=v [...]   Create a new document
  update <doc_id> --field k=v [...] Update a document's fields or body
  validate [doc_id]                 Validate one or all documents
  reindex [--force]                 Rebuild the index from markdown
  parse <file.md>                   Parse a file and print the result
  history <doc_id>                  Show git history for a document
  audit [--since date]              Show project-wide activity

Options:
  --project <dir>                   Set project root (default: cwd)
  --force                           Force full reindex (skip hash check)
  --help                            Show this help
`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
