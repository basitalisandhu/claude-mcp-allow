# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | yes |

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability") rather than a public issue. Include the version, the settings and MCP configuration that reproduce the problem (with secrets removed) and what you expected to happen.

You will get an acknowledgement within 7 days and a fix or a mitigation plan within 30 days for confirmed issues. Credit is given in the release notes unless you prefer otherwise.

## Scope

claude-mcp-allow reads MCP server definitions, starts or connects to those servers with the command, environment and headers you configured, calls `tools/list`, and writes permission rules into Claude Code settings files. Issues of interest include:

- A rule it writes that is broader than one tool on one server (any `mcp__*`, `mcp__<server>__*` or other glob), or an `allow` rule for a tool that did not report `readOnlyHint: true` without `--heuristic`.
- `--check` reporting no drift when a tool's annotations changed, a tool disappeared, or an allowed tool is no longer read-only.
- Removal or alteration of settings keys or rules the tool did not write.
- Environment variable expansion that sends a credential somewhere the configuration did not name, including the credential variables that Claude Code reads as empty in a remote server's `url` and `headers`.
- Path handling for `--cwd`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_PLUGIN_CACHE_DIR` and plugin `installPath` values.
- Dependency vulnerabilities in `@modelcontextprotocol/sdk`.

What is not a vulnerability in this tool: a server that lies in its annotations. Annotations are hints supplied by the server, and the README says why the tool never auto-allows a tool that is not marked read-only. Running the tool starts every configured stdio server, exactly as Claude Code does; review your configuration before running it against servers you do not trust.
