#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck, CheckError } from './check.js';
import { buildPlan, classifyTools } from './classify.js';
import { loadServers, resolvePaths } from './config.js';
import { listServerTools } from './connect.js';
import { SettingsError, mergeIntoSettings, readSettingsFile, settingsPathFor, writeSettingsFile } from './settings.js';
import type { Plan, ResolvedServer, Scope, ServerReport } from './types.js';

export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

const USAGE = `Usage: claude-mcp-allow [options]

Generate least-privilege Claude Code permission rules for MCP tools from the
annotations each configured server reports, and detect drift later.

Options:
  --cwd <dir>        Project directory (default: current directory)
  --scope <scope>    Settings file to write or check: local (default), project, user
  --heuristic        Allow unannotated tools whose name starts with a read verb
  --write            Merge the rules into the settings file for --scope
  --diff             Print rules that --write would add and remove
  --prune            With --write/--diff, remove marked rules for absent servers
  --check            Reconnect and exit 1 when annotations drifted from the saved rules
  --server <name>    Only this server (repeatable)
  --timeout <ms>     Connect and tools/list timeout per server (default: 20000)
  -h, --help         Show this help
  -V, --version      Show the version

Exit codes: 0 success, 1 drift found by --check, 2 usage or configuration error.
`;

export interface CliOptions {
  cwd: string;
  scope: Scope;
  heuristic: boolean;
  write: boolean;
  diff: boolean;
  prune: boolean;
  check: boolean;
  servers: string[];
  timeoutMs: number;
  help: boolean;
  version: boolean;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    cwd: process.cwd(),
    scope: 'local',
    heuristic: false,
    write: false,
    diff: false,
    prune: false,
    check: false,
    servers: [],
    timeoutMs: 20000,
    help: false,
    version: false,
  };
  const takeValue = (i: number, flag: string): string => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    const inline = arg.startsWith('--') && eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = (): string => {
      if (inline !== undefined) return inline;
      const v = takeValue(i, flag);
      i++;
      return v;
    };
    switch (flag) {
      case '--cwd':
        opts.cwd = path.resolve(value());
        break;
      case '--scope': {
        const scope = value();
        if (scope !== 'local' && scope !== 'project' && scope !== 'user') {
          throw new UsageError(`--scope must be local, project or user (got "${scope}")`);
        }
        opts.scope = scope;
        break;
      }
      case '--heuristic':
        opts.heuristic = true;
        break;
      case '--write':
        opts.write = true;
        break;
      case '--diff':
        opts.diff = true;
        break;
      case '--prune':
        opts.prune = true;
        break;
      case '--check':
        opts.check = true;
        break;
      case '--server':
        opts.servers.push(value());
        break;
      case '--timeout': {
        const ms = Number(value());
        if (!Number.isFinite(ms) || ms <= 0) throw new UsageError('--timeout must be a positive number of milliseconds');
        opts.timeoutMs = ms;
        break;
      }
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '-V':
      case '--version':
        opts.version = true;
        break;
      default:
        throw new UsageError(`unknown argument "${arg}"`);
    }
  }
  if (opts.prune && (opts.check || (!opts.write && !opts.diff))) {
    throw new UsageError('--prune requires --write or --diff and cannot be used with --check');
  }
  return opts;
}

function matchesFilter(server: ResolvedServer, names: string[]): boolean {
  return names.length === 0 || names.includes(server.name) || names.includes(server.displayName) || names.includes(server.ruleServer);
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Show a path relative to the project or the home directory where that is shorter. */
export function displayPath(file: string, cwd: string, home: string): string {
  const rel = path.relative(cwd, file);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  if (file === home || file.startsWith(home + path.sep)) return '~' + file.slice(home.length);
  return file;
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function printReport(plan: Plan, log: (line: string) => void): void {
  for (const report of plan.reports) {
    const head = `${report.server.displayName}  (${report.server.origin}, ${report.server.source})`;
    if (report.status !== 'listed') {
      log(`${head}  ${report.status}: ${report.reason ?? ''}`);
      continue;
    }
    const allow = report.tools.filter((t) => t.decision === 'allow').length;
    log(`${head}  ${report.tools.length} tools: ${allow} allow, ${report.tools.length - allow} ask`);
    const width = Math.max(0, ...report.tools.map((t) => t.name.length));
    for (const tool of report.tools) {
      log(`  ${pad(tool.decision, 5)}  ${pad(tool.name, width)}  ${tool.reason}`);
    }
    for (const warning of report.server.warnings) log(`  warning: ${warning}`);
  }
}

export async function main(argv: string[], io = { out: process.stdout, err: process.stderr }): Promise<number> {
  const log = (line: string) => io.err.write(line + '\n');
  const print = (line: string) => io.out.write(line + '\n');
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    log(`claude-mcp-allow: ${(err as Error).message}`);
    io.err.write(USAGE);
    return 2;
  }
  if (opts.help) {
    io.out.write(USAGE);
    return 0;
  }
  if (opts.version) {
    print(VERSION);
    return 0;
  }

  const home = os.homedir();
  const env = process.env;
  const paths = resolvePaths({ cwd: opts.cwd, home, env });
  const loaded = loadServers({ cwd: opts.cwd, home, env });
  for (const warning of loaded.warnings) log(`warning: ${warning}`);
  if (opts.prune && loaded.warnings.length > 0) {
    log('claude-mcp-allow: refusing --prune because configuration could not be loaded completely');
    return 2;
  }
  for (const { server, by } of loaded.shadowed) {
    log(`note: ${server.displayName} from ${server.source} is shadowed by the ${by.origin} definition (${by.source})`);
  }
  for (const s of loaded.skipped) log(`warning: ${s.name} (${s.origin}, ${s.source}) skipped: ${s.reason}`);

  const servers = loaded.servers.filter((s) => matchesFilter(s, opts.servers));
  for (const name of opts.servers) {
    if (!loaded.servers.some((s) => matchesFilter(s, [name]))) log(`warning: --server ${name} matches no configured server`);
  }
  const settingsPath = settingsPathFor(opts.scope, { cwd: paths.cwd, home, configDir: paths.configDir, platform: process.platform });
  const shownPath = displayPath(settingsPath, paths.cwd, home);
  const connect = { timeoutMs: opts.timeoutMs, env, cwd: paths.cwd, clientVersion: VERSION };

  if (opts.check) {
    let settings;
    try {
      settings = readSettingsFile(settingsPath);
    } catch (err) {
      log(`claude-mcp-allow: ${(err as Error).message}`);
      return 2;
    }
    try {
      const only = opts.servers.length > 0 ? new Set(servers.map((s) => s.ruleServer)) : undefined;
      const result = await runCheck({
        settings,
        servers: loaded.servers,
        only,
        heuristic: opts.heuristic ? true : undefined,
        connect,
      });
      for (const f of result.findings) print(`${f.level === 'drift' ? 'drift' : 'info '}  ${f.server}: ${f.message}`);
      const drift = result.findings.filter((f) => f.level === 'drift').length;
      print(drift === 0 ? `ok: no drift against ${shownPath}` : `${drift} drift finding(s) against ${shownPath}`);
      return result.ok ? 0 : 1;
    } catch (err) {
      if (err instanceof CheckError) {
        log(`claude-mcp-allow: ${err.message.replace(settingsPath, shownPath)}`);
        return 2;
      }
      throw err;
    }
  }

  if (servers.length === 0) {
    log(`claude-mcp-allow: no MCP servers configured for ${paths.cwd}`);
  }
  const reports = await mapLimit(servers, 4, async (server): Promise<ServerReport> => {
    const result = await listServerTools(server, connect);
    if (result.status !== 'listed') return { server, status: result.status, reason: result.reason, tools: [] };
    return { server, status: 'listed', tools: classifyTools(server.ruleServer, result.tools, { heuristic: opts.heuristic }) };
  });
  const plan = buildPlan(reports, opts.heuristic);
  printReport(plan, log);
  log('');
  print(JSON.stringify({ permissions: { allow: plan.allow, ask: plan.ask } }, null, 2));

  if (opts.diff || opts.write) {
    let settings;
    try {
      settings = readSettingsFile(settingsPath);
    } catch (err) {
      log(`claude-mcp-allow: ${(err as Error).message}`);
      return 2;
    }
    let merged;
    try {
      merged = mergeIntoSettings(settings, {
        plan, now: new Date().toISOString(), version: VERSION, prune: opts.prune,
        configuredServers: [
          ...loaded.servers.map((s) => s.ruleServer),
          ...loaded.shadowed.map((s) => s.server.ruleServer),
          ...loaded.skipped.map((s) => s.ruleServer),
        ],
      });
    } catch (err) {
      if (err instanceof SettingsError) {
        log(`claude-mcp-allow: ${err.message}`);
        return 2;
      }
      throw err;
    }
    for (const warning of merged.warnings) log(`warning: ${warning}`);
    if (opts.diff) {
      print('');
      print(`Diff against ${shownPath}${settings.exists ? '' : ' (file does not exist yet)'}:`);
      const lines: string[] = [];
      for (const rule of merged.removed.allow) lines.push(`- allow ${rule}`);
      for (const rule of merged.removed.ask) lines.push(`- ask   ${rule}`);
      for (const rule of merged.added.allow) lines.push(`+ allow ${rule}`);
      for (const rule of merged.added.ask) lines.push(`+ ask   ${rule}`);
      if (lines.length === 0) lines.push('(no rule changes)');
      for (const line of lines) print(line);
    }
    if (opts.write) {
      for (const item of merged.pruned) log(`pruned ${item.server}: ${item.rules} rules`);
      if (merged.changed || !settings.exists) {
        writeSettingsFile(settings, merged.text);
        log(
          `wrote ${shownPath}: +${merged.added.allow.length}/-${merged.removed.allow.length} allow, +${merged.added.ask.length}/-${merged.removed.ask.length} ask`,
        );
      } else {
        log(`${shownPath} is already up to date`);
      }
    }
  }
  return 0;
}

function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    // argv[1] is a symlink under node_modules/.bin when installed through npm
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`claude-mcp-allow: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
      process.exitCode = 2;
    },
  );
}
