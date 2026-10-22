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

// gray-matter selects the parser from a language tag after the opening
// delimiter (`---js`, `---json`), and its built-in JavaScript engine
// evaluates the block. Frontmatter is untrusted file content, so refuse that
// engine outright; the 'js' tag resolves to the same 'javascript' entry.
const refuseCodeEngine = {
  parse: (): never => {
    throw new Error('Executable frontmatter engines are not supported; use YAML');
  },
};

const MATTER_OPTIONS = {
  engines: { yaml: stringPreservingYamlEngine, javascript: refuseCodeEngine },
} as const;

// Any other tag also picks an engine: gray-matter's JSON parser, or an
// inherited Object.prototype member (`---constructor`) that yields junk data.
// The engine has already run by the time the tag is known, which is why the
// code engine is refused above; this check rejects the remaining non-YAML tags.
const YAML_LANGUAGES = new Set(['yaml', 'yml']);

export function parseMatter(raw: string): matter.GrayMatterFile<string> {
  const parsed = matter(raw, MATTER_OPTIONS);
  const language = parsed.language ?? 'yaml';
  if (!YAML_LANGUAGES.has(language.toLowerCase())) {
    throw new Error(`Frontmatter language "${language}" is not supported; use YAML`);
  }
  return parsed;
}
