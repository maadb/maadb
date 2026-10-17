# Security policy

## Supported versions

MAADb is pre-1.0. Security fixes are released as a new patch version of the latest release line only. Upgrade to the latest `@maadb/core` release to receive them.

| Version | Supported |
|---|---|
| Latest release | Yes |
| Anything older | No |

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public issue, pull request or discussion.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**, or go directly to <https://github.com/maadb/maadb/security/advisories/new>. Only the maintainers can see the report.

Please include:

- the `@maadb/core` version, Node.js version and operating system
- the transport in use (stdio or HTTP) and any relevant configuration
- steps or a minimal project that reproduces the issue
- what an attacker can achieve, and what access they need first

## What to expect

- We aim to acknowledge a report within 5 business days.
- We will confirm whether it is a vulnerability, agree on its severity with you, and keep you updated in the private advisory.
- Fixes ship as a patch release with a published GitHub security advisory. We credit reporters who want to be credited.
- Please give us a reasonable chance to release a fix before disclosing the issue publicly.

## Scope

In scope: the MAADb engine, its MCP server and HTTP transport, the `maad` CLI, and the published `@maadb/core` package.

Vulnerabilities in a dependency belong with that project. If you believe one affects MAADb in practice, report it here too so we can assess it and update the dependency.
