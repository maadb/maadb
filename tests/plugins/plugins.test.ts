// ============================================================================
// Claude Code plugins in plugins/ — static checks on the manifests, then the
// real built engine (dist/cli.js) driven through each plugin's own MCP
// config, the way Claude Code would launch or connect to it.
//
// All temp state lives under os.tmpdir(); nothing is written in the repo.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { simpleGit } from 'simple-git';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { TokenStore } from '../../src/auth/token-store.js';
import { TOOL_ANNOTATIONS } from '../../src/mcp/annotations.js';

const REPO = path.resolve(__dirname, '../..');
const CLI = path.join(REPO, 'dist', 'cli.js');
const FIXTURE_SRC = path.join(REPO, 'tests', 'fixtures', 'simple-crm');

interface UserOption { type: string; required?: boolean; sensitive?: boolean; default?: unknown; options?: string[] }
interface PluginManifest { name: string; userConfig?: Record<string, UserOption> }
interface McpEntry { type: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }
interface Marketplace { name: string; owner: { name: string }; plugins: Array<{ name: string; source: string }> }

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const marketplace = readJson<Marketplace>(path.join(REPO, '.claude-plugin', 'marketplace.json'));
const pluginDir = (name: string) => path.join(REPO, 'plugins', name);
const manifest = (name: string) => readJson<PluginManifest>(path.join(pluginDir(name), '.claude-plugin', 'plugin.json'));
const mcpServer = (name: string) => readJson<{ mcpServers: Record<string, McpEntry> }>(path.join(pluginDir(name), '.mcp.json')).mcpServers.maadb!;

/** Substitute ${user_config.KEY} the way Claude Code does at launch. */
function fill(value: string, config: Record<string, string>): string {
  return value.replace(/\$\{user_config\.([A-Za-z0-9_]+)\}/g, (_, key: string) => {
    const v = config[key];
    if (v === undefined) throw new Error(`no value for user_config.${key}`);
    return v;
  });
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? filesUnder(full) : [full];
  });
}

// ---- Static checks ---------------------------------------------------------

describe('plugin manifests', () => {
  it('marketplace lists both plugins and each source has a matching manifest', () => {
    expect(marketplace.name).toBe('maadb');
    expect(marketplace.owner.name).toBeTruthy();
    expect(marketplace.plugins.map(p => p.name).sort()).toEqual(['maadb', 'maadb-remote']);
    for (const entry of marketplace.plugins) {
      expect(entry.source).toBe(`./plugins/${entry.name}`);
      expect(manifest(entry.name).name).toBe(entry.name);
      expect(existsSync(path.join(pluginDir(entry.name), '.mcp.json'))).toBe(true);
    }
  });

  it('plugin versions match the package version', () => {
    const pkg = readJson<{ version: string }>(path.join(REPO, 'package.json'));
    for (const { name } of marketplace.plugins) expect(readJson<{ version?: string }>(path.join(pluginDir(name), '.claude-plugin', 'plugin.json')).version, name).toBe(pkg.version);
  });

  it('remote plugin points at the published privacy note', () => {
    const url = readJson<{ privacyPolicyUrl?: string }>(path.join(pluginDir('maadb-remote'), '.claude-plugin', 'plugin.json')).privacyPolicyUrl;
    expect(url).toBe('https://github.com/maadb/maadb/blob/main/plugins/PRIVACY.md');
    expect(existsSync(path.join(REPO, 'plugins', 'PRIVACY.md'))).toBe(true);
  });

  it('every ${user_config.*} reference is declared, and required options have no default', () => {
    for (const { name } of marketplace.plugins) {
      const declared = manifest(name).userConfig ?? {};
      const raw = readFileSync(path.join(pluginDir(name), '.mcp.json'), 'utf8');
      const used = [...raw.matchAll(/\$\{user_config\.([A-Za-z0-9_]+)\}/g)].map(m => m[1]!);
      expect(used.length).toBeGreaterThan(0);
      for (const key of used) expect(declared[key], `${name}: user_config.${key}`).toBeDefined();
      for (const key of Object.keys(declared)) expect(used, `${name}: ${key} declared but unused`).toContain(key);
      for (const [key, opt] of Object.entries(declared)) {
        if (opt.required) expect(opt.default, `${name}.${key}`).toBeUndefined();
        if (opt.options && opt.default !== undefined) expect(opt.options).toContain(opt.default);
      }
    }
  });

  it('local plugin runs the published package against the chosen folder only', () => {
    const server = mcpServer('maadb');
    expect(server.type).toBe('stdio');
    expect(server.command).toBe('npx');
    expect(server.args).toContain('--package=@maadb/core@latest');
    const args = server.args!;
    expect(args[args.indexOf('--project') + 1]).toBe('${user_config.project_dir}');
    expect(manifest('maadb').userConfig?.project_dir?.type).toBe('directory');
    expect(manifest('maadb').userConfig?.role?.options).toEqual(['reader', 'writer', 'admin']);
    // A folder that was cloned or restored has no index yet; build it at boot.
    expect(server.env).toEqual({ MAAD_BOOT_REINDEX: '1' });
  });

  it('remote plugin sends the token as a bearer header and keeps it in the keychain', () => {
    const server = mcpServer('maadb-remote');
    expect(server.type).toBe('http');
    expect(server.url).toBe('${user_config.url}');
    expect(server.headers).toEqual({ Authorization: 'Bearer ${user_config.token}' });
    expect(manifest('maadb-remote').userConfig?.token?.sensitive).toBe(true);
  });

  it('ships no credentials, hosts or addresses', () => {
    const files = [path.join(REPO, '.claude-plugin', 'marketplace.json'), ...filesUnder(path.join(REPO, 'plugins'))];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/maad_pat_[0-9a-f]{8,}/);
      expect(text, file).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
      expect(text, file).not.toMatch(/https?:\/\/(?!github\.com\/maadb\/maadb)[^\s)"'`]+/);
    }
  });

  it('both plugins carry the same skill with valid frontmatter', () => {
    const local = readFileSync(path.join(pluginDir('maadb'), 'skills', 'maadb', 'SKILL.md'), 'utf8');
    const remote = readFileSync(path.join(pluginDir('maadb-remote'), 'skills', 'maadb', 'SKILL.md'), 'utf8');
    expect(remote).toBe(local);
    const front = /^---\n([\s\S]*?)\n---\n/.exec(local.replace(/\r\n/g, '\n'))?.[1] ?? '';
    expect(front).toMatch(/^name: maadb$/m);
    const description = /^description: (.+)$/m.exec(front)?.[1] ?? '';
    expect(description.length).toBeGreaterThan(20);
    expect(description.length).toBeLessThanOrEqual(1536);
    // Every tool the skill names exists.
    for (const tool of local.match(/maad_[a-z_]+/g) ?? []) expect(TOOL_ANNOTATIONS[tool], tool).toBeDefined();
  });
});

// ---- Live engine -----------------------------------------------------------

const haveDist = existsSync(CLI);
if (!haveDist && process.env.CI) throw new Error('dist/cli.js missing: run npm run build before the plugin tests');

async function copyFixture(dest: string): Promise<void> {
  cpSync(FIXTURE_SRC, dest, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}_backend`) && !src.includes(`${path.sep}.git`),
  });
  const git = simpleGit(dest);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'test');
  await git.add('.').commit('fixture');
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function parseResult(res: unknown): { ok: boolean; data?: Record<string, unknown>; errors?: unknown[] } {
  const content = (res as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]!.text);
}

async function expectAnnotatedTools(client: Client): Promise<void> {
  const { tools } = await client.listTools();
  expect(tools.length).toBeGreaterThan(10);
  for (const tool of tools) {
    expect(tool.annotations?.title, tool.name).toBe(TOOL_ANNOTATIONS[tool.name]?.title);
    expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe('boolean');
    expect(typeof tool.annotations?.destructiveHint, tool.name).toBe('boolean');
  }
}

describe.skipIf(!haveDist)('maadb plugin (stdio) against the built engine', () => {
  let root: string;
  let client: Client;

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'maad-plugin-stdio-'));
    const project = path.join(root, 'crm');
    await copyFixture(project);

    // Launch exactly what the plugin declares, with the npx package swap for
    // the local build: `npx -y --package=@maadb/core@latest maad <rest>`.
    const server = mcpServer('maadb');
    const args = server.args!.map(a => fill(a, { project_dir: project, role: 'writer' }));
    const rest = args.slice(args.indexOf('maad') + 1);
    client = new Client({ name: 'plugin-test', version: '0.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [CLI, ...rest], cwd: root, stderr: 'ignore',
      env: { ...(process.env as Record<string, string>), ...server.env },
    }));
  }, 60_000);

  afterAll(async () => {
    await client?.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  });

  it('lists annotated tools for the writer role', async () => {
    await expectAnnotatedTools(client);
    const { tools } = await client.listTools();
    const names = tools.map(t => t.name);
    expect(names).toContain('maad_create');
    expect(names).not.toContain('maad_bulk_delete'); // admin-only
  });

  it('reads and writes records', async () => {
    const summary = parseResult(await client.callTool({ name: 'maad_summary', arguments: {} }));
    expect(summary.ok).toBe(true);

    const created = parseResult(await client.callTool({
      name: 'maad_create',
      arguments: { docType: 'client', fields: { name: 'Plugin Test Co', status: 'active' }, docId: 'cli-plugin-test' },
    }));
    expect(created.ok, JSON.stringify(created.errors)).toBe(true);

    const got = parseResult(await client.callTool({ name: 'maad_get', arguments: { docId: 'cli-plugin-test' } }));
    expect(got.ok).toBe(true);
    expect(JSON.stringify(got.data)).toContain('Plugin Test Co');
  });
});

describe.skipIf(!haveDist)('maadb-remote plugin (HTTP) against the built engine', () => {
  let root: string;
  let child: ChildProcess;
  let url: string;
  let token: string;
  const clients: Client[] = [];

  async function connect(withToken: string): Promise<Client> {
    const server = mcpServer('maadb-remote');
    const config = { url, token: withToken };
    const headers = Object.fromEntries(Object.entries(server.headers!).map(([k, v]) => [k, fill(v, config)]));
    const client = new Client({ name: 'plugin-test', version: '0.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(fill(server.url!, config)), { requestInit: { headers } }));
    return client;
  }

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'maad-plugin-http-'));
    await copyFixture(path.join(root, 'crm'));
    writeFileSync(path.join(root, 'instance.yaml'), 'name: plugin-test\nprojects:\n  - name: crm\n    path: ./crm\n    role: writer\n');
    const store = await TokenStore.load(root);
    if (!store.ok) throw new Error('TokenStore.load failed');
    const issued = await store.value.issue({ role: 'writer', projects: [{ name: 'crm' }], name: 'plugin-test' });
    if (!issued.ok) throw new Error('issue failed');
    token = issued.value.plaintext;

    // The operator builds the index before serving (see plugins/README.md).
    await new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, [CLI, 'reindex', '--project', path.join(root, 'crm')], { cwd: root, stdio: 'ignore' });
      p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`reindex exited ${code}`))));
    });

    const port = await freePort();
    url = `http://127.0.0.1:${port}/mcp`;
    child = spawn(process.execPath, [
      CLI, '--instance', path.join(root, 'instance.yaml'),
      'serve', '--transport', 'http', '--http-host', '127.0.0.1', '--http-port', String(port),
    ], { cwd: root, stdio: 'ignore' });

    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break;
      } catch { /* not up yet */ }
      if (Date.now() > deadline) throw new Error('engine did not start');
      await new Promise(r => setTimeout(r, 200));
    }
  }, 60_000);

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => {});
    child?.kill();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  });

  it('refuses a wrong token', async () => {
    await expect(connect('maad_pat_00000000000000000000000000000000')).rejects.toThrow();
  });

  it('connects with the plugin header, binds the project and reads', async () => {
    const client = await connect(token);
    await expectAnnotatedTools(client);

    const projects = parseResult(await client.callTool({ name: 'maad_projects', arguments: {} }));
    expect(projects.ok).toBe(true);
    expect(JSON.stringify(projects.data)).toContain('crm');

    const bound = parseResult(await client.callTool({ name: 'maad_use_project', arguments: { name: 'crm' } }));
    expect(bound.ok, JSON.stringify(bound.errors)).toBe(true);

    const query = parseResult(await client.callTool({ name: 'maad_query', arguments: { docType: 'client', limit: 5 } }));
    expect(query.ok, JSON.stringify(query.errors)).toBe(true);
  });
});
