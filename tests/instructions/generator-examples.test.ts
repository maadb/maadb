// ============================================================================
// Generator example validation — instruction drift becomes a test failure
//
// Every YAML example emitted by the instruction generators must be valid
// against the REAL registry/schema loaders, and prose must not contradict
// engine behavior. Guards the P0 corrections (item_type vs itemType,
// template.headings shape, engine-stamped identity fields, shipped
// subscriptions) against reintroduction.
// ============================================================================

import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import { loadRegistry } from '../../src/registry/loader.js';
import { loadSchemas } from '../../src/schema/loader.js';
import { generateSchemaGuide, generateImportGuide } from '../../src/skill-files.js';
import { generateArchitectSkill } from '../../src/architect.js';
import { generateMaadMd } from '../../src/maad-md.js';
import { generateGraphOntologySkill } from '../../src/skills/graph-ontology.js';
import { generateCorpusExplorerSkill } from '../../src/skills/corpus-explorer.js';
import type { Registry, SchemaStore } from '../../src/types.js';

const TEMP_ROOT = path.resolve(__dirname, '../fixtures/_temp-generator-examples');

/** Guides that embed YAML schema/registry examples (loader-validated). */
const GUIDES: Record<string, string> = {
  'schema-guide': generateSchemaGuide(),
  'import-guide': generateImportGuide(),
  'architect-core': generateArchitectSkill(),
};

/** Fully-static recipe skills — prose only, no YAML schema examples. */
const RICH_SKILLS: Record<string, string> = {
  'graph-ontology': generateGraphOntologySkill(),
  'corpus-explorer': generateCorpusExplorerSkill(),
};

function extractYamlBlocks(text: string): string[] {
  const blocks: string[] = [];
  const re = /```yaml\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) blocks.push(m[1]!);
  return blocks;
}

/** Strip full-line comments (fixture headers like "# _schema/client.v1.yaml"). */
function stripCommentHeader(block: string): string {
  return block.split('\n').filter(l => !/^\s*#/.test(l)).join('\n');
}

let fixtureCounter = 0;

/**
 * Build a throwaway project on disk and run the REAL loaders over it.
 * Any type referenced by a ref/list-of-ref target that isn't registered by
 * the example itself gets a minimal registration so target validation runs.
 */
async function loadProject(
  registryEntries: Record<string, { path: string; id_prefix: string; schema: string }>,
  schemaFiles: Record<string, string>,
): Promise<{ registry: Registry; schemas: SchemaStore }> {
  const root = path.join(TEMP_ROOT, `p${fixtureCounter++}`);
  mkdirSync(path.join(root, '_registry'), { recursive: true });
  mkdirSync(path.join(root, '_schema'), { recursive: true });
  writeFileSync(
    path.join(root, '_registry', 'object_types.yaml'),
    yaml.dump({ types: registryEntries }),
    'utf-8',
  );
  for (const [name, content] of Object.entries(schemaFiles)) {
    writeFileSync(path.join(root, '_schema', name), content, 'utf-8');
  }
  const reg = await loadRegistry(root);
  expect(reg.ok, `loadRegistry: ${JSON.stringify(!reg.ok ? reg.errors : '')}`).toBe(true);
  if (!reg.ok) throw new Error('unreachable');
  const schemas = await loadSchemas(root, reg.value);
  expect(schemas.ok, `loadSchemas: ${JSON.stringify(!schemas.ok ? schemas.errors : '')}`).toBe(true);
  if (!schemas.ok) throw new Error('unreachable');
  return { registry: reg.value, schemas: schemas.value };
}

function minimalSchema(typeName: string): string {
  return `type: ${typeName}\nversion: 1\nfields:\n  name:\n    type: string\n`;
}

function prefixFor(typeName: string): string {
  return typeName.replace(/[^a-z0-9]/g, '').slice(0, 5).padEnd(2, 'x');
}

/** Collect every `target: <type>` named inside a schema block. */
function refTargets(block: string): string[] {
  const out: string[] = [];
  const re = /^\s*target:\s*([a-z_0-9]+)\s*(#.*)?$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) out.push(m[1]!);
  return out;
}

afterAll(() => {
  if (existsSync(TEMP_ROOT)) rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

// ---- Every YAML block must at minimum parse -------------------------------

describe('generator YAML examples parse', () => {
  for (const [guide, text] of Object.entries(GUIDES)) {
    it(`${guide}: every fenced yaml block is parseable`, () => {
      const blocks = extractYamlBlocks(text);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(() => yaml.load(stripCommentHeader(block)), `block:\n${block}`).not.toThrow();
      }
    });
  }
});

// ---- Full schema examples load through the real loader ---------------------

describe('generator schema examples load through the real schema loader', () => {
  for (const [guide, text] of Object.entries(GUIDES)) {
    const blocks = extractYamlBlocks(text).map(stripCommentHeader);
    for (const [i, block] of blocks.entries()) {
      const parsed = ((): unknown => { try { return yaml.load(block); } catch { return null; } })();
      if (parsed === null || typeof parsed !== 'object') continue;
      const obj = parsed as Record<string, unknown>;

      // Full schema example: { type, fields, ... }
      if (typeof obj['type'] === 'string' && typeof obj['fields'] === 'object') {
        const typeName = obj['type'] as string;
        it(`${guide} block ${i}: schema example for "${typeName}" loads cleanly`, async () => {
          const entries: Record<string, { path: string; id_prefix: string; schema: string }> = {
            [typeName]: { path: `${typeName}s/`, id_prefix: prefixFor(typeName), schema: `${typeName}.v1` },
          };
          const schemaFiles: Record<string, string> = { [`${typeName}.v1.yaml`]: block };
          for (const target of refTargets(block)) {
            if (entries[target]) continue;
            entries[target] = { path: `${target}s/`, id_prefix: prefixFor(target), schema: `${target}.v1` };
            schemaFiles[`${target}.v1.yaml`] = minimalSchema(target);
          }
          const { schemas } = await loadProject(entries, schemaFiles);
          const schema = schemas.getSchemaForType(typeName as never);
          expect(schema).toBeDefined();
          // Declared list fields must have carried their item_type through the
          // loader — the itemType-vs-item_type drift produced silent nulls.
          for (const [fieldName, fdRaw] of Object.entries(obj['fields'] as Record<string, unknown>)) {
            const fd = fdRaw as Record<string, unknown>;
            if (fd['type'] === 'list' && fd['item_type'] !== undefined) {
              expect(schema!.fields.get(fieldName)?.itemType, `${fieldName}.item_type lost in loading`).toBe(fd['item_type']);
            }
          }
          // A template in the example must actually parse into headings — the
          // old array shape silently produced template=null.
          if (obj['template'] !== undefined) {
            expect(schema!.template, 'template silently dropped by loader').not.toBeNull();
            expect(schema!.template!.length).toBeGreaterThan(0);
          }
        });
      }

      // Registry example: { types: {...} }
      if (typeof obj['types'] === 'object' && obj['types'] !== null) {
        it(`${guide} block ${i}: registry example loads cleanly`, async () => {
          const types = obj['types'] as Record<string, { path: string; id_prefix: string; schema: string }>;
          const schemaFiles: Record<string, string> = {};
          for (const [name, entry] of Object.entries(types)) {
            schemaFiles[`${entry.schema}.yaml`] = minimalSchema(name);
          }
          await loadProject(types, schemaFiles);
        });
      }

      // Standalone template fragment: { template: ... } with no type/fields —
      // wrap in a minimal schema and require headings to survive the loader.
      if (obj['template'] !== undefined && obj['type'] === undefined) {
        it(`${guide} block ${i}: template fragment produces a real template`, async () => {
          const wrapped = `type: frag\nversion: 1\nfields:\n  title:\n    type: string\n${block}`;
          const { schemas } = await loadProject(
            { frag: { path: 'frags/', id_prefix: 'frg', schema: 'frag.v1' } },
            { 'frag.v1.yaml': wrapped },
          );
          const schema = schemas.getSchemaForType('frag' as never);
          expect(schema!.template, 'template fragment silently dropped — wrong shape?').not.toBeNull();
          expect(schema!.template!.length).toBeGreaterThan(0);
        });
      }
    }
  }
});

// ---- Prose regression guards ------------------------------------------------

describe('generator prose does not contradict engine behavior', () => {
  const maadMd = generateMaadMd();
  const allGenerated = { ...GUIDES, ...RICH_SKILLS, 'MAAD.md': maadMd };

  it('no guide teaches the itemType key (loader reads item_type)', () => {
    for (const [guide, text] of Object.entries(allGenerated)) {
      expect(text.includes('itemType'), `${guide} teaches itemType`).toBe(false);
    }
  });

  it('no example puts engine-owned identity fields inside fields payloads', () => {
    for (const [guide, text] of Object.entries(allGenerated)) {
      expect(/fields:\s*\{[^}]*\b(doc_id|doc_type|schema)\s*:/.test(text),
        `${guide} example passes identity keys in fields (FRONTMATTER_GUARD)`).toBe(false);
    }
  });

  it('no guide shows the template-as-array shape the loader silently drops', () => {
    for (const [guide, text] of Object.entries(allGenerated)) {
      expect(/template:\n\s*- level/.test(text), `${guide} shows array-shaped template`).toBe(false);
    }
  });

  it('architect guide reflects shipped subscriptions, not a roadmap claim', () => {
    const text = GUIDES['architect-core']!;
    expect(text).toContain('maad_subscribe');
    expect(text.toLowerCase().includes('roadmapped')).toBe(false);
  });

  it('architect guide does not claim one-project-one-tenant', () => {
    expect(GUIDES['architect-core']!.includes('one project = one tenant')).toBe(false);
  });

  it('MAAD.md does not overclaim reindex as universal recovery', () => {
    expect(maadMd.includes('recovers from any stale state')).toBe(false);
    expect(maadMd).toContain('verify mode=integrity');
  });

  it('MAAD.md does not teach a read-depth escalation ladder', () => {
    expect(/escalate to .?full.?, .?warm.?, then .?cold.?/i.test(maadMd)).toBe(false);
  });

  it('MAAD.md is fully static: no machine paths, no test/eval scaffolding', () => {
    expect(/[A-Za-z]:\\|\/tmp\/|\/home\/|\/Users\//.test(maadMd), 'machine path leaked').toBe(false);
    expect(/node .*cli\.js/.test(maadMd), 'engine invocation path leaked').toBe(false);
    expect(maadMd.toLowerCase().includes('test/evaluation')).toBe(false);
    expect(maadMd.includes('feedback-')).toBe(false);
  });

  it('architect guide does not mandate agt-architect self-registration or ship the domain cookbook', () => {
    const text = GUIDES['architect-core']!;
    expect(text.includes('agt-architect')).toBe(false);
    expect(text.includes('plumbing, HVAC')).toBe(false);
  });

  it('no guide states the flat 1,000-records-per-year cutoff as a rule', () => {
    for (const [guide, text] of Object.entries(allGenerated)) {
      expect(/more than 1,000 records per year\?/.test(text), `${guide} still teaches the flat cutoff`).toBe(false);
    }
  });

  it('graph-ontology skill teaches relationship paths and densification overlays', () => {
    const text = RICH_SKILLS['graph-ontology']!;
    expect(text).toContain('maad_relationship_paths');
    expect(text).toContain('_skills/local/ontology.md');
    expect(text).toContain('do not edit');
    expect(text.toLowerCase().includes('cypher')).toBe(true); // non-goal rejection
    expect(/prj_|sess-|agt-/.test(text)).toBe(false);
  });

  it('graph-ontology maad_search recipes include required primitive', () => {
    const text = RICH_SKILLS['graph-ontology']!;
    expect(text).toContain('primitive=identifier');
    expect(text).toContain('INVALID_PRIMITIVE');
    // Bare value= without primitive is a trap (tool requires primitive).
    expect(/maad_search` with `value=/.test(text)).toBe(false);
  });

  it('corpus-explorer skill teaches staged mapping and corpus-map overlay', () => {
    const text = RICH_SKILLS['corpus-explorer']!;
    expect(text).toContain('maad_relationship_paths');
    expect(text).toContain('_skills/local/corpus-map.md');
    expect(text).toContain('maad_find_orphans');
    expect(text).toContain('do not edit');
    expect(/prj_|sess-|agt-/.test(text)).toBe(false);
  });

  it('corpus-explorer Stage 1 does not teach filesystem tree walks', () => {
    const text = RICH_SKILLS['corpus-explorer']!;
    expect(/Skim `MAAD\.md` and list `_skills\/`/.test(text)).toBe(false);
    expect(text).toContain('Do not walk the project tree on disk');
  });

  it('MAAD.md Skills list includes the new managed graph skills', () => {
    expect(maadMd).toContain('_skills/graph-ontology.md');
    expect(maadMd).toContain('_skills/corpus-explorer.md');
  });
});
