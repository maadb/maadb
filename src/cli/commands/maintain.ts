// ============================================================================
// Maintain commands — init, validate, reindex, parse
// ============================================================================

import path from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { docId } from '../../types.js';
import { GitLayer } from '../../git/index.js';
import { generateSchemaMd } from '../../schema-md.js';
import { generateClaudeMd, generateAgentsMd } from '../../claude-md.js';
import { ensureProjectSkills } from '../../skills-scaffold.js';
import { engineVersion, checkProject, planRefresh, applyRefresh } from '../../instructions/manifest.js';
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

  // Provider pointers — created once at init, user-owned afterward.
  const claudeMdPath = path.join(root, 'CLAUDE.md');
  if (!existsSync(claudeMdPath)) {
    writeFileSync(claudeMdPath, generateClaudeMd(), 'utf-8');
    console.log('  Created CLAUDE.md');
  }
  const agentsMdPath = path.join(root, 'AGENTS.md');
  if (!existsSync(agentsMdPath)) {
    writeFileSync(agentsMdPath, generateAgentsMd(), 'utf-8');
    console.log('  Created AGENTS.md');
  }

  // Managed instruction files (MAAD.md + _skills/) — stamped, create-if-absent
  // (shared scaffold so lifecycle, CLI init, and EnginePool use one code path)
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
  // 0.8.3 — fail closed as a CI gate: a completed audit that FOUND invalid
  // records is a successful engine result (ok(report)) but a failing command.
  // Previously this printed `Invalid: N` and exited 0 — a green light over
  // corrupted data. Precision drift stays informational (never increments
  // report.invalid, so it never fails the gate).
  if (report.invalid > 0) {
    process.exit(1);
  }
}

export async function cmdReindex(ctx: CliContext): Promise<void> {
  const force = ctx.args.includes('--force');
  const embeddings = ctx.args.includes('--embeddings');
  const engine = await initEngine(ctx);

  console.log(embeddings ? 'Indexing (+ rebuilding semantic index)...' : 'Indexing...');
  const result = await engine.reindex({ force, embeddings });
  if (!result.ok) {
    console.error('Reindex errors:');
    for (const e of result.errors) console.error(`  ${e.code}: ${e.message}`);
    engine.close();
    process.exit(1);
  }

  const r = result.value;
  console.log(`Scanned: ${r.scanned} | Indexed: ${r.indexed} | Skipped: ${r.skipped}`);
  // 0.8.1 — surface the full IndexResult; rebuiltTypes/partial were previously
  // dropped from human output and pruned/warnings didn't exist (the stale-row
  // sweep deleted rows with zero representation in the output).
  if (r.rebuiltTypes && r.rebuiltTypes.length > 0) {
    console.log(`Rebuilt types (schema-index change): ${r.rebuiltTypes.join(', ')}`);
  }
  if (r.partial) console.log(`Partial (annotation-capped): ${r.partial}`);
  if (r.pruned) console.log(`Pruned stale index rows: ${r.pruned}`);
  if (r.warnings && r.warnings.length > 0) {
    console.log(`Warnings: ${r.warnings.length}`);
    for (const w of r.warnings) console.log(`  ${w}`);
  }
  if (r.errors.length > 0) {
    console.log(`Errors: ${r.errors.length}`);
    for (const e of r.errors) console.log(`  ${e.code}: ${e.message}`);
  }

  // Instruction-lifecycle rework: reindex no longer writes MAAD.md — it is a
  // static managed file, created via scaffold and updated only through
  // `maad instructions refresh`. SCHEMA.md remains a data-derived artifact
  // and keeps refreshing here.
  try {
    const { loadSchemas } = await import('../../schema/index.js');
    const registry = engine.getRegistry();
    const schemaResult = await loadSchemas(engine.getProjectRoot(), registry);
    if (schemaResult.ok) {
      const stats = engine.getBackend().getStats();
      const schemaMd = generateSchemaMd({
        registry,
        schemaStore: schemaResult.value,
        stats,
      });
      writeFileSync(path.join(engine.getProjectRoot(), 'SCHEMA.md'), schemaMd, 'utf-8');
      console.log('Updated SCHEMA.md');
    }
    const scaffolded = ensureProjectSkills(engine.getProjectRoot());
    for (const f of scaffolded.created) console.log(`Created ${f}`);
    const stale = checkProject(engine.getProjectRoot()).filter(s => s.state !== 'current');
    if (stale.length > 0) {
      console.log(`Instructions not current (${stale.map(s => `${s.relPath}:${s.state}`).join(', ')}) — run \`maad instructions check\`.`);
    }
  } catch (e) {
    console.warn(`SCHEMA.md generation failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  engine.close();
  // 0.8.3 — same fail-closed posture as cmdValidate: a full reindex reports
  // per-file failures (parse errors, duplicate doc_ids, over-cap docs) inside
  // a successful IndexResult, so `!result.ok` never fires for them and the
  // command previously exited 0 with errors printed. Warnings stay advisory
  // and do not fail the gate; errors do. MAAD.md/SCHEMA.md regeneration above
  // still runs — the successfully indexed docs are real.
  if (r.errors.length > 0) {
    process.exit(1);
  }
}

export async function cmdInstructions(ctx: CliContext): Promise<void> {
  const sub = ctx.args[1];
  const root = path.resolve(ctx.projectRoot);

  if (sub === 'check') {
    const statuses = checkProject(root);
    console.log(`Managed instructions in ${root} (engine ${engineVersion()}):`);
    for (const s of statuses) {
      const vintage = s.stampedEngine ? ` (stamped ${s.stampedEngine})` : '';
      console.log(`  ${s.state.padEnd(9)} ${s.relPath}${vintage}`);
    }
    const actionable = statuses.filter(s => s.state !== 'current');
    if (actionable.length === 0) {
      console.log('All managed instructions are current.');
    } else {
      console.log(`\n${actionable.length} file(s) not current. \`maad instructions refresh\` updates outdated/missing; add --force to also replace modified/unmanaged files (git history is the undo path).`);
      process.exit(1);
    }
    return;
  }

  if (sub === 'refresh') {
    const apply = ctx.args.includes('--apply');
    const force = ctx.args.includes('--force');
    const plan = planRefresh(root, { force });

    for (const s of plan.current) console.log(`  current   ${s.relPath}`);
    for (const s of plan.refresh) console.log(`  ${apply ? 'refresh' : 'would refresh'}  ${s.relPath} (${s.state})`);
    for (const s of plan.skippedModified) console.log(`  SKIP modified   ${s.relPath} — user-edited; --force to replace`);
    for (const s of plan.skippedUnmanaged) console.log(`  SKIP unmanaged  ${s.relPath} — pre-lifecycle vintage; --force to adopt`);

    if (plan.refresh.length === 0) {
      console.log('Nothing to refresh.');
      return;
    }
    if (!apply) {
      console.log(`\nDry run — ${plan.refresh.length} file(s) would be refreshed to engine ${engineVersion()}. Re-run with --apply to write.`);
      return;
    }

    const written = applyRefresh(root, plan);
    console.log(`Refreshed ${written.length} file(s) to engine ${engineVersion()}.`);

    // Land the refresh as its own commit so it is auditable and revertible.
    try {
      const git = new GitLayer(root);
      if (await git.isRepo()) {
        const sg = git.getSimpleGit();
        await sg.add(written);
        await sg.commit(`maad:instructions — refresh managed instructions to ${engineVersion()}`);
        console.log('Committed refresh to git.');
      }
    } catch (e) {
      console.warn(`Git commit failed (files written): ${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }

  console.error('Usage: maad instructions <check|refresh> [--apply] [--force]');
  process.exit(1);
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
