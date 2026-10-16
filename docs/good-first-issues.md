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

## 2. Report tools whose names contradict their annotations

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

## 3. Support `headersHelper` for HTTP servers

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

## 4. Skip servers matched by `deniedMcpServers`

**Context.** Claude Code never loads a server that matches a `deniedMcpServers` entry from
any settings file, managed servers included
([docs](https://code.claude.com/docs/en/managed-mcp#how-a-server-is-evaluated)). This tool
still connects to such a server and writes rules for it. `src/config.ts` already reads the
settings files in `readSettingsSummary`.

**Acceptance criteria.**

- `deniedMcpServers` entries are merged from user, project, local and managed settings.
- A server matching a `serverName` entry exactly, a `serverCommand` entry (command and
  arguments, exact and in order) or a `serverUrl` entry with no `*` is skipped with the
  reason `blocked by deniedMcpServers`. Entries with `*` produce one warning saying they are
  not evaluated yet.
- Tests in `tests/config.test.ts` cover each entry kind and a managed server being denied.

