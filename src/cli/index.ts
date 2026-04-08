#!/usr/bin/env node
// ============================================================================
// MAAD CLI — Command dispatch
// ============================================================================

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CliContext } from './helpers.js';
import { cmdScan, cmdSummary, cmdDescribe } from './commands/discover.js';
import { cmdGet, cmdQuery, cmdSearch, cmdRelated, cmdSchema } from './commands/read.js';
import { cmdCreate, cmdUpdate } from './commands/write.js';
import { cmdInit, cmdValidate, cmdReindex, cmdParse } from './commands/maintain.js';
import { cmdHistory, cmdAudit } from './commands/audit.js';
import { startServer } from '../mcp/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse --project flag
const rawArgs = process.argv.slice(2);
let projectRoot = '.';
const args: string[] = [];

for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--project' && rawArgs[i + 1]) {
    projectRoot = rawArgs[i + 1]!;
    i++;
  } else {
    args.push(rawArgs[i]!);
  }
}

const ctx: CliContext = { args, projectRoot, __dirname };
const command = args[0];

async function main(): Promise<void> {
  switch (command) {
    // Discover
    case 'scan':      await cmdScan(ctx); break;
    case 'summary':   await cmdSummary(ctx); break;
    case 'describe':  await cmdDescribe(ctx); break;
    // Read
    case 'get':       await cmdGet(ctx); break;
    case 'query':     await cmdQuery(ctx); break;
    case 'search':    await cmdSearch(ctx); break;
    case 'related':   await cmdRelated(ctx); break;
    case 'schema':    await cmdSchema(ctx); break;
    // Write
    case 'create':    await cmdCreate(ctx); break;
    case 'update':    await cmdUpdate(ctx); break;
    // Maintain
    case 'init':      await cmdInit(ctx); break;
    case 'validate':  await cmdValidate(ctx); break;
    case 'reindex':   await cmdReindex(ctx); break;
    case 'parse':     await cmdParse(ctx); break;
    // Audit
    case 'history':   await cmdHistory(ctx); break;
    case 'audit':     await cmdAudit(ctx); break;
    // MCP
    case 'serve':
      await cmdServe();
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

async function cmdServe(): Promise<void> {
  let role: string | undefined;
  let dryRun = false;
  let provenance: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--role' && args[i + 1]) {
      role = args[i + 1];
    }
    if (args[i] === '--dry-run') {
      dryRun = true;
    }
    if (args[i] === '--prov' && args[i + 1]) {
      provenance = args[i + 1];
    }
  }

  await startServer({
    projectRoot: path.resolve(projectRoot),
    role,
    dryRun,
    provenance,
  });
}

function printHelp(): void {
  console.log(`
MAAD — Markdown As A Database

Usage: maad <command> [options]

Commands:
  init [dir]                        Initialize a new MAAD project
  scan <file.md|dir>                 Analyze raw markdown (no registry needed)
  summary                           Project snapshot (types, counts, sample IDs, object inventory)
  describe                          Show project overview
  get <doc_id> [depth] [block]      Read a document (hot/warm/cold/full)
  query <type> [--filter k=v]       Find documents by type and filters
  search <primitive> [opts]         Search extracted objects (--subtype, --value, --contains, --doc)
  related <doc_id> [direction]      Show related documents
  schema <type>                     Show field definitions for a type (for writes)
  create <type> --field k=v [...]   Create a new document
  update <doc_id> --field k=v [...] Update a document's fields or body
  validate [doc_id]                 Validate one or all documents
  reindex [--force]                 Rebuild the index from markdown
  parse <file.md>                   Parse a file and print the result
  history <doc_id>                  Show git history for a document
  audit [--since date]              Show project-wide activity
  serve [--role reader|writer|admin] [--prov off|on|detail] Start MCP server

Options:
  --project <dir>                   Set project root (default: cwd)
  --role <role>                     MCP server role (default: reader)
  --force                           Force full reindex (skip hash check)
  --help                            Show this help
`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
