# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-10-28

### Added

- Runs without a token: `npx github:basitalisandhu/claude-mcp-allow` fetches the source and builds it on install (a `prepare` script). The Quick start uses it; the GitHub Packages npm package still needs a `read:packages` token.
- A Troubleshooting section in the README with real messages and fixes.
- Seeded fuzz tests over every configuration and settings file the CLI reads (bad bytes, wrong value types), each run time-limited; a scaling test for the settings merge; a CI job that installs the packed tarball into an empty folder, runs the three quick start commands against the annotated fixture server and compares the README sample.

### Fixed

- Merging a large plan into a settings file was quadratic (`Array.includes` inside the merge loops): 20,000 tools took about 0.85 s, now about 15 ms.

### Added

- Honour `deniedMcpServers` from user, project, local and managed settings: a server matched by name, by command and arguments, or by a URL without `*` is skipped as `blocked by deniedMcpServers`, including organisation-managed servers. `serverUrl` entries containing `*` are not evaluated yet and each one is named in a warning.

## [0.3.0] - 2026-10-16

### Added

- Load organisation-provided MCP servers from the platform `managed-mcp.json` and `managedMcpServers` setting with managed precedence and origin reporting.
- `--managed-dir <dir>` reads `managed-mcp.json` and `managed-settings.json` from a folder instead of the platform policy directory, so a policy can be previewed before it is deployed.
- README: a quick start and sample report on the first screen, and an "Organisation-managed servers" section with a worked policy example.

### Changed

- `managedMcpServers` entries containing control or invisible formatting characters in any key or value are refused, as Claude Code refuses them, and the Claude Desktop array form of the setting is reported in a warning instead of being ignored silently.

### Fixed

- `--check --server <name>` for a server that is recorded in the settings file but no longer configured reported `ok` and exited 0; it now reports the server as drift and exits 1.

## [0.2.0] - 2026-10-09

### Added

- Add explicit `--write --prune` and read-only `--diff --prune` for generated rules whose servers are no longer configured. Preserve manual rules and configured servers even when filtered, disabled or unavailable.

## [0.1.1] - 2026-10-06

### Changed

- Removed the umbrella branding; this project stands alone and links its sibling repositories directly.

## [0.1.0] - 2026-10-04

First release. Published to two registries on GitHub Packages, using only the workflow's `GITHUB_TOKEN`:

- npm (`https://npm.pkg.github.com`): `@basitalisandhu/claude-mcp-allow`. The package is scoped because GitHub Packages requires the owner's scope; the unscoped name `claude-mcp-allow` is not published anywhere yet.
- GitHub Container Registry: `ghcr.io/basitalisandhu/claude-mcp-allow`, tagged `0.1.0` and `latest`, for linux/amd64 and linux/arm64, with an SPDX SBOM, a build provenance attestation and a keyless cosign signature.

### Added

- `publish-github-packages.yml`: on a `v*` tag, builds and tests, publishes the npm package to GitHub Packages (skipping a version that already exists), builds, pushes, attests and signs the image, and creates the GitHub release with the SBOM attached. Pull requests that touch packaging run it as a dry run.
- A `Dockerfile` on a digest-pinned `node:22-alpine` with only the runtime dependencies, running the CLI as the non-root `node` user with `/work` as the working directory, and a CI job that builds it and runs it.

- `claude-mcp-allow` CLI: loads MCP server definitions from `.mcp.json`, `~/.claude.json` (user and local scope) and enabled plugins, applies the documented precedence, connects to each stdio, HTTP and SSE server with its expanded `command`, `args`, `env` and `headers`, and calls `tools/list`.
- Classification from live annotations: `readOnlyHint: true` without `destructiveHint: true` goes to `allow`; everything else goes to `ask`; `_meta["anthropic/requiresUserInteraction"]: true` always goes to `ask`.
- `--heuristic` to allow unannotated tools whose name starts with a read verb and a separator.
- `--write` to merge rules into `.claude/settings.local.json`, `.claude/settings.json` or `~/.claude/settings.json` while preserving key order, indentation and unrelated rules, with a `claudeMcpAllow` marker recording each tool's decision and annotation hash.
- `--diff` to print the rules a write would add and remove, and `--check` to reconnect and exit 1 on drift.
- Skips servers that declare `oauth` or answer 401 or 403, with a warning naming them.
- Rule names for plugin servers in the `mcp__plugin_<plugin>_<server>__<tool>` form.
- Test suite with two stdio fixture servers, a Streamable HTTP fixture, a fake home directory and golden files; CI on Node 20 and 22; release workflow with npm provenance.

### Changed

- Package renamed to `@basitalisandhu/claude-mcp-allow`; the command is still `claude-mcp-allow`.
- `release.yml` (npmjs.com) runs only when the repository variable `NPMJS_PUBLISH` is `true` and passes `--registry https://registry.npmjs.org`.
- Renamed the umbrella project from Hisar to Masoon; links, names and identifiers updated.

[Unreleased]: https://github.com/basitalisandhu/claude-mcp-allow/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/basitalisandhu/claude-mcp-allow/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/basitalisandhu/claude-mcp-allow/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/basitalisandhu/claude-mcp-allow/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/basitalisandhu/claude-mcp-allow/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/basitalisandhu/claude-mcp-allow/releases/tag/v0.1.0
