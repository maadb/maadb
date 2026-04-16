// ============================================================================
// gray-matter wrapper with a string-preserving YAML engine.
//
// Why: js-yaml's DEFAULT_SCHEMA resolves `!!timestamp` scalars into JS Date
// objects. Downstream code (writer/serializer, indexer, extractor, reads,
// writes) then normalizes Dates via `.toISOString().slice(0, 10)`, silently
// truncating any finer-than-day precision on round-trip. That is a hard
// blocker for 0.6.7 schema precision contracts — see
// docs/specs/0.6.7-schema-precision.md §"Round-trip precision preservation".
//
// Fix: use yaml.CORE_SCHEMA (null/bool/int/float/str/seq/map, NO timestamp).
// Datetime-looking scalars stay as literal strings end-to-end.
//
// Every matter(...) call in the codebase goes through parseMatter() so we
// cannot regress this invariant by adding a new caller that forgets the
// engine option.
// ============================================================================

import matter from 'gray-matter';
import yaml from 'js-yaml';

const stringPreservingYamlEngine = {
  // yaml.load returns `unknown` (could be primitive / null on malformed YAML),
  // but gray-matter's engine type demands `object`. Cast is safe: downstream
  // code in parser/frontmatter.ts already validates that `.data` is a plain
  // object and rejects other shapes.
  parse: (raw: string) => yaml.load(raw, { schema: yaml.CORE_SCHEMA }) as object,
  stringify: (obj: object) => yaml.dump(obj),
};

const MATTER_OPTIONS = { engines: { yaml: stringPreservingYamlEngine } } as const;

export function parseMatter(raw: string): matter.GrayMatterFile<string> {
  return matter(raw, MATTER_OPTIONS);
}
