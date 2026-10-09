import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { expandServerConfig, referencesUserConfig, type Environment } from './env.js';
import { settingsPathFor } from './settings.js';
import type { LoadResult, PluginRef, RawServerConfig, ResolvedServer, ServerOrigin, SkippedServer } from './types.js';

export interface Paths {
  cwd: string;
  home: string;
  /** `~/.claude`, or `CLAUDE_CONFIG_DIR` when set. */
  configDir: string;
  /** `<configDir>/plugins`, or `CLAUDE_CODE_PLUGIN_CACHE_DIR` when set. */
  pluginsDir: string;
  /** `~/.claude.json`, or `<CLAUDE_CONFIG_DIR>/.claude.json` when that file exists. */
  claudeJson: string;
  userSettings: string;
  projectSettings: string;
  localSettings: string;
}

export interface LoadOptions {
  cwd: string;
  home: string;
  env: Environment;
  platform?: NodeJS.Platform;
}

export function resolvePaths(opts: LoadOptions): Paths {
  const cwd = path.resolve(opts.cwd);
  const home = opts.home;
  const configDir = opts.env.CLAUDE_CONFIG_DIR ? path.resolve(opts.env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude');
  const pluginsDir = opts.env.CLAUDE_CODE_PLUGIN_CACHE_DIR
    ? path.resolve(opts.env.CLAUDE_CODE_PLUGIN_CACHE_DIR)
    : path.join(configDir, 'plugins');
  let claudeJson = path.join(home, '.claude.json');
  if (opts.env.CLAUDE_CONFIG_DIR) {
    const candidate = path.join(configDir, '.claude.json');
    if (existsSync(candidate)) claudeJson = candidate;
  }
  const ctx = { cwd, home, configDir, platform: opts.platform ?? process.platform };
  return {
    cwd,
    home,
    configDir,
    pluginsDir,
    claudeJson,
    userSettings: settingsPathFor('user', ctx),
    projectSettings: settingsPathFor('project', ctx),
    localSettings: settingsPathFor('local', ctx),
  };
}

type Json = Record<string, unknown>;

export function readJsonFile(file: string, warnings: string[]): Json | undefined {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Json;
    warnings.push(`${file}: expected a JSON object; ignored`);
  } catch (err) {
    warnings.push(`${file}: invalid JSON (${(err as Error).message}); ignored`);
  }
  return undefined;
}

function asServerMap(value: unknown): Record<string, RawServerConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Record<string, RawServerConfig> = {};
  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) out[name] = entry as RawServerConfig;
  }
  return out;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

interface SettingsSummary {
  enabledPlugins: Record<string, boolean>;
  disabledMcpjsonServers: Set<string>;
  disabledMcpServers: Set<string>;
}

/** The few settings keys this tool honours, merged user < project < local. */
function readSettingsSummary(paths: Paths, warnings: string[]): SettingsSummary {
  const summary: SettingsSummary = { enabledPlugins: {}, disabledMcpjsonServers: new Set(), disabledMcpServers: new Set() };
  for (const file of [paths.userSettings, paths.projectSettings, paths.localSettings]) {
    const data = readJsonFile(file, warnings);
    if (!data) continue;
    const enabled = data.enabledPlugins;
    if (enabled && typeof enabled === 'object' && !Array.isArray(enabled)) {
      for (const [id, flag] of Object.entries(enabled as Record<string, unknown>)) {
        if (typeof flag === 'boolean') summary.enabledPlugins[id] = flag;
      }
    }
    for (const name of stringList(data.disabledMcpjsonServers)) summary.disabledMcpjsonServers.add(name);
    for (const name of stringList(data.disabledMcpServers)) summary.disabledMcpServers.add(name);
  }
  return summary;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

function pluginRuleServer(pluginName: string, serverName: string): string {
  return `plugin_${sanitizeSegment(pluginName)}_${sanitizeSegment(serverName)}`;
}

/** Key used to match plugin servers against higher-precedence servers by endpoint. */
export function endpointKey(config: RawServerConfig): string | undefined {
  if (typeof config.url === 'string' && config.url) {
    try {
      const u = new URL(config.url);
      let pathname = u.pathname;
      if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
      return `url:${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${pathname}${u.search}`;
    } catch {
      return `url:${config.url}`;
    }
  }
  if (typeof config.command === 'string' && config.command) {
    return `cmd:${[config.command, ...(config.args ?? [])].join('\u0000')}`;
  }
  return undefined;
}

function displayHome(file: string, home: string): string {
  return file.startsWith(home + path.sep) || file === home ? '~' + file.slice(home.length) : file;
}

interface Candidate {
  name: string;
  origin: ServerOrigin;
  source: string;
  raw: RawServerConfig;
  plugin?: PluginRef;
  extra: Record<string, string>;
}

function readPluginCandidates(paths: Paths, settings: SettingsSummary, warnings: string[], skipped: SkippedServer[]): Candidate[] {
  const record = readJsonFile(path.join(paths.pluginsDir, 'installed_plugins.json'), warnings);
  const plugins = record?.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return [];
  const candidates: Candidate[] = [];
  for (const [id, value] of Object.entries(plugins as Record<string, unknown>)) {
    const records = (Array.isArray(value) ? value : [value]).filter(
      (r): r is Record<string, unknown> => !!r && typeof r === 'object',
    );
    const install = records.find((r) => typeof r.installPath === 'string' && existsSync(r.installPath as string));
    if (!install) {
      warnings.push(`plugin ${id}: no install record with an existing installPath; skipped`);
      continue;
    }
    const root = path.resolve(install.installPath as string);
    const at = id.lastIndexOf('@');
    const name = at > 0 ? id.slice(0, at) : id;
    const marketplace = at > 0 ? id.slice(at + 1) : '';
    const manifest = readJsonFile(path.join(root, '.claude-plugin', 'plugin.json'), warnings);
    const flag = settings.enabledPlugins[id];
    const enabled = flag === undefined ? manifest?.defaultEnabled !== false : flag;
    const plugin: PluginRef = { id, name, marketplace, root };
    const servers: Record<string, RawServerConfig> = {};
    const mcpJson = readJsonFile(path.join(root, '.mcp.json'), warnings);
    Object.assign(servers, asServerMap(mcpJson?.mcpServers));
    const declared = manifest?.mcpServers;
    const shapes = Array.isArray(declared) ? declared : declared === undefined ? [] : [declared];
    for (const shape of shapes) {
      if (typeof shape === 'string') {
        if (/^https?:\/\//.test(shape) || /\.(mcpb|dxt)$/i.test(shape)) {
          warnings.push(`plugin ${id}: MCP bundle ${shape} is not read by this tool`);
          continue;
        }
        const file = path.resolve(root, shape);
        const data = readJsonFile(file, warnings);
        if (!data) continue;
        Object.assign(servers, asServerMap('mcpServers' in data ? data.mcpServers : data));
      } else if (shape && typeof shape === 'object') {
        Object.assign(servers, asServerMap(shape));
      }
    }
    const dataDir = path.join(paths.pluginsDir, 'data', id.replace(/[^A-Za-z0-9_-]/g, '-'));
    for (const [serverName, raw] of Object.entries(servers)) {
      const scoped = `plugin:${name}:${serverName}`;
      const ruleServer = pluginRuleServer(name, serverName);
      if (!enabled) {
        skipped.push({ name: scoped, ruleServer, origin: 'plugin', source: `plugin ${id}`, reason: 'plugin is disabled' });
        continue;
      }
      if (settings.disabledMcpServers.has(scoped) || settings.disabledMcpServers.has(serverName)) {
        skipped.push({ name: scoped, ruleServer, origin: 'plugin', source: `plugin ${id}`, reason: 'listed in disabledMcpServers' });
        continue;
      }
      candidates.push({
        name: serverName,
        origin: 'plugin',
        source: `plugin ${id} (${displayHome(root, paths.home)})`,
        raw,
        plugin,
        extra: { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_PROJECT_DIR: paths.cwd },
      });
    }
  }
  return candidates;
}

function projectKeys(cwd: string): string[] {
  const keys = [cwd];
  try {
    const real = realpathSync(cwd);
    if (real !== cwd) keys.push(real);
  } catch {
    // keep the resolved path only
  }
  return keys;
}

/**
 * Load every MCP server definition Claude Code would read for `cwd`, apply the
 * documented precedence (local, project, user, plugin; managed servers are not
 * read) and record where each one came from.
 */
export function loadServers(opts: LoadOptions): LoadResult {
  const paths = resolvePaths(opts);
  const warnings: string[] = [];
  const skipped: SkippedServer[] = [];
  const settings = readSettingsSummary(paths, warnings);
  const claudeJson = readJsonFile(paths.claudeJson, warnings) ?? {};
  const candidates: Candidate[] = [];

  const projects = claudeJson.projects;
  if (projects && typeof projects === 'object') {
    for (const key of projectKeys(paths.cwd)) {
      const project = (projects as Record<string, unknown>)[key];
      if (!project || typeof project !== 'object') continue;
      const source = `${displayHome(paths.claudeJson, paths.home)} projects["${displayHome(key, paths.home)}"]`;
      for (const [name, raw] of Object.entries(asServerMap((project as Json).mcpServers))) {
        candidates.push({ name, origin: 'local', source, raw, extra: {} });
      }
      break;
    }
  }

  const mcpJsonPath = path.join(paths.cwd, '.mcp.json');
  const mcpJson = readJsonFile(mcpJsonPath, warnings);
  for (const [name, raw] of Object.entries(asServerMap(mcpJson?.mcpServers))) {
    if (settings.disabledMcpjsonServers.has(name)) {
      skipped.push({ name, ruleServer: name, origin: 'project', source: '.mcp.json', reason: 'listed in disabledMcpjsonServers' });
      continue;
    }
    candidates.push({ name, origin: 'project', source: '.mcp.json', raw, extra: {} });
  }

  for (const [name, raw] of Object.entries(asServerMap(claudeJson.mcpServers))) {
    candidates.push({ name, origin: 'user', source: displayHome(paths.claudeJson, paths.home), raw, extra: {} });
  }

  candidates.push(...readPluginCandidates(paths, settings, warnings, skipped));

  const servers: ResolvedServer[] = [];
  const shadowed: LoadResult['shadowed'] = [];
  const byName = new Map<string, ResolvedServer>();
  const byEndpoint = new Map<string, ResolvedServer>();

  for (const c of candidates) {
    const ruleServer = c.plugin ? pluginRuleServer(c.plugin.name, c.name) : c.name;
    if (c.origin !== 'plugin' && settings.disabledMcpServers.has(c.name)) {
      skipped.push({ name: c.name, ruleServer, origin: c.origin, source: c.source, reason: 'listed in disabledMcpServers' });
      continue;
    }
    const { config, missing } = expandServerConfig(c.raw, opts.env, c.extra);
    const serverWarnings = missing.map((v) => `\${${v}} is not set and has no default; left as written`);
    const displayName = c.plugin ? `plugin:${c.plugin.name}:${c.name}` : c.name;
    const server: ResolvedServer = {
      name: c.name,
      ruleServer,
      displayName,
      origin: c.origin,
      source: c.source,
      config,
      warnings: serverWarnings,
    };
    if (c.plugin) server.plugin = c.plugin;

    if (c.plugin && referencesUserConfig(config)) {
      skipped.push({ name: displayName, ruleServer, origin: 'plugin', source: c.source, reason: 'references ${user_config.*}, which this tool does not resolve' });
      continue;
    }
    const type = config.type ?? (config.command ? 'stdio' : config.url ? 'http' : undefined);
    if (type === undefined) {
      skipped.push({ name: displayName, ruleServer, origin: c.origin, source: c.source, reason: 'entry has neither command nor url' });
      continue;
    }
    if (type !== 'stdio' && type !== 'http' && type !== 'sse') {
      skipped.push({ name: displayName, ruleServer, origin: c.origin, source: c.source, reason: `transport type "${type}" is not supported` });
      continue;
    }

    if (c.origin !== 'plugin') {
      const winner = byName.get(c.name);
      if (winner) {
        shadowed.push({ server, by: winner });
        continue;
      }
      byName.set(c.name, server);
      const key = endpointKey(config);
      if (key && !byEndpoint.has(key)) byEndpoint.set(key, server);
    } else {
      const key = endpointKey(config);
      const winner = key ? byEndpoint.get(key) : undefined;
      if (winner) {
        shadowed.push({ server, by: winner });
        continue;
      }
    }
    servers.push(server);
  }

  return { servers, shadowed, skipped, warnings };
}
