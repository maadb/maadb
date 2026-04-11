// ============================================================================
// Maintain commands — init, validate, reindex, parse
// ============================================================================

import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { docId } from '../../types.js';
import { GitLayer } from '../../git/index.js';
import { generateMaadMd, generateStubMaadMd } from '../../maad-md.js';
import { generateSchemaMd } from '../../schema-md.js';
import { generateClaudeMd } from '../../claude-md.js';
import { ensureProjectSkills } from '../../skills-scaffold.js';
import type { CliContext } from '../helpers.js';
import { initEngine } from '../helpers.js';

export async function cmdInit(ctx: CliContext): Promise<void> {
  const dir = ctx.args[1] ?? '.';
  const root = path.resolve(dir);

  console.log(`Initializing MAAD project in ${root}`);

  const dirs = ['_registry', '_schema', '_backend', '_import'];
  for (const d of dirs) {
    const p = path.join(root, d);
    if (!existsSync(p)) {
      mkdirSync(p, { recursive: true });
      console.log(`  Created ${d}/`);
    }
  }

  const registryPath = path.join(root, '_registry', 'object_types.yaml');
  if (!existsSync(registryPath)) {
    writeFileSync(registryPath, 'types: {}\n', 'utf-8');
    console.log('  Created _registry/object_types.yaml');
  }

  const gitignorePath = path.join(root, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, '_backend/\n_import/\n', 'utf-8');
    console.log('  Created .gitignore');
  }

  const maadMdPath = path.join(root, 'MAAD.md');
  if (!existsSync(maadMdPath)) {
    const enginePath = path.resolve(ctx.__dirname, 'cli.js');
    writeFileSync(maadMdPath, generateStubMaadMd(enginePath, root), 'utf-8');
    console.log('  Created MAAD.md');
  }

  // CLAUDE.md — agent instructions for MCP-first workflow
  const claudeMdPath = path.join(root, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, generateClaudeMd(), 'utf-8');
    console.log('  Created CLAUDE.md');
  }

  // Skill files — detailed workflow guides (delegated to shared scaffold
  // helper so lifecycle, CLI init, and future EnginePool share one code path)
  const skillsResult = ensureProjectSkills(root);
  for (const f of skillsResult.created) console.log(`  Created ${f}`);
  for (const e of skillsResult.errors) console.warn(`  Failed ${e.file}: ${e.message}`);

  const git = new GitLayer(root);
  if (!(await git.isRepo())) {
    await git.initRepo();
    console.log('  Initialized git repository');
  }

  console.log('\nDone. The LLM agent can now use MAAD MCP tools to work with this project.');
}

export async function cmdValidate(ctx: CliContext): Promise<void> {
  const id = ctx.args[1];
  const engine = await initEngine(ctx);
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

export async function cmdReindex(ctx: CliContext): Promise<void> {
  const force = ctx.args.includes('--force');
  const engine = await initEngine(ctx);

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

  try {
    const { loadSchemas } = await import('../../schema/index.js');
    const registry = engine.getRegistry();
    const schemaResult = await loadSchemas(engine.getProjectRoot(), registry);
    if (schemaResult.ok) {
      const stats = engine.getBackend().getStats();
      const enginePath = path.resolve(ctx.__dirname, 'cli.js');

      const maadMdPath = path.join(engine.getProjectRoot(), 'MAAD.md');
      const maadMd = generateMaadMd({
        projectRoot: engine.getProjectRoot(),
        enginePath,
        registry,
        schemaStore: schemaResult.value,
        stats,
      });
      writeFileSync(maadMdPath, maadMd, 'utf-8');
      console.log('Updated MAAD.md');

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

export async function cmdParse(ctx: CliContext): Promise<void> {
  const filePath = ctx.args[1];
  if (!filePath) {
    console.error('Usage: maad parse <file.md>');
    process.exit(1);
  }

  const engine = await initEngine(ctx);
  const { parseDocument } = await import('../../parser/index.js');
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
