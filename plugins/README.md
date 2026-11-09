# MAADB plugins for Claude Code

Two plugins let Claude Code use a MAADB engine directly. Both add the `maad_*` MCP tools and a `maadb` skill that teaches the read-and-write workflow.

| Plugin | Use it when | How it connects |
|---|---|---|
| `maadb` | The project folder is on your computer | Starts `@maadb/core` from npm over stdio |
| `maadb-remote` | You run a MAADB engine on a server | Streamable HTTP with a MAADB bearer token |

Every tool carries a title and read-only / destructive hints, so Claude Code can ask before it deletes or overwrites anything.

## Install

Requires Claude Code and, for `maadb`, Node.js 24.22.1 or later (the engine's `engines` floor).

1. Add this repository as a plugin marketplace:

   ```
   /plugin marketplace add maadb/maadb
   ```

2. Install one plugin:

   ```
   /plugin install maadb@maadb
   ```

   or

   ```
   /plugin install maadb-remote@maadb
   ```

3. Answer the prompts (see below), then restart Claude Code.
4. Check the connection with `/mcp`. The server is listed as `plugin:maadb:maadb` or `plugin:maadb-remote:maadb`.

From a shell, the same steps are `claude plugin marketplace add maadb/maadb` and `claude plugin install maadb@maadb`.

## `maadb`: local project

Prompts:

- **MAADB project folder**: absolute path to the project (the folder with `_registry/` and `_schema/`). The engine reads and writes only inside this folder. For a new, empty project, create the folder first; Claude can design the schema with you.
- **Role**: `reader`, `writer` (default) or `admin`. Admin adds reindex, backup and cleanup tools.

The plugin runs `npx -y --package=@maadb/core@<plugin version> maad serve --project <folder> --role <role>`. It sets `MAAD_BOOT_REINDEX=1`, so a folder that has records but no index yet (a fresh clone or restore) is indexed when the engine starts.

## `maadb-remote`: engine you host

On the server:

1. Run the engine in HTTP mode with an `instance.yaml` (see [Remote / hosted deployment](../README.md#remote--hosted-deployment) and [docs/deploy](../docs/deploy/)). If a project already has records, build its index first with `maad reindex --project <path>`.
2. Issue a token for the person or agent that will connect, limited to the projects and role they need:

   ```bash
   maad auth issue-token --role=writer --name=<who> --projects=<project>
   ```

   The plaintext `maad_pat_...` token is printed once.
3. Put the engine behind HTTPS if Claude Code is not on the same machine.

Prompts in Claude Code:

- **MAADB MCP URL**: the full endpoint, ending in `/mcp`.
- **MAADB token**: the `maad_pat_...` token. Claude Code stores it in your system keychain, not in a settings file.

An HTTP engine serves one or more projects. Claude lists them with `maad_projects` and binds the session with `maad_use_project` before reading or writing.

## Change the settings

Uninstall and reinstall the plugin to answer the prompts again.

## Privacy

See [PRIVACY.md](PRIVACY.md). The plugins send nothing to the MAADB maintainers.

## For maintainers

- The plugin `version` in each `.claude-plugin/plugin.json`, and the `@maadb/core@<version>` pin in `plugins/maadb/.mcp.json`, match `package.json`. Bump them in the release PR; Claude Code only offers an update when the version changes.
- Tool titles and hints live in `src/mcp/annotations.ts`. A new tool fails to register until it has an entry there.
- `tests/plugins/plugins.test.ts` checks the manifests and drives the built engine through both plugin configs. Run `npm run build` first.
- `claude plugin validate . --strict` checks the marketplace; run it on each plugin folder too.
