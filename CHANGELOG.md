# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-03

### Added

- `claude-mcp-allow` CLI: loads MCP server definitions from `.mcp.json`, `~/.claude.json` (user and local scope) and enabled plugins, applies the documented precedence, connects to each stdio, HTTP and SSE server with its expanded `command`, `args`, `env` and `headers`, and calls `tools/list`.
- Classification from live annotations: `readOnlyHint: true` without `destructiveHint: true` goes to `allow`; everything else goes to `ask`; `_meta["anthropic/requiresUserInteraction"]: true` always goes to `ask`.
- `--heuristic` to allow unannotated tools whose name starts with a read verb and a separator.
- `--write` to merge rules into `.claude/settings.local.json`, `.claude/settings.json` or `~/.claude/settings.json` while preserving key order, indentation and unrelated rules, with a `claudeMcpAllow` marker recording each tool's decision and annotation hash.
- `--diff` to print the rules a write would add and remove, and `--check` to reconnect and exit 1 on drift.
- Skips servers that declare `oauth` or answer 401 or 403, with a warning naming them.
- Rule names for plugin servers in the `mcp__plugin_<plugin>_<server>__<tool>` form.
- Test suite with two stdio fixture servers, a Streamable HTTP fixture, a fake home directory and golden files; CI on Node 20 and 22; release workflow with npm provenance.

[Unreleased]: https://github.com/basitalisandhu/claude-mcp-allow/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/basitalisandhu/claude-mcp-allow/releases/tag/v0.1.0
