#!/usr/bin/env node
// Repo quality gate. One file, no dependencies: vendored as
// .github/quality.mjs.
// Shared copy kept by the maintainers. Refresh the whole file, keeping this header.
//
//   node .github/quality.mjs                    pre-push gate (stage "gate")
//   node .github/quality.mjs --stage main       the gate plus the "main" steps (CI on main)
//   node .github/quality.mjs --only qx,leaks    run some steps only
//   node .github/quality.mjs --range A..B       commit range for the message and leak checks
//   node .github/quality.mjs --list             print the resolved steps and exit
//   node .github/quality.mjs --config <file>    read the steps from <file>, not pipeline.json
//   node .github/quality.mjs --install-hook     install the git pre-push hook [--force]
//   node .github/quality.mjs --uninstall-hook
//
// Steps come from pipeline.json at the repo root. A step is a built-in check,
// a named command from "commands", or an npm script. A configured step that
// resolves to nothing fails: a check that silently never runs is a defect.
// A step listed in "warn" still runs and reports, but does not fail the gate:
// for adopting the gate while a repo cleans up existing problems.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname, extname, basename, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";

export const GATE_BUDGET_SECONDS = 300;
const HOOK_MARKER = "quality-gate pre-push";
const ZERO_SHA = /^0+$/;

// ---------------------------------------------------------------- helpers

// Git exports GIT_DIR and friends to hooks. Child processes must not inherit
// them: a test that runs `git init` in a temp dir would otherwise re-init the
// pushing repo as bare.
const GIT_LOCAL_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"];
export function cleanEnv(env = process.env) {
  const out = { ...env };
  for (const key of [...GIT_LOCAL_ENV, "PIPELINE_GITHUB_TOKEN"]) delete out[key];
  return out;
}

function git(args, opts = {}) {
  const r = spawnSync("git", args, { cwd: opts.cwd, env: cleanEnv(), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || "").trim()}`);
  }
  return r.status === 0 ? r.stdout : null;
}

export function repoRoot(cwd = process.cwd()) {
  return git(["rev-parse", "--show-toplevel"], { cwd }).trim();
}

function trackedFiles(root) {
  return git(["ls-files", "-z"], { cwd: root }).split("\0").filter(Boolean);
}

// Minimal glob: "**" crosses folders, "*" does not, "?" is one character.
// A pattern without "/" matches the file name in any folder.
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(glob.includes("/") ? `^${re}$` : `(?:^|/)${re}$`);
}

export function matchesAny(path, globs = []) {
  return globs.some((g) => globToRegExp(g).test(path));
}

function readText(root, rel) {
  const abs = join(root, rel);
  try {
    const buf = readFileSync(abs);
    if (buf.length > 2 * 1024 * 1024 || buf.includes(0)) return null; // too large, or binary
    return buf.toString("utf8");
  } catch {
    return null; // deleted in the working tree, or a submodule
  }
}

function readJson(root, rel) {
  const text = readText(root, rel);
  return text == null ? null : JSON.parse(text);
}

function defaultBranch(root) {
  const head = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd: root, allowFail: true });
  if (head) return head.trim().replace("refs/remotes/origin/", "");
  for (const b of ["main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${b}`], { cwd: root, allowFail: true })) return b;
  }
  return "main";
}

function shaExists(root, sha) {
  return git(["cat-file", "-e", `${sha}^{commit}`], { cwd: root, allowFail: true }) !== null;
}

// The commits being shipped. A range whose base is missing or all zeros (new
// branch, first push) falls back to "origin/<default>..<head>".
export function resolveRange(root, range) {
  let [base, head] = (range || "").split("..");
  head = head || "HEAD";
  if (!base || ZERO_SHA.test(base) || !shaExists(root, base)) {
    const remote = `origin/${defaultBranch(root)}`;
    base = shaExists(root, remote) ? remote : null;
  }
  if (!base) return [head];
  return git(["rev-list", "--no-merges", `${base}..${head}`], { cwd: root }).split("\n").filter(Boolean);
}

function commitMessage(root, sha) {
  return git(["log", "-1", "--format=%B", sha], { cwd: root });
}

// ---------------------------------------------------------------- config

export const DEFAULT_CONFIG = {
  gate: ["typecheck", "lint", "test:unit", "build", "qx", "leaks", "commits", "deps", "audit", "ci-hosting"],
  main: ["test:integration", "test:browser"],
  commands: {},
  warn: [],
  qx: {
    exemptions: "docs/quality-exemptions.md",
    extensions: [".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx", ".vue", ".svelte", ".py"],
    exclude: [],
  },
  leaks: { allow: [], allowPaths: [] },
  frontmatter: [],
  public: false,
  selfHosted: false,
};

export function loadConfig(root, configFile) {
  const file = configFile || join(root, "pipeline.json");
  if (!existsSync(file)) throw new Error(`${configFile || "pipeline.json"} is missing${configFile ? "" : " at the repo root"} (see tools/pipeline/README.md)`);
  const user = JSON.parse(readFileSync(file, "utf8"));
  const cfg = { ...DEFAULT_CONFIG, ...user };
  for (const key of ["qx", "leaks"]) cfg[key] = { ...DEFAULT_CONFIG[key], ...(user[key] || {}) };
  // Operator-only values (internal hostnames and the like) never go in a
  // tracked file: they come from the gitignored pipeline.local.json.
  const local = join(root, "pipeline.local.json");
  cfg.localDeny = existsSync(local) ? JSON.parse(readFileSync(local, "utf8")).deny || [] : [];
  return cfg;
}

// ---------------------------------------------------------------- built-in checks
// Each returns a list of problems (strings). Empty means pass.

// Strings are assembled so this file never matches its own checks.
const j = (...p) => p.join("");
const QX_PATTERNS = [
  new RegExp(j("eslint", "-disable")),
  new RegExp(j("@ts", "-expect-error")),
  new RegExp(j("@ts", "-ignore")),
  new RegExp(j("@ts", "-nocheck")),
  new RegExp(j("\\b(?:it|test|describe|suite|context)\\.(?:skip|todo)", "\\b")),
  new RegExp(j("\\bx(?:it|test|describe)", "\\(")),
  // The skip and todo options of a test call, not any object with a skip key.
  new RegExp(j("\\b(?:it|test|describe|suite)\\s*\\([^)]*[{,]\\s*(?:skip|todo)", ":\\s*(?:true|['\"`])")),
  new RegExp(j("#\\s*no", "qa\\b")),
  new RegExp(j("#\\s*type:\\s*", "ignore\\b")),
  new RegExp(j("pytest\\.mark\\.(?:skip|xfail)", "\\b")),
  new RegExp(j("@unittest\\.", "skip")),
];
// Focused tests disable every other test in the file. Never exemptible.
const QX_FORBIDDEN = new RegExp(j("\\b(?:it|test|describe|suite|context)\\.", "only\\("));
const QX_ID = /QX-\d+/g;

export function checkQx(root, cfg, files = trackedFiles(root)) {
  const problems = [];
  const exemptionsText = readText(root, cfg.qx.exemptions) || "";
  const registered = new Set(exemptionsText.match(QX_ID) || []);
  for (const file of files) {
    if (!cfg.qx.extensions.includes(extname(file))) continue;
    if (matchesAny(file, cfg.qx.exclude)) continue;
    const text = readText(root, file);
    if (text == null) continue;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const where = `${file}:${i + 1}`;
      if (QX_FORBIDDEN.test(line)) {
        problems.push(`${where}: focused test (.only) disables the rest of the suite`);
        return;
      }
      if (!QX_PATTERNS.some((p) => p.test(line))) return;
      const ids = [...(line.match(QX_ID) || []), ...((lines[i - 1] || "").match(QX_ID) || [])];
      if (ids.length === 0) problems.push(`${where}: suppression without a QX-<n> ID`);
      else if (!ids.some((id) => registered.has(id))) {
        problems.push(`${where}: ${ids.join(", ")} not registered in ${cfg.qx.exemptions}`);
      }
    });
  }
  return problems;
}

const SECRET_PATTERNS = [
  ["private key", new RegExp(j("-----BEGIN [A-Z ]*PRIVATE ", "KEY-----"))],
  ["GitHub token", new RegExp(j("\\bgh[pousr]_", "[A-Za-z0-9]{36,}"))],
  ["GitHub token", new RegExp(j("\\bgithub_pat", "_[A-Za-z0-9_]{50,}"))],
  ["AWS access key", new RegExp(j("\\bAKI", "A[0-9A-Z]{16}\\b"))],
  ["Slack token", new RegExp(j("\\bxox[abprs]", "-[A-Za-z0-9-]{10,}"))],
  ["Stripe live key", new RegExp(j("\\b[sr]k_li", "ve_[A-Za-z0-9]{16,}"))],
  ["Anthropic key", new RegExp(j("\\bsk-an", "t-[A-Za-z0-9_-]{20,}"))],
  ["OpenAI key", new RegExp(j("\\bsk-pro", "j-[A-Za-z0-9_-]{20,}"))],
  ["Google API key", new RegExp(j("\\bAI", "za[0-9A-Za-z_-]{35}\\b"))],
  ["password in URL", new RegExp(j("\\b[a-z][a-z0-9+.-]*://[^/\\s:@'\"]+:[^/\\s:@'\"]+", "@[A-Za-z0-9.-]+"))],
  ["internal project ID", new RegExp(j("\\bpr", "j_[a-z0-9_]{3,}"))],
  ["private IP", /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
  ["email", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
];
// Addresses that are public by design.
const EMAIL_ALLOW = [
  /@(?:[\w-]+\.)*example\.(?:com|org|net)$/i,
  /@users\.noreply\.github\.com$/i,
  /^noreply@/i,
  /^no-reply@/i,
  /^git@github\.com$/i,
];
// Files that must never be tracked anywhere.
const FORBIDDEN_FILES = ["*.local.md", "*.local.json", ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa", "id_ed25519"];
const FORBIDDEN_FILE_ALLOW = [".env.example", ".env.sample", ".env.template"];

export function scanText(text, cfg, where) {
  const problems = [];
  const allow = cfg.leaks.allow.map((a) => new RegExp(a));
  const deny = cfg.localDeny || [];
  const patterns = SECRET_PATTERNS.map(([label, re]) => [label, new RegExp(re, "g")]);
  const allowed = (label, value) => (label === "email" && EMAIL_ALLOW.some((a) => a.test(value))) || allow.some((a) => a.test(value));
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [label, re] of patterns) {
      // Every match counts: an allowed value must not hide a real one beside it.
      if ([...line.matchAll(re)].some(([value]) => !allowed(label, value))) problems.push(`${where}:${i + 1}: ${label}`);
    }
    for (const value of deny) {
      if (value && line.toLowerCase().includes(String(value).toLowerCase())) {
        problems.push(`${where}:${i + 1}: operator-only value (pipeline.local.json)`);
      }
    }
  });
  return problems;
}

// Dependabot signs off every commit with this fixed, public address.
const DEPENDABOT_TRAILER = new RegExp(j("^Signed-off-by: dependabot\\[bot\\] <support", "@github\\.com>$"));
const DEPENDABOT_ID = 49699333;

// GitHub's record of a commit, or null when it cannot be read. The token is
// passed to gh alone: cleanEnv keeps it from the repo's own steps.
function githubCommit(root, sha) {
  const token = process.env.PIPELINE_GITHUB_TOKEN;
  const env = { ...cleanEnv(), ...(token ? { GH_TOKEN: token } : {}) };
  const r = spawnSync("gh", ["api", `repos/{owner}/{repo}/commits/${sha}`], { cwd: root, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// Names and emails prove nothing: anyone can set them, and GitHub links a
// commit to the account that owns its author email. The proof is that GitHub
// itself made and signed the commit, for the Dependabot account.
export function isDependabotCommit(c) {
  return c?.author?.id === DEPENDABOT_ID && c.author.type === "Bot" && c.committer?.login === "web-flow"
    && c.commit?.verification?.verified === true && c.commit.verification.reason === "valid";
}

// Only the sign-off line is left out, and only on a commit GitHub confirms.
// Anything else in that message is scanned. Line numbers stay as they were.
function scannedMessage(root, sha, fetchCommit) {
  const lines = commitMessage(root, sha).split(/\r?\n/);
  if (!lines.some((l) => DEPENDABOT_TRAILER.test(l)) || !isDependabotCommit(fetchCommit(root, sha))) return lines.join("\n");
  return lines.map((l) => (DEPENDABOT_TRAILER.test(l) ? "" : l)).join("\n");
}

export function checkLeaks(root, cfg, files = trackedFiles(root), commits = [], fetchCommit = githubCommit) {
  const problems = [];
  for (const file of files) {
    const name = basename(file);
    if (matchesAny(file, FORBIDDEN_FILES) && !FORBIDDEN_FILE_ALLOW.includes(name)) {
      problems.push(`${file}: this kind of file must never be tracked`);
      continue;
    }
    if (matchesAny(file, cfg.leaks.allowPaths)) continue;
    const text = readText(root, file);
    if (text != null) problems.push(...scanText(text, cfg, file));
  }
  for (const sha of commits) {
    problems.push(...scanText(scannedMessage(root, sha, fetchCommit), cfg, `commit ${sha.slice(0, 12)} message`));
  }
  return problems;
}

const CONVENTIONAL = /^(?:feat|fix|docs|chore|refactor|perf|test|build|ci|style|revert)(?:\([\w./,-]+\))?!?: \S/;
// git's own revert subject, kept so a plain `git revert` passes.
const GIT_REVERT = /^Revert "/;

export function checkCommitMessage(message) {
  const subject = message.split(/\r?\n/)[0];
  if (CONVENTIONAL.test(subject) || GIT_REVERT.test(subject)) return null;
  return `"${subject}" is not a Conventional Commit (type(scope)!: subject; types feat fix docs chore refactor perf test build ci style revert)`;
}

export function checkCommits(root, commits) {
  const problems = [];
  for (const sha of commits) {
    const problem = checkCommitMessage(commitMessage(root, sha));
    if (problem) problems.push(`${sha.slice(0, 12)}: ${problem}`);
  }
  return problems;
}

function firstInt(spec) {
  const m = String(spec || "").match(/\d+/);
  return m ? Number(m[0]) : null;
}

export function checkDeps(root, files = trackedFiles(root)) {
  const problems = [];
  const pkg = readJson(root, "package.json");
  if (!pkg) return ["package.json is missing; remove \"deps\" and \"audit\" from pipeline.json for a non-npm repo"];
  if (!files.includes("package-lock.json")) problems.push("package-lock.json is not committed");
  const lock = readJson(root, "package-lock.json");
  if (lock) {
    if (!(lock.lockfileVersion >= 2)) problems.push(`package-lock.json lockfileVersion ${lock.lockfileVersion}; regenerate with npm 7 or later`);
    const lockRoot = (lock.packages && lock.packages[""]) || {};
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, spec] of Object.entries(pkg[field] || {})) {
        const locked = (lockRoot[field] || {})[name];
        if (locked !== spec) problems.push(`package-lock.json is out of date: ${field}.${name} is "${spec}" in package.json, "${locked ?? "missing"}" in the lockfile`);
      }
    }
  }
  const typesSpec = (pkg.devDependencies || {})["@types/node"] || (pkg.dependencies || {})["@types/node"];
  if (typesSpec) {
    const engine = firstInt(pkg.engines && pkg.engines.node);
    const installed = lock && lock.packages && lock.packages["node_modules/@types/node"];
    const types = firstInt(installed ? installed.version : typesSpec);
    if (engine == null) problems.push("@types/node is a dependency but package.json has no engines.node");
    else if (types !== engine) problems.push(`@types/node major ${types} does not match engines.node major ${engine}`);
  }
  const dependabot = readText(root, ".github/dependabot.yml");
  if (!dependabot) problems.push(".github/dependabot.yml is missing (template: tools/pipeline/templates/dependabot.yml)");
  else {
    const ecosystems = (dependabot.match(/package-ecosystem:/g) || []).length;
    const days = [...dependabot.matchAll(/default-days:\s*(\d+)/g)].map((m) => Number(m[1]));
    if (days.length < ecosystems || days.some((d) => d < 7)) problems.push(".github/dependabot.yml: every update needs cooldown default-days of 7 or more");
  }
  return problems;
}

export function checkCiHosting(root, cfg, files = trackedFiles(root)) {
  if (cfg.selfHosted) return [];
  const problems = [];
  for (const file of files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))) {
    (readText(root, file) || "").split(/\r?\n/).forEach((line, i) => {
      if (/self-hosted/.test(line.replace(/#.*$/, ""))) problems.push(`${file}:${i + 1}: self-hosted runner (GitHub-hosted only; see PIPELINE.md "CI hosting")`);
    });
  }
  return problems;
}

const FRONTMATTER_KEYS = ["version", "purpose", "author_model", "created", "updated"];

export function checkFrontmatter(root, cfg, files = trackedFiles(root)) {
  const problems = [];
  for (const file of files.filter((f) => matchesAny(f, cfg.frontmatter))) {
    const text = (readText(root, file) || "").replace(/\r\n/g, "\n");
    const m = text.match(/^---\n([\s\S]*?)\n---\n/);
    if (!m) {
      problems.push(`${file}: no frontmatter`);
      continue;
    }
    const fields = Object.fromEntries(m[1].split("\n").map((l) => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean).map((x) => [x[1], x[2].trim()]));
    for (const key of FRONTMATTER_KEYS) if (!fields[key]) problems.push(`${file}: frontmatter needs "${key}"`);
    for (const key of ["created", "updated"]) {
      if (fields[key] && !/^\d{4}-\d{2}-\d{2}$/.test(fields[key])) problems.push(`${file}: ${key} must be yyyy-mm-dd`);
    }
    if (fields.created && fields.updated && fields.updated < fields.created) problems.push(`${file}: updated is before created`);
  }
  return problems;
}

const AGENT_FILES = ["CLAUDE.md", "AGENTS.md", "*.local.md", ".claude/**"];
const AGENT_IGNORES = ["CLAUDE.md", "AGENTS.md", "*.local.md", ".claude/"];

export function isPublic(cfg) {
  return cfg.public === true || cfg.public === "public-bound" || process.env.PIPELINE_REPO_PUBLIC === "true";
}

// Public and public-bound repos keep agent files local (repo-agent-template.md).
export function checkAgentFiles(root, cfg, files = trackedFiles(root)) {
  if (!isPublic(cfg)) return [];
  const problems = files.filter((f) => matchesAny(f, AGENT_FILES)).map((f) => `${f}: agent file tracked in a public repo; run git rm --cached ${f}`);
  const ignore = (readText(root, ".gitignore") || "").split(/\r?\n/).map((l) => l.trim());
  for (const entry of AGENT_IGNORES) if (!ignore.includes(entry)) problems.push(`.gitignore is missing "${entry}"`);
  return problems;
}

// ---------------------------------------------------------------- runner

export const BUILTINS = {
  qx: (ctx) => checkQx(ctx.root, ctx.cfg),
  leaks: (ctx) => checkLeaks(ctx.root, ctx.cfg, undefined, ctx.commits()),
  commits: (ctx) => checkCommits(ctx.root, ctx.commits()),
  deps: (ctx) => checkDeps(ctx.root),
  "ci-hosting": (ctx) => checkCiHosting(ctx.root, ctx.cfg),
  frontmatter: (ctx) => checkFrontmatter(ctx.root, ctx.cfg),
  "agent-files": (ctx) => checkAgentFiles(ctx.root, ctx.cfg),
  audit: (ctx) => (runShell(ctx.root, "npm audit --audit-level=moderate") === 0 ? [] : ["npm audit found moderate or higher advisories"]),
};

function runShell(cwd, command) {
  const r = spawnSync(command, { cwd, env: cleanEnv(), shell: true, stdio: "inherit" });
  return r.status ?? 1;
}

export function resolveSteps(root, cfg, stage) {
  const names = stage === "main" ? [...cfg.gate, ...cfg.main] : [...cfg.gate];
  const scripts = (readJson(root, "package.json") || {}).scripts || {};
  return names.map((name) => {
    if (cfg.commands[name]) return { name, kind: "command", run: cfg.commands[name] };
    if (BUILTINS[name]) return { name, kind: "builtin" };
    if (scripts[name]) return { name, kind: "npm", run: `npm run ${name}` };
    return { name, kind: "missing" };
  });
}

function fmt(seconds) {
  return `${seconds.toFixed(1)}s`;
}

export function runGate({ root, stage = "gate", only, range, configFile, log = console.log }) {
  const cfg = loadConfig(root, configFile);
  let steps = resolveSteps(root, cfg, stage);
  if (only) steps = steps.filter((s) => only.includes(s.name));
  let commits;
  const ctx = { root, cfg, commits: () => (commits ??= resolveRange(root, range)) };
  const results = [];
  const started = Date.now();
  for (const step of steps) {
    const t0 = Date.now();
    log(`\n▶ ${step.name}${step.run ? ` (${step.run})` : ""}`);
    let problems;
    try {
      if (step.kind === "missing") problems = [`"${step.name}" is configured in pipeline.json but is not a built-in, a command or an npm script`];
      else if (step.kind === "builtin") problems = BUILTINS[step.name](ctx);
      else problems = runShell(root, step.run) === 0 ? [] : [`${step.run} failed`];
    } catch (err) {
      problems = [err.message];
    }
    // Only a step that ran can warn; one that resolves to nothing still fails.
    const warn = problems.length > 0 && step.kind !== "missing" && cfg.warn.includes(step.name);
    for (const p of problems) log(`  ${warn ? "⚠" : "✖"} ${p}`);
    results.push({ name: step.name, ok: problems.length === 0 || warn, warn, seconds: (Date.now() - t0) / 1000 });
  }
  const total = (Date.now() - started) / 1000;
  log(`\n${stage} summary`);
  for (const r of results) log(`  ${r.warn ? "⚠" : r.ok ? "✔" : "✖"} ${r.name.padEnd(18)} ${fmt(r.seconds)}${r.warn ? "  (warn only)" : ""}`);
  log(`  total ${fmt(total)}`);
  if (stage === "gate" && total > GATE_BUDGET_SECONDS) log(`  ⚠ the gate took longer than ${GATE_BUDGET_SECONDS / 60} min; move slow steps to "main"`);
  return results.every((r) => r.ok);
}

// ---------------------------------------------------------------- pre-push hook

// Git passes "<local ref> <local sha> <remote ref> <remote sha>" lines on stdin.
// The gate tests the working tree, so the pushed commit must be HEAD with no
// uncommitted tracked changes.
export function hookRange(root, stdin) {
  const head = git(["rev-parse", "HEAD"], { cwd: root }).trim();
  const lines = stdin.split(/\r?\n/).filter(Boolean).map((l) => l.split(" "));
  const pushes = lines.filter(([, localSha]) => !ZERO_SHA.test(localSha));
  if (pushes.length === 0) return { skip: true };
  const other = pushes.find(([, localSha]) => localSha !== head);
  if (other) return { error: `pushing ${other[1].slice(0, 12)}, which is not HEAD; check it out and push from there so the gate tests what ships` };
  const [, localSha, , remoteSha] = pushes[0];
  return { range: `${remoteSha}..${localSha}` };
}

// core.hooksPath wins over .git/hooks; worktrees share the main repo's hooks.
export function hookPath(root) {
  const custom = git(["config", "core.hooksPath"], { cwd: root, allowFail: true });
  if (custom && custom.trim()) return resolve(root, custom.trim(), "pre-push");
  return resolve(root, git(["rev-parse", "--git-common-dir"], { cwd: root }).trim(), "hooks", "pre-push");
}

function readHook(abs) {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null; // no hook yet
  }
}

export function installHook(root, { force = false, script = "scripts/quality.mjs" } = {}) {
  const abs = hookPath(root);
  const current = readHook(abs);
  if (current !== null && !current.includes(HOOK_MARKER) && !force) {
    throw new Error(`${abs} exists and is not ours; pass --force to replace it`);
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `#!/bin/sh
# ${HOOK_MARKER} (installed by ${script} --install-hook)
# Skip only on the emergency fast path: git push --no-verify
exec node "$(git rev-parse --show-toplevel)/${script}" --hook "$@"
`);
  try {
    chmodSync(abs, 0o755);
  } catch {
    // Windows: Git for Windows runs hooks without the executable bit.
  }
  return abs;
}

function uninstallHook(root) {
  const abs = hookPath(root);
  if (readHook(abs)?.includes(HOOK_MARKER)) unlinkSync(abs);
  return abs;
}

// ---------------------------------------------------------------- cli

function parseArgs(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    opt[argv[i].slice(2)] = next && !next.startsWith("--") && argv[i] !== "--hook" ? argv[++i] : true;
  }
  return opt;
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const script = relative(root, resolve(process.argv[1])).replace(/\\/g, "/");
  if (opt["install-hook"]) {
    console.log(`installed ${installHook(root, { force: !!opt.force, script })}`);
    return 0;
  }
  if (opt["uninstall-hook"]) {
    console.log(`removed ${uninstallHook(root)}`);
    return 0;
  }
  const stage = opt.stage || "gate";
  if (!["gate", "main"].includes(stage)) throw new Error("--stage takes gate or main");
  const configFile = typeof opt.config === "string" ? resolve(opt.config) : undefined;
  if (opt.list) {
    for (const s of resolveSteps(root, loadConfig(root, configFile), stage)) console.log(`${s.name.padEnd(18)} ${s.kind}${s.run ? `  ${s.run}` : ""}`);
    return 0;
  }
  let range = opt.range || process.env.PIPELINE_COMMIT_RANGE;
  if (opt.hook) {
    const hook = hookRange(root, await readStdin());
    if (hook.skip) return 0;
    if (hook.error) throw new Error(hook.error);
    const dirty = git(["status", "--porcelain", "--untracked-files=no"], { cwd: root }).trim();
    if (dirty) throw new Error("uncommitted tracked changes: the gate would test code you are not pushing. Commit or stash them first.");
    range = hook.range;
  }
  const only = typeof opt.only === "string" ? opt.only.split(",") : null;
  const ok = runGate({ root, stage, only, range, configFile });
  if (!ok) console.log(opt.hook ? "\npre-push gate failed: push refused. Fix the problems above (emergency fast path: git push --no-verify, and record it)." : "\nfailed");
  return ok ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`quality: ${err.message}`);
      process.exit(1);
    },
  );
}
