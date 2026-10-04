import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ClassifiedTool, Decision, Plan, ResolvedServer, ServerReport } from '../src/types.js';
import { annotationHash, ruleFor } from '../src/classify.js';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const FIXTURES = path.join(ROOT, 'tests', 'fixtures');
export const GOLDEN = path.join(ROOT, 'tests', 'golden');
export const CLI = path.join(ROOT, 'dist', 'cli.js');
export const ANNOTATED = path.join(FIXTURES, 'annotated-server.mjs');
export const UNANNOTATED = path.join(FIXTURES, 'unannotated-server.mjs');

export function tempDir(prefix = 'claude-mcp-allow-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeJson(file: string, data: unknown, indent: string | number = 2): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, indent) + '\n');
}

export function readJson<T = Record<string, unknown>>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

/** Environment for a spawned CLI: the real PATH, a fake HOME, no config overrides. */
export function cliEnv(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_PLUGIN_CACHE_DIR', 'FIXTURE_DRIFT', 'FIXTURE_EXTRA_TOOL', 'EXTRA_TOOL', 'LOCAL_DRIFT']) {
    delete env[key];
  }
  return { ...env, HOME: home, FIXTURE_DIR: FIXTURES, ...extra };
}

export interface FakeEnv {
  root: string;
  home: string;
  project: string;
  pluginRoot: string;
  cleanup(): void;
}

export interface FakeEnvOptions {
  localSettings?: Record<string, unknown>;
  userSettings?: Record<string, unknown>;
  projectSettings?: Record<string, unknown>;
}

/**
 * A fake home directory and project with servers in every scope:
 *  - project `.mcp.json`: `annotated`, `shared` (unannotated fixture), `disabled-one`
 *  - user `~/.claude.json`: `unannotated`, `shared` (annotated fixture; shadowed), `oauth-remote`
 *  - local `~/.claude.json` projects[project]: `local-only` (annotated fixture)
 *  - plugin `db-tools@demo-market`: server `database` (annotated fixture via ${CLAUDE_PLUGIN_ROOT})
 *  - plugin `off-plugin@demo-market`: disabled in user settings
 */
export function makeFakeEnv(opts: FakeEnvOptions = {}): FakeEnv {
  const root = tempDir();
  const home = path.join(root, 'home');
  const project = path.join(home, 'code', 'app');
  const pluginRoot = path.join(home, '.claude', 'plugins', 'cache', 'demo-market', 'db-tools', '1.0.0');
  const offRoot = path.join(home, '.claude', 'plugins', 'cache', 'demo-market', 'off-plugin', '1.0.0');
  mkdirSync(project, { recursive: true });
  mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  mkdirSync(offRoot, { recursive: true });

  writeJson(path.join(project, '.mcp.json'), {
    mcpServers: {
      annotated: {
        type: 'stdio',
        command: 'node',
        args: ['${FIXTURE_DIR}/annotated-server.mjs'],
        env: { FIXTURE_EXTRA_TOOL: '${EXTRA_TOOL:-get_default}' },
      },
      shared: { command: 'node', args: [UNANNOTATED] },
      'disabled-one': { command: 'node', args: [UNANNOTATED] },
    },
  });
  writeJson(path.join(home, '.claude.json'), {
    mcpServers: {
      unannotated: { command: 'node', args: [UNANNOTATED] },
      shared: { command: 'node', args: [ANNOTATED] },
      'oauth-remote': { type: 'http', url: 'https://mcp.example.com/mcp', oauth: { clientId: 'demo' } },
    },
    projects: {
      [project]: {
        mcpServers: {
          'local-only': { command: 'node', args: [ANNOTATED], env: { FIXTURE_DRIFT: '${LOCAL_DRIFT:-}' } },
        },
      },
    },
  });
  writeJson(path.join(home, '.claude', 'settings.json'), {
    enabledPlugins: { 'db-tools@demo-market': true, 'off-plugin@demo-market': false },
    ...(opts.userSettings ?? {}),
  });
  if (opts.projectSettings) writeJson(path.join(project, '.claude', 'settings.json'), opts.projectSettings);
  writeJson(path.join(project, '.claude', 'settings.local.json'), opts.localSettings ?? {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    permissions: {
      deny: ['Read(./.env)'],
      allow: ['Bash(npm test)', 'mcp__annotated__delete_item'],
    },
    enabledMcpjsonServers: ['annotated', 'shared'],
    disabledMcpjsonServers: ['disabled-one'],
  });
  writeJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'db-tools@demo-market': [{ scope: 'user', installPath: pluginRoot, version: '1.0.0' }],
      'off-plugin@demo-market': { scope: 'user', installPath: offRoot, version: '1.0.0' },
    },
  });
  writeJson(path.join(pluginRoot, '.mcp.json'), {
    mcpServers: { database: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/server.mjs'] } },
  });
  writeJson(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), { name: 'db-tools', version: '1.0.0' });
  writeFileSync(path.join(pluginRoot, 'server.mjs'), `import ${JSON.stringify(pathToFileURL(ANNOTATED).href)};\n`);
  writeJson(path.join(offRoot, '.mcp.json'), { mcpServers: { hidden: { command: 'node', args: ['nope.mjs'] } } });

  return { root, home, project, pluginRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function runCli(args: string[], env: FakeEnv, extraEnv: Record<string, string> = {}, cwd = env.project): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile('node', [CLI, '--cwd', cwd, ...args], { cwd, env: cliEnv(env.home, extraEnv), timeout: 60000 }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : error ? 1 : 0;
      if (process.env.DEBUG_CLI) console.log(`$ claude-mcp-allow ${args.join(' ')} -> ${code}\n${stdout}${stderr}`);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Compare with a golden file; `UPDATE_GOLDEN=1` rewrites it. */
export function expectGolden(name: string, actual: string): string {
  const file = path.join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN || !existsSync(file)) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, actual);
    return actual;
  }
  return readFileSync(file, 'utf8');
}

export function normalizeGeneratedAt(text: string): string {
  return text.replace(/"generatedAt": "[^"]+"/, '"generatedAt": "2026-10-03T00:00:00.000Z"');
}

export function fakeServer(ruleServer: string, origin: ResolvedServer['origin'] = 'project'): ResolvedServer {
  return { name: ruleServer, ruleServer, displayName: ruleServer, origin, source: 'test', config: { command: 'x' }, warnings: [] };
}

export function fakeTool(ruleServer: string, name: string, decision: Decision, annotations?: Record<string, unknown>): ClassifiedTool {
  const tool = { name, annotations };
  return { ...tool, decision, reason: 'test', hash: annotationHash(tool), rule: ruleFor(ruleServer, name) };
}

/** Build a Plan from `{ server: { tool: decision } }`. */
export function fakePlan(spec: Record<string, Record<string, Decision>>, heuristic = false): Plan {
  const reports: ServerReport[] = Object.entries(spec).map(([server, tools]) => ({
    server: fakeServer(server),
    status: 'listed',
    tools: Object.entries(tools).map(([name, decision]) =>
      fakeTool(server, name, decision, decision === 'allow' ? { readOnlyHint: true } : { destructiveHint: true }),
    ),
  }));
  const allow = reports.flatMap((r) => r.tools.filter((t) => t.decision === 'allow').map((t) => t.rule)).sort();
  const ask = reports.flatMap((r) => r.tools.filter((t) => t.decision === 'ask').map((t) => t.rule)).sort();
  return { allow, ask, reports, heuristic };
}
