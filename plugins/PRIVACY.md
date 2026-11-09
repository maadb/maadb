# MAADB plugins: privacy

The `maadb` and `maadb-remote` Claude Code plugins collect nothing and send nothing to the MAADB project or its maintainers.

- **maadb** starts a MAADB engine on your computer. It reads and writes only the project folder you choose at install.
- **maadb-remote** connects to the MAADB engine URL you enter at install. Requests go only to that engine, which you or your organization run. Its operator's own policies apply to the data it holds.
- Your MAADB token is stored by Claude Code in your system keychain. It is sent only to the engine URL you entered, as an `Authorization` header.
- The plugins contain no analytics or telemetry.

What Claude does with the tool results is covered by the terms and privacy policy of the Claude product you use.

Questions: open an issue at https://github.com/maadb/maadb/issues.
