# Good first issues

Issues the maintainer intends to open under the `good first issue` label, written out so
they can be filed in one sitting. Each is self-contained and has acceptance criteria that
`npm test` can verify. Read [CONTRIBUTING.md](../CONTRIBUTING.md) first: TypeScript strict
mode, no new runtime dependencies, a test for every behaviour, and never a rule wider than
`mcp__<server>__<tool>`.

## 1. Add `--format json` for the report

**Context.** The per-server report (status, tools, decisions, reasons, hashes) is printed
as text on stderr, and only the `permissions` block is machine-readable on stdout. Dashboards
and audits want the whole report as one JSON document.

**Acceptance criteria.**

- `claude-mcp-allow --format json` prints `{ "servers": [...], "permissions": {...} }` on
  stdout and nothing else there; each server entry carries `name`, `displayName`,
  `ruleServer`, `origin`, `source`, `status`, `reason` and a `tools` array with `name`,
  `decision`, `reason`, `hash` and `rule`. `--format text` is the current behaviour and the
  default.
- `--check --format json` prints `{ "ok": boolean, "findings": [...] }` with the same
  `level`, `server` and `message` fields as the text output.
- Tests in `tests/cli.test.ts` parse both documents and assert the shape; the text goldens
  are unchanged.

## 2. Read `managed-mcp.json` servers

**Context.** `src/config.ts` reads local, project, user and plugin servers. Claude Code also
loads servers an organisation deploys through `managed-mcp.json` and the
`managedMcpServers` setting, which rank above every other scope. Rules for those tools are
currently never generated.

**Acceptance criteria.**

- Servers from the managed MCP file for the platform (see the Claude Code docs page on
  managed MCP for the paths) and from `managedMcpServers` in a managed settings file are
  loaded with `origin: "managed"`, placed first in precedence, and matched by name against
  the other scopes as the docs describe.
- A fixture under the fake home exercises one managed server shadowing a user server.
- README "Where servers are read from" lists the new source; `managed` is added to the
  `ServerOrigin` type and to the report output.

## 3. Report tools whose names contradict their annotations

**Context.** A tool named `delete_user` with `readOnlyHint: true` is suspicious: either the
annotation is wrong or the name is. The tool currently allows it, as the brief requires, but
says nothing.

**Acceptance criteria.**

- A new warning in the report for a tool that is classified `allow` and whose name matches
  `^(create|add|insert|update|set|put|patch|delete|remove|drop|send|post|publish|write|execute|run|deploy|move|rename)[_-]`.
  The rule is still emitted; the decision does not change.
- `--strict-names` (off by default) moves such tools to `ask` instead and says so in the
  reason.
- Tests in `tests/classify.test.ts` and one CLI test with a fixture tool named
  `delete_but_readonly`.

## 4. Support `headersHelper` for HTTP servers

**Context.** Claude Code can run a `headersHelper` command whose stdout provides headers for
an `http` or `sse` server. The loader copies the field but `src/connect.ts` ignores it, so
servers that only authenticate through a helper are reported as answering 401.

**Acceptance criteria.**

- When an entry has `headersHelper`, run it with the environment Claude Code documents for
  helpers (`CLAUDE_CODE_MCP_SERVER_NAME`, `CLAUDE_CODE_MCP_SERVER_URL`), parse its stdout as a
  JSON object of headers, and merge it over `headers` before connecting. A helper that fails
  or prints something that is not a JSON object produces a `failed` status with the reason.
- Never run a helper from a plugin entry that references `${user_config.*}` (already skipped).
- A test with a helper script under `tests/fixtures/` against the HTTP fixture.

## 5. Add a `--prune` flag for servers that no longer exist

**Context.** When a server is removed from every configuration file, the rules and marker
entries this tool wrote for it stay in the settings file and `--check` reports the server as
no longer configured. The merge deliberately never removes them, because user-scope settings
can hold servers from other projects.

**Acceptance criteria.**

- `--write --prune` removes the `allow` and `ask` rules and the marker entry for every
  server recorded in the marker that is not configured for the current `--cwd`, and prints
  one `pruned <server>: N rules` line per server on stderr. Without `--prune` nothing changes.
- `--diff --prune` lists those removals as `- allow` and `- ask` lines.
- Rules the tool did not write (not in the marker) are never removed, even for a pruned
  server.
- Tests in `tests/settings.test.ts` and `tests/cli.test.ts`, including the user-scope case
  where a server from another project must survive a run without `--prune`.
