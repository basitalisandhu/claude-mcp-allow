# Contributing

Thanks for considering a contribution. The project is small on purpose: load server definitions, connect, classify, merge, check. Most useful contributions are coverage of configuration shapes the loader does not handle yet, more precise drift reporting, and documentation fixes against the current Claude Code docs.

## Set up

Requires Node 20 or newer.

```bash
git clone https://github.com/basitalisandhu/claude-mcp-allow
cd claude-mcp-allow
npm install
npm test            # builds first, then runs vitest
```

`npm run build` compiles `src/` to `dist/`; `npm run typecheck` runs the compiler without emitting. The tests spawn `dist/cli.js` against the fixture servers in `tests/fixtures/` inside a temporary home directory, so nothing on your machine is read or written.

## Before you open a pull request

- `npm test` passes on Node 20 and 22 (CI runs both).
- New behaviour has a test. Golden files under `tests/golden/` are regenerated with `UPDATE_GOLDEN=1 npm test`; review the diff before committing it.
- Behaviour that mirrors Claude Code (file locations, precedence, rule syntax, expansion) cites the page of the Claude Code docs it follows, in the pull request or in a code comment.
- Add a line under `Unreleased` in `CHANGELOG.md`.

## Style

- TypeScript strict mode, ESM, no runtime dependencies beyond `@modelcontextprotocol/sdk`.
- No model names or vendor identifiers in the repository.
- Plain language in messages: say what happened, which server or tool it concerns, and what to do next.
- Deterministic output: rules are sorted, hashes are canonical, and the only timestamp is `generatedAt` in the marker.
- Never widen a rule. If a change would emit anything other than `mcp__<server>__<tool>`, it is wrong.

## Reporting security issues

See [SECURITY.md](SECURITY.md).
