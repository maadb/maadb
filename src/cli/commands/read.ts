// ============================================================================
// Read commands — get, query, search, related, schema
// ============================================================================

import { docId, docType } from '../../types.js';
import type { CliContext } from '../helpers.js';
import { initEngine } from '../helpers.js';

export async function cmdGet(ctx: CliContext): Promise<void> {
  const id = ctx.args[1];
  const depth = (ctx.args[2] ?? 'hot') as 'hot' | 'warm' | 'cold' | 'full';
  const block = ctx.args[3];

  if (!id) {
    console.error('Usage: maad get <doc_id> [hot|warm|cold|full] [block_id]');
    process.exit(1);
  }

  const engine = await initEngine(ctx);

  if (depth === 'full') {
    const result = await engine.getDocumentFull(docId(id));
    if (!result.ok) {
      console.error('Get failed:');
      for (const e of result.errors) console.error(`  ${e.code}: ${e.message}`);
      engine.close();
      process.exit(1);
    }
    console.log(JSON.stringify(result.value, null, 2));
    engine.close();
    return;
  }

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

export async function cmdQuery(ctx: CliContext): Promise<void> {
  const typeArg = ctx.args[1];
  if (!typeArg) {
    console.error('Usage: maad query <doc_type> [--filter field=value]');
    process.exit(1);
  }

  const engine = await initEngine(ctx);

  const filters: Record<string, { op: 'eq'; value: string }> = {};
  for (let i = 2; i < ctx.args.length; i++) {
    if (ctx.args[i] === '--filter' && ctx.args[i + 1]) {
      const [key, val] = ctx.args[i + 1]!.split('=');
      if (key && val) filters[key] = { op: 'eq', value: val };
      i++;
    }
  }

  const hasFilters = Object.keys(filters).length > 0;
  const result = engine.findDocuments(
    hasFilters
      ? { docType: docType(typeArg), filters }
      : { docType: docType(typeArg) },
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

export async function cmdSearch(ctx: CliContext): Promise<void> {
  const primitive = ctx.args[1];
  if (!primitive) {
    console.error('Usage: maad search <primitive> [--subtype type] [--query text] [--value val] [--contains text] [--doc doc_id]');
    process.exit(1);
  }

  const engine = await initEngine(ctx);

  const query: Record<string, unknown> = { primitive };
  for (let i = 2; i < ctx.args.length; i++) {
    if (ctx.args[i] === '--subtype' && ctx.args[i + 1]) { query['subtype'] = ctx.args[++i]; }
    if (ctx.args[i] === '--value' && ctx.args[i + 1]) { query['value'] = ctx.args[++i]; }
    if ((ctx.args[i] === '--contains' || ctx.args[i] === '--query') && ctx.args[i + 1]) { query['contains'] = ctx.args[++i]; }
    if (ctx.args[i] === '--doc' && ctx.args[i + 1]) { query['docId'] = ctx.args[++i]; }
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

export async function cmdRelated(ctx: CliContext): Promise<void> {
  const id = ctx.args[1];
  const direction = (ctx.args[2] ?? 'both') as 'outgoing' | 'incoming' | 'both';

  if (!id) {
    console.error('Usage: maad related <doc_id> [outgoing|incoming|both]');
    process.exit(1);
  }

  const engine = await initEngine(ctx);

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

export async function cmdSchema(ctx: CliContext): Promise<void> {
  const typeArg = ctx.args[1];
  if (!typeArg) {
    console.error('Usage: maad schema <doc_type>');
    process.exit(1);
  }

  const engine = await initEngine(ctx);

  const result = engine.schemaInfo(docType(typeArg));
  if (!result.ok) {
    console.error('Schema failed:');
    for (const e of result.errors) console.error(`  ${e.code}: ${e.message}`);
    engine.close();
    process.exit(1);
  }

  console.log(JSON.stringify(result.value, null, 2));
  engine.close();
}
