# Release Checklist

Run through this before every version release.

## Code

- [ ] `npm run build` — dist matches source
- [ ] `npx tsc --noEmit` — clean type check
- [ ] `npm test` — all tests pass
- [ ] No `.maad-tmp` files left in any test fixture

## Permissions

- [ ] MCP role gating verified (reader can't write, writer can't delete)
- [ ] Path containment checks work (no sibling path escape)
- [ ] Read-only mode blocks writes
- [ ] Dry-run mode returns preview without executing

## Failure paths

- [ ] Write failure leaves journal entry (reconciled on restart)
- [ ] Index failure after write returns explicit recovery hint
- [ ] Git failure is logged with severity, not silently swallowed
- [ ] Scan rejects paths outside project root

## Documentation

- [ ] README.md reflects current commands and tool count
- [ ] FRAMEWORK.md reflects current tier model
- [ ] Version.md updated with new version entry
- [ ] package.json version bumped
- [ ] MAAD.md generator includes all current commands
- [ ] No stale spec files in project root (check for MAAD-TOOLS.md etc.)

## Bulk operations

- [ ] `bulk_create` returns verification block with sampled IDs
- [ ] `bulk_update` returns verification block with sampled IDs
- [ ] Verification catches a deliberate field mismatch in test

## Deployment

- [ ] `node dist/cli.js --help` shows all commands and env vars
- [ ] MCP server starts: `maad serve --project <dir> --role reader`
- [ ] MCP server starts with env vars: `MAAD_PROJECT=<dir> MAAD_ROLE=reader maad serve`
- [ ] MCP server reports correct version from package.json
- [ ] MCP tools/list returns correct count for each role
- [ ] At least one tool call succeeds via MCP protocol
- [ ] Git tag created: `git tag v<version>`
- [ ] Pushed: `git push && git push origin v<version>`
