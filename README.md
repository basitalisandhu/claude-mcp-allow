# claude-mcp-allow: least-privilege Claude Code permission rules for MCP tools

Generate `permissions.allow` and `permissions.ask` rules for every MCP tool Claude Code can reach, from the annotations each server reports on `tools/list`: a tool that says `readOnlyHint: true` (and not `destructiveHint: true`) gets an `allow` rule, everything else gets an `ask` rule, one exact `mcp__<server>__<tool>` rule per tool and never a glob. `--write` merges the rules into the settings file you choose, `--diff` shows what would change, and `--check` reconnects later and exits 1 when a server's annotations have drifted from the rules you saved.

Part of [Masoon](https://github.com/basitalisandhu/masoon) ([docs](https://basitalisandhu.github.io/masoon/)), open-source trust infrastructure for AI agents: who they are, what they may touch, and proof of what they did.

[![CI](https://github.com/basitalisandhu/claude-mcp-allow/actions/workflows/ci.yml/badge.svg)](https://github.com/basitalisandhu/claude-mcp-allow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 20+](https://img.shields.io/badge/node-20%2B-blue.svg)](package.json)

## The problem

Claude Code asks before every MCP tool call unless a permission rule covers it. Its permission engine does not read MCP tool annotations: the request to auto-allow `readOnlyHint` tools and keep prompting for `destructiveHint` ones ([anthropics/claude-code#87452](https://github.com/anthropics/claude-code/issues/87452)) was closed as not planned, and on Claude Code on the web the connector prompt offers only "Allow once", so read-only tools ask on every call and unattended runs stall ([anthropics/claude-code#99112](https://github.com/anthropics/claude-code/issues/99112)). The [permissions docs](https://code.claude.com/docs/en/permissions) give you the rule syntax (`mcp__<server>`, `mcp__<server>__<tool>`, and `mcp__<server>__*` only after a literal server prefix) and leave the rule writing to you. So people hand-roll hooks that guess by verb, or allow a whole server, or keep clicking.

This tool writes the rules for you, from what the servers themselves report, and tells you when that report changes.

## Security model

Annotations are untrusted hints. The MCP project's own [guidance on tool annotations](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/) is that every annotation property is a hint and clients must treat them as untrusted unless the server is trusted, and that many servers ship without them. This tool therefore never auto-allows a tool that is not marked read-only: without annotations a tool goes to `ask`, a tool with `destructiveHint: true` goes to `ask` even when it also claims `readOnlyHint: true`, and a tool whose `tools/list` entry carries `_meta["anthropic/requiresUserInteraction"]: true` goes to `ask` regardless, because Claude Code prompts for it on every call even when an allow rule matches. `--heuristic` is opt-in, allows only unannotated tools whose name starts with a read verb and a separator (`get_`, `list-`, `search_` and so on), and is recorded in the file so `--check` applies the same judgement later. Every rule is one tool on one server; the tool never emits `mcp__*` or `mcp__<server>__*`, never touches `deny` rules or rules it did not write, and records the decision and a SHA-256 of each tool's annotations next to the rules, so `--check` can detect drift: an annotation that changed, a tool that disappeared, or an allowed tool that would no longer be allowed. Running the tool starts every configured stdio server with its configured command, environment and arguments, exactly as Claude Code would; review your configuration before running it against servers you do not trust.

## Install

Requires Node 20 or newer.

```bash
npx claude-mcp-allow                 # run without installing
npm install -g claude-mcp-allow      # or install the command
```

npm publication is pending; until the first release, run it from a clone:

```bash
git clone https://github.com/basitalisandhu/claude-mcp-allow && cd claude-mcp-allow
npm install && npm run build
node dist/cli.js --help
```

## Usage

```text
claude-mcp-allow [--cwd dir] [--scope local|project|user] [--heuristic] [--write] [--diff] [--check] [--server name] [--timeout ms]
```

| Flag | What it does |
|---|---|
| `--cwd <dir>` | The project directory. Defaults to the current directory. `.mcp.json`, `.claude/settings.json` and the `projects[<dir>]` entry of `~/.claude.json` are read relative to it. |
| `--scope local\|project\|user` | Which settings file `--write`, `--diff` and `--check` use: `.claude/settings.local.json` (default; at the git repository root when the directory is inside one, as Claude Code does), `.claude/settings.json`, or `~/.claude/settings.json`. |
| `--heuristic` | Also allow unannotated tools whose name matches `^(get\|list\|read\|search\|find\|fetch\|describe\|show\|query\|count\|lookup)[_-]`. Annotated tools are never affected. |
| `--write` | Merge the proposed rules into the settings file for `--scope`. Existing keys, key order, indentation and every rule the tool did not write are preserved. |
| `--diff` | Print the rules `--write` would add and remove, as `+ allow`, `+ ask`, `- allow` and `- ask` lines. Combine with `--write` to see and apply in one run. |
| `--check` | Reconnect to every server recorded in the settings file, recompute the annotation hashes, and exit 1 on drift. Requires a file written by `--write`. |
| `--server <name>` | Only this server. Repeatable. Matches the configured name, `plugin:<plugin>:<server>` for plugin servers, or the server segment of the rule. |
| `--timeout <ms>` | Per-server limit for connecting and for `tools/list`. Default 20000. |
| `-h`, `--help`, `-V`, `--version` | The usual. |

Exit codes: 0 success, 1 drift found by `--check`, 2 usage or configuration error (an unknown flag, a settings file that is not valid JSON, `--check` without a marker).

The proposed `permissions` block is printed on stdout as JSON; the per-server report, warnings and the `wrote` line go to stderr, so `claude-mcp-allow > rules.json` captures only the block.

### Where servers are read from

The tool reads the same places Claude Code does, in the documented precedence, and tells you where each server came from. When one name is defined in several places, the highest-precedence definition wins and the others are reported as shadowed. Plugin servers are matched against the others by endpoint (URL or command), as the docs describe.

| Precedence | Source | File |
|---|---|---|
| 1 | local scope | `~/.claude.json`, `projects["<cwd>"].mcpServers` |
| 2 | project scope | `<cwd>/.mcp.json` |
| 3 | user scope | `~/.claude.json`, top-level `mcpServers` |
| 4 | enabled plugins | `.mcp.json` at each plugin root and `mcpServers` in its `.claude-plugin/plugin.json`, found through `~/.claude/plugins/installed_plugins.json` and `enabledPlugins` in your settings files |

Servers your organisation provides through managed settings and connectors fetched from claude.ai are not read. `CLAUDE_CONFIG_DIR` moves `~/.claude` (settings and plugins; `.claude.json` is read from there when it exists) and `CLAUDE_CODE_PLUGIN_CACHE_DIR` moves the plugins root. Servers listed in `disabledMcpjsonServers` or `disabledMcpServers` are skipped. `${VAR}` and `${VAR:-default}` are expanded in `command`, `args`, `env`, `url` and `headers`; an unset variable without a default is left as written with a warning, and the credential variables Claude Code reads as empty in a remote server's `url` and `headers` (such as `ANTHROPIC_API_KEY` and `NPM_TOKEN`) are read as empty here too. `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` and `${CLAUDE_PROJECT_DIR}` are expanded for plugin servers.

Tools from a plugin-bundled server get rules in the form Claude Code uses for them, `mcp__plugin_<plugin>_<server>__<tool>`, with any character outside `A-Z`, `a-z`, `0-9`, `_` and `-` replaced by `_`.

### What is skipped, and why

- Entries with an `oauth` key, and remote servers that answer 401 or 403: Claude Code completes the sign-in through `/mcp`; this tool does not run OAuth flows. Each one is named in a warning.
- `ws` and `sdk` transports, and entries with neither `command` nor `url`.
- Plugin entries that reference `${user_config.*}`, which this tool does not resolve.
- A server that fails to start or does not answer within `--timeout` is reported as failed, and the rest continue.

### What `--write` puts in the file

Rules are appended to `permissions.allow` and `permissions.ask`, and a sibling key records what was generated:

```json
"claudeMcpAllow": {
  "generatedBy": "claude-mcp-allow 0.1.0",
  "generatedAt": "2026-10-03T22:38:08.944Z",
  "heuristic": false,
  "servers": {
    "annotated": {
      "get_user": "allow:cd6fc3f14d1a476831d8b3ad5283d55120abdc84f8fdff6a2b040e092f81afcc",
      "delete_item": "ask:8c2fe572a84b307ba8332b68b40a6b8ccb02f58b7b81e61943e7ac03862756fd"
    }
  }
}
```

Each value is the decision and the SHA-256 of the tool's annotations plus its `requiresUserInteraction` flag (the description and schema are not hashed, so wording changes do not count as drift). On the next `--write`, rules recorded here are replaced by the new result; rules you wrote by hand stay, and the tool warns when a hand-written `allow` covers a tool it classified `ask` (the `ask` rule is evaluated first and prompts). An `allow` rule for a tool that appears in `permissions.deny` is not added, because deny rules win. The published settings schema accepts additional top-level keys, so the marker does not make the file invalid.

`--check` reads this key, reconnects to each recorded server (or the ones you name with `--server`) and reports `drift` when a hash differs, a tool is no longer listed, an allowed tool would not be allowed now, a recorded server is no longer configured, or a server cannot be reached; it reports `info` for new tools that are not covered yet and for hand-written allow rules on `ask` tools. Exit 1 on any `drift`.

## Sample output

A project with two fixture servers from this repository in `.mcp.json` (one annotated, one not) and a user-scope server that needs OAuth, from `npx claude-mcp-allow` with no flags:

```text
annotated  (project, .mcp.json)  7 tools: 2 allow, 5 ask
  allow  get_user       readOnlyHint is true
  allow  list_items     readOnlyHint is true
  ask    delete_item    destructiveHint is true
  ask    update_item    annotated but not marked read-only
  ask    read_and_wipe  destructiveHint is true (readOnlyHint is also true; the destructive hint wins)
  ask    grant_access   _meta["anthropic/requiresUserInteraction"] is true; Claude Code prompts on every call
  ask    get_status     no annotations
unannotated  (project, .mcp.json)  15 tools: 0 allow, 15 ask
  ask    get_weather      no annotations
  ask    list_files       no annotations
  ask    search_docs      no annotations
  ask    fetch-url        no annotations
  ask    lookup_user      no annotations
  ask    count_rows       no annotations
  ask    show-status      no annotations
  ask    query_db         no annotations
  ask    getdata          no annotations
  ask    send_email       no annotations
  ask    delete_all       no annotations
  ask    update_record    no annotations
  ask    run_job          no annotations
  ask    get_consent      _meta["anthropic/requiresUserInteraction"] is true; Claude Code prompts on every call
  ask    get_string_flag  no annotations
docs  (user, ~/.claude.json)  skipped: entry has oauth; sign in with /mcp in Claude Code, this tool does not run OAuth flows

{
  "permissions": {
    "allow": [
      "mcp__annotated__get_user",
      "mcp__annotated__list_items"
    ],
    "ask": [
      "mcp__annotated__delete_item",
      "mcp__annotated__get_status",
      "mcp__annotated__grant_access",
      "mcp__annotated__read_and_wipe",
      "mcp__annotated__update_item",
      "mcp__unannotated__count_rows",
      "mcp__unannotated__delete_all",
      "mcp__unannotated__fetch-url",
      "mcp__unannotated__get_consent",
      "mcp__unannotated__get_string_flag",
      "mcp__unannotated__get_weather",
      "mcp__unannotated__getdata",
      "mcp__unannotated__list_files",
      "mcp__unannotated__lookup_user",
      "mcp__unannotated__query_db",
      "mcp__unannotated__run_job",
      "mcp__unannotated__search_docs",
      "mcp__unannotated__send_email",
      "mcp__unannotated__show-status",
      "mcp__unannotated__update_record"
    ]
  }
}
```

With `--heuristic --server unannotated`, read verbs with a separator are allowed; `getdata` has no separator, `send_email` is not a read verb, and `get_consent` requires a person:

```text
unannotated  (project, .mcp.json)  15 tools: 9 allow, 6 ask
  allow  get_weather      no annotations; name starts with a read verb (--heuristic)
  allow  list_files       no annotations; name starts with a read verb (--heuristic)
  allow  search_docs      no annotations; name starts with a read verb (--heuristic)
  allow  fetch-url        no annotations; name starts with a read verb (--heuristic)
  allow  lookup_user      no annotations; name starts with a read verb (--heuristic)
  allow  count_rows       no annotations; name starts with a read verb (--heuristic)
  allow  show-status      no annotations; name starts with a read verb (--heuristic)
  allow  query_db         no annotations; name starts with a read verb (--heuristic)
  ask    getdata          no annotations; name is not a read verb
  ask    send_email       no annotations; name is not a read verb
  ask    delete_all       no annotations; name is not a read verb
  ask    update_record    no annotations; name is not a read verb
  ask    run_job          no annotations; name is not a read verb
  ask    get_consent      _meta["anthropic/requiresUserInteraction"] is true; Claude Code prompts on every call
  allow  get_string_flag  no annotations; name starts with a read verb (--heuristic)
```

`--write --diff` against a `.claude/settings.local.json` that already allowed `Bash(npm test)` (the proposed block is printed first and is omitted here):

```text
Diff against .claude/settings.local.json:
+ allow mcp__annotated__get_user
+ allow mcp__annotated__list_items
+ ask   mcp__annotated__delete_item
+ ask   mcp__annotated__get_status
+ ask   mcp__annotated__grant_access
+ ask   mcp__annotated__read_and_wipe
+ ask   mcp__annotated__update_item
+ ask   mcp__unannotated__count_rows
...
+ ask   mcp__unannotated__update_record
wrote .claude/settings.local.json: +2/-0 allow, +20/-0 ask
```

The file afterwards starts with the rule that was already there:

```json
{
  "permissions": {
    "allow": [
      "Bash(npm test)",
      "mcp__annotated__get_user",
      "mcp__annotated__list_items"
    ],
    "ask": [
      "mcp__annotated__delete_item",
```

`--check` straight away, then again after the annotated server was changed to report `readOnlyHint: false` for `get_user` (the fixture does this when `FIXTURE_DRIFT=flip` is set):

```text
$ npx claude-mcp-allow --check
ok: no drift against .claude/settings.local.json

$ FIXTURE_DRIFT=flip npx claude-mcp-allow --check
drift  annotated: annotations of get_user changed; it is allowed but is no longer read-only (annotated but not marked read-only)
1 drift finding(s) against .claude/settings.local.json
```

The second run exits 1, which is what you want from a CI job or a pre-commit hook that guards a committed `.claude/settings.json`.

## Frequently asked questions

**Why does Claude Code still prompt for a tool that has an allow rule?**
Four documented reasons. A tool whose `tools/list` entry sets `_meta["anthropic/requiresUserInteraction"]` to `true` prompts on every call, in every mode, and allow rules do not skip it; this tool puts such tools in `ask` so the file matches the behaviour. Rules are evaluated deny, then ask, then allow, first match wins, so an `ask` rule from any settings file (yours, the project's, or your organisation's) prompts even when a more specific `allow` rule also matches. `permissions.allow` rules in a project's `.claude/settings.json` only apply after you accept the workspace trust dialog for that folder. And when your organisation has set a claude.ai connector tool to `ask`, allow rules for that tool do not take effect. Run `/permissions` in Claude Code to see every rule and the file it comes from.

**Can I trust `readOnlyHint`?**
Only as far as you trust the server. Annotations are declared by the server and nothing checks them; a server can call a tool read-only and still write. That is why the default never allows a tool that is not marked read-only, why `--heuristic` is a separate choice, and why `--check` exists: once you have reviewed and saved the rules, a server that later changes a tool's annotations, drops a tool, or starts claiming something different fails the check instead of silently widening what runs without a prompt. Treat the generated `allow` list the way you would treat a dependency lockfile: review it when it changes.

**Why one rule per tool instead of `mcp__<server>__*`?**
The wildcard form is valid and Claude Code accepts it after a literal server prefix, but it allows every tool the server has now and every tool it adds later, including a destructive one shipped in a future version. One exact rule per tool keeps the allowlist readable in review, lets `--diff` show exactly which capability a change adds, and lets `--check` reason about each tool's own annotations. Unanchored globs such as `mcp__*` are skipped by Claude Code with a warning and never auto-approve anything, so the tool never writes them either.

**Which settings file should the rules go in, and can I commit it?**
`local` (the default) writes `.claude/settings.local.json`, your personal file for this project, which Claude Code keeps out of git when it creates the file; if you created it by hand, add it to `.gitignore` yourself. `project` writes `.claude/settings.json`, which you commit so teammates get the same rules, and which is the file to guard with `--check` in CI. `user` writes `~/.claude/settings.json`, which applies to every project on your machine; rules for project-scoped servers rarely belong there. Whatever the file, a `deny` rule from any settings file still wins over an `allow` rule from another.

## Development

```bash
npm install
npm test            # builds, then runs vitest against the fixture servers in a temporary home directory
npm run typecheck
```

The suite starts the two stdio fixtures (`tests/fixtures/annotated-server.mjs`, `tests/fixtures/unannotated-server.mjs`) and a Streamable HTTP fixture that requires a bearer token, inside a fake home directory with servers in every scope, and compares output against the golden files in `tests/golden/`. Regenerate the goldens with `UPDATE_GOLDEN=1 npm test` and review the diff. See [CONTRIBUTING.md](CONTRIBUTING.md), [docs/good-first-issues.md](docs/good-first-issues.md) and [SECURITY.md](SECURITY.md).

## Sibling projects

- [masoon](https://github.com/basitalisandhu/masoon): the platform front door, with the [docs site](https://basitalisandhu.github.io/masoon/).
- [agent-security-skills](https://github.com/basitalisandhu/agent-security-skills): Claude Code plugin and agentskills-compatible skill pack for agent security reviews.
- [mcp-tools-lint](https://github.com/basitalisandhu/mcp-tools-lint): lint an MCP server's `tools/list` for schema dialect, annotation and naming problems before a client rejects it.
- [agent-threat-model](https://github.com/basitalisandhu/agent-threat-model): threat modeling for AI agents from a YAML description.

## Licence

MIT, see [LICENSE](LICENSE). Copyright 2026 Muhammad Basit Ali.
