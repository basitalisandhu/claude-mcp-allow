import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseRule, ruleFor } from './classify.js';
import type { Decision, Marker, Plan, Scope } from './types.js';

export interface PathContext {
  cwd: string;
  home: string;
  configDir: string;
  platform: NodeJS.Platform;
}

/**
 * Find the directory Claude Code uses for `.claude/settings.local.json`: the
 * git repository root (resolved through a worktree to the main checkout),
 * except outside a repository, when the root is the home directory, or on
 * Windows, where the working directory is used.
 */
export function localSettingsRoot(ctx: PathContext): string {
  if (ctx.platform === 'win32') return ctx.cwd;
  let dir = ctx.cwd;
  for (;;) {
    const dotGit = path.join(dir, '.git');
    if (existsSync(dotGit)) {
      let root = dir;
      try {
        if (statSync(dotGit).isFile()) {
          const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
          if (m) {
            const gitdir = path.resolve(dir, m[1].trim());
            const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
            const at = gitdir.indexOf(marker);
            if (at >= 0) root = gitdir.slice(0, at);
          }
        }
      } catch {
        root = dir;
      }
      if (path.resolve(root) === path.resolve(ctx.home)) return ctx.cwd;
      return root;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return ctx.cwd;
    dir = parent;
  }
}

export function settingsPathFor(scope: Scope, ctx: PathContext): string {
  switch (scope) {
    case 'user':
      return path.join(ctx.configDir, 'settings.json');
    case 'project':
      return path.join(ctx.cwd, '.claude', 'settings.json');
    case 'local':
      return path.join(localSettingsRoot(ctx), '.claude', 'settings.local.json');
  }
}

export interface SettingsFile {
  path: string;
  exists: boolean;
  text: string;
  data: Record<string, unknown>;
  indent: string;
  trailingNewline: boolean;
}

export class SettingsError extends Error {}

export function readSettingsFile(file: string): SettingsFile {
  if (!existsSync(file)) {
    return { path: file, exists: false, text: '', data: {}, indent: '  ', trailingNewline: true };
  }
  const text = readFileSync(file, 'utf8');
  let data: unknown;
  try {
    data = text.trim() === '' ? {} : JSON.parse(text);
  } catch (err) {
    throw new SettingsError(`${file}: invalid JSON (${(err as Error).message})`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new SettingsError(`${file}: expected a JSON object at the top level`);
  }
  const indentMatch = /^([ \t]+)"/m.exec(text);
  return {
    path: file,
    exists: true,
    text,
    data: data as Record<string, unknown>,
    indent: indentMatch ? indentMatch[1] : '  ',
    trailingNewline: text.endsWith('\n'),
  };
}

export function writeSettingsFile(file: SettingsFile, text: string): void {
  mkdirSync(path.dirname(file.path), { recursive: true });
  writeFileSync(file.path, text, 'utf8');
}

export interface MergeInput {
  plan: Plan;
  now: string;
  version: string;
  prune?: boolean;
  configuredServers?: string[];
}

export interface RuleDelta {
  allow: string[];
  ask: string[];
}

export interface MergeResult {
  data: Record<string, unknown>;
  text: string;
  added: RuleDelta;
  removed: RuleDelta;
  warnings: string[];
  changed: boolean;
  pruned: { server: string; rules: number }[];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function readMarker(data: Record<string, unknown>): Marker | undefined {
  const raw = data.claudeMcpAllow;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const m = raw as Record<string, unknown>;
  const servers: Record<string, Record<string, string>> = {};
  if (m.servers && typeof m.servers === 'object' && !Array.isArray(m.servers)) {
    for (const [server, tools] of Object.entries(m.servers as Record<string, unknown>)) {
      if (!tools || typeof tools !== 'object' || Array.isArray(tools)) continue;
      servers[server] = {};
      for (const [tool, hash] of Object.entries(tools as Record<string, unknown>)) {
        if (typeof hash === 'string') servers[server][tool] = hash;
      }
    }
  }
  return {
    generatedBy: typeof m.generatedBy === 'string' ? m.generatedBy : '',
    generatedAt: typeof m.generatedAt === 'string' ? m.generatedAt : '',
    heuristic: m.heuristic === true,
    servers,
  };
}

/** A marker value is `<decision>:<sha256>`; a bare hash (no decision) is accepted too. */
export function parseMarkerValue(value: string): { decision: Decision | undefined; hash: string } {
  const at = value.indexOf(':');
  if (at > 0) {
    const decision = value.slice(0, at);
    if (decision === 'allow' || decision === 'ask') return { decision, hash: value.slice(at + 1) };
  }
  return { decision: undefined, hash: value };
}

/**
 * Rules this tool wrote earlier for the given servers, reconstructed from the
 * marker. With `decision`, only the rules it wrote into that list; a value
 * recorded without a decision counts for both lists.
 */
export function markerRules(marker: Marker | undefined, servers: Iterable<string>, decision?: Decision): Set<string> {
  const out = new Set<string>();
  if (!marker) return out;
  for (const server of servers) {
    for (const [tool, value] of Object.entries(marker.servers[server] ?? {})) {
      const recorded = parseMarkerValue(value).decision;
      if (decision === undefined || recorded === undefined || recorded === decision) out.add(ruleFor(server, tool));
    }
  }
  return out;
}

/**
 * Merge the plan into a settings document. Rules that this tool did not write
 * are never removed; rules it wrote earlier for a server it listed again are
 * replaced; key order and indentation of the existing file are preserved.
 */
export function mergeIntoSettings(file: SettingsFile, input: MergeInput): MergeResult {
  const warnings: string[] = [];
  const data: Record<string, unknown> = structuredClone(file.data);
  const processed = input.plan.reports.filter((r) => r.status === 'listed').map((r) => r.server.ruleServer);
  const oldMarker = readMarker(data);
  const configured = new Set(input.configuredServers ?? input.plan.reports.map((r) => r.server.ruleServer));
  const stale = input.prune ? Object.keys(oldMarker?.servers ?? {}).filter((server) => !configured.has(server)) : [];
  const previousAllow = markerRules(oldMarker, [...processed, ...stale], 'allow');
  const previousAsk = markerRules(oldMarker, [...processed, ...stale], 'ask');
  const newAllow = new Set(input.plan.allow);
  const newAsk = new Set(input.plan.ask);

  if (data.permissions !== undefined && (!data.permissions || typeof data.permissions !== 'object' || Array.isArray(data.permissions))) {
    throw new SettingsError(`${file.path}: "permissions" is not an object`);
  }
  const permissions = (data.permissions as Record<string, unknown> | undefined) ?? {};
  const deny = new Set(stringArray(permissions.deny));
  const existingAllow = stringArray(permissions.allow);
  const existingAsk = stringArray(permissions.ask);

  const keepUnlessStale = (rule: string, previous: Set<string>, next: Set<string>) => !(previous.has(rule) && !next.has(rule));
  const allow = existingAllow.filter((r) => keepUnlessStale(r, previousAllow, newAllow));
  const ask = existingAsk.filter((r) => keepUnlessStale(r, previousAsk, newAsk));
  const removed: RuleDelta = {
    allow: existingAllow.filter((r) => !allow.includes(r)),
    ask: existingAsk.filter((r) => !ask.includes(r)),
  };
  const added: RuleDelta = { allow: [], ask: [] };

  for (const rule of input.plan.allow) {
    if (deny.has(rule)) {
      warnings.push(`${rule}: classified allow but present in permissions.deny; deny rules win, so it was not added`);
      continue;
    }
    if (!allow.includes(rule)) {
      allow.push(rule);
      added.allow.push(rule);
    }
  }
  for (const rule of input.plan.ask) {
    if (!ask.includes(rule)) {
      ask.push(rule);
      added.ask.push(rule);
    }
    if (allow.includes(rule) && !previousAllow.has(rule)) {
      warnings.push(`${rule}: classified ask but a rule you wrote by hand allows it; the ask rule is evaluated first and prompts`);
    }
  }

  if (allow.length > 0 || permissions.allow !== undefined) permissions.allow = allow;
  if (ask.length > 0 || permissions.ask !== undefined) permissions.ask = ask;
  if (Object.keys(permissions).length > 0 || data.permissions !== undefined) data.permissions = permissions;

  const servers: Record<string, Record<string, string>> = {};
  const fresh: Record<string, Record<string, string>> = {};
  for (const report of input.plan.reports) {
    if (report.status !== 'listed') continue;
    const tools: Record<string, string> = {};
    for (const tool of report.tools) tools[tool.name] = `${tool.decision}:${tool.hash}`;
    fresh[report.server.ruleServer] = tools;
  }
  for (const [server, tools] of Object.entries(oldMarker?.servers ?? {})) {
    if (stale.includes(server)) continue;
    servers[server] = fresh[server] ?? tools;
  }
  for (const [server, tools] of Object.entries(fresh)) {
    if (!(server in servers)) servers[server] = tools;
  }
  const marker: Marker = {
    generatedBy: `claude-mcp-allow ${input.version}`,
    generatedAt: input.now,
    heuristic: input.plan.heuristic,
    servers,
  };
  data.claudeMcpAllow = marker;

  const text = JSON.stringify(data, null, file.indent) + (file.trailingNewline || !file.exists ? '\n' : '');
  const changed =
    added.allow.length + added.ask.length + removed.allow.length + removed.ask.length > 0 ||
    JSON.stringify(oldMarker?.servers ?? {}) !== JSON.stringify(servers) ||
    (oldMarker?.heuristic ?? false) !== marker.heuristic;
  const pruned = stale.map((server) => {
    const allowRules = markerRules(oldMarker, [server], 'allow');
    const askRules = markerRules(oldMarker, [server], 'ask');
    return {
      server,
      rules: removed.allow.filter((r) => allowRules.has(r)).length + removed.ask.filter((r) => askRules.has(r)).length,
    };
  });
  return { data, text, added, removed, warnings, changed, pruned };
}

/** Rules in `permissions.allow` of a settings document that name an MCP tool. */
export function allowedMcpRules(data: Record<string, unknown>): Set<string> {
  const permissions = data.permissions;
  if (!permissions || typeof permissions !== 'object') return new Set();
  return new Set(stringArray((permissions as Record<string, unknown>).allow).filter((r) => parseRule(r) !== undefined));
}
