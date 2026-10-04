import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endpointKey, loadServers } from '../src/config.js';
import { ANNOTATED, UNANNOTATED, makeFakeEnv, writeJson, type FakeEnv } from './helpers.js';

let env: FakeEnv;
beforeAll(() => {
  env = makeFakeEnv();
});
afterAll(() => env.cleanup());

const load = (extraEnv: Record<string, string> = {}, cwd?: string) =>
  loadServers({ cwd: cwd ?? env.project, home: env.home, env: { FIXTURE_DIR: path.dirname(ANNOTATED), ...extraEnv }, platform: 'linux' });

describe('server discovery', () => {
  it('reads project, user, local and plugin definitions and records their source', () => {
    const result = load();
    const byName = Object.fromEntries(result.servers.map((s) => [s.displayName, s]));
    expect(byName.annotated.origin).toBe('project');
    expect(byName.annotated.source).toBe('.mcp.json');
    expect(byName.unannotated.origin).toBe('user');
    expect(byName.unannotated.source).toBe('~/.claude.json');
    expect(byName['local-only'].origin).toBe('local');
    expect(byName['local-only'].source).toBe('~/.claude.json projects["~/code/app"]');
    expect(byName['plugin:db-tools:database'].origin).toBe('plugin');
    expect(byName['plugin:db-tools:database'].ruleServer).toBe('plugin_db-tools_database');
    expect(byName['plugin:db-tools:database'].plugin?.id).toBe('db-tools@demo-market');
    expect(byName['oauth-remote'].config.oauth).toBeDefined();
  });

  it('applies precedence by name: project beats user, local beats project', () => {
    const result = load();
    const shared = result.servers.filter((s) => s.name === 'shared');
    expect(shared).toHaveLength(1);
    expect(shared[0].origin).toBe('project');
    expect(result.shadowed.map((s) => `${s.server.name}:${s.server.origin}<${s.by.origin}`)).toContain('shared:user<project');

    const other = makeFakeEnv();
    try {
      const claudeJson = path.join(other.home, '.claude.json');
      const data = JSON.parse(readFileSync(claudeJson, 'utf8'));
      data.projects[other.project].mcpServers.shared = { command: 'node', args: [ANNOTATED] };
      writeJson(claudeJson, data);
      const r = loadServers({ cwd: other.project, home: other.home, env: {}, platform: 'linux' });
      expect(r.servers.find((s) => s.name === 'shared')?.origin).toBe('local');
    } finally {
      other.cleanup();
    }
  });

  it('expands ${CLAUDE_PLUGIN_ROOT}, env references and defaults', () => {
    const result = load({ EXTRA_TOOL: 'get_custom' });
    const plugin = result.servers.find((s) => s.ruleServer === 'plugin_db-tools_database')!;
    expect(plugin.config.args?.[0]).toBe(path.join(env.pluginRoot, 'server.mjs'));
    const annotated = result.servers.find((s) => s.name === 'annotated')!;
    expect(annotated.config.args?.[0]).toBe(ANNOTATED);
    expect(annotated.config.env?.FIXTURE_EXTRA_TOOL).toBe('get_custom');
    expect(load().servers.find((s) => s.name === 'annotated')!.config.env?.FIXTURE_EXTRA_TOOL).toBe('get_default');
  });

  it('skips disabled plugins, disabledMcpjsonServers and unsupported transports', () => {
    const result = load();
    expect(result.servers.some((s) => s.name === 'hidden')).toBe(false);
    expect(result.servers.some((s) => s.name === 'disabled-one')).toBe(false);
    expect(result.skipped.find((s) => s.name === 'disabled-one')?.reason).toContain('disabledMcpjsonServers');

    const other = makeFakeEnv();
    try {
      writeJson(path.join(other.project, '.mcp.json'), {
        mcpServers: {
          sock: { type: 'ws', url: 'wss://example.com' },
          empty: { note: 'nothing' },
          fine: { command: 'node', args: [UNANNOTATED] },
        },
      });
      const r = loadServers({ cwd: other.project, home: other.home, env: {}, platform: 'linux' });
      expect(r.servers.map((s) => s.name)).not.toContain('sock');
      expect(r.skipped.find((s) => s.name === 'sock')?.reason).toContain('ws');
      expect(r.skipped.find((s) => s.name === 'empty')?.reason).toContain('neither command nor url');
      expect(r.servers.map((s) => s.name)).toContain('fine');
    } finally {
      other.cleanup();
    }
  });

  it('shadows a plugin server whose endpoint matches a higher-precedence server', () => {
    const other = makeFakeEnv();
    try {
      // the plugin server runs <pluginRoot>/server.mjs; point a user server at the same command
      const claudeJson = path.join(other.home, '.claude.json');
      const data = JSON.parse(readFileSync(claudeJson, 'utf8'));
      data.mcpServers.mirror = { command: 'node', args: [path.join(other.pluginRoot, 'server.mjs')] };
      writeJson(claudeJson, data);
      const r = loadServers({ cwd: other.project, home: other.home, env: {}, platform: 'linux' });
      expect(r.servers.some((s) => s.ruleServer === 'plugin_db-tools_database')).toBe(false);
      const shadow = r.shadowed.find((s) => s.server.ruleServer === 'plugin_db-tools_database');
      expect(shadow?.by.name).toBe('mirror');
    } finally {
      other.cleanup();
    }
  });

  it('reads inline mcpServers from plugin.json and honours disabledMcpServers and CLAUDE_CONFIG_DIR', () => {
    const other = makeFakeEnv();
    try {
      writeJson(path.join(other.pluginRoot, '.claude-plugin', 'plugin.json'), {
        name: 'db-tools',
        mcpServers: [{ inline: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/inline.mjs'] } }, 'https://example.com/x.mcpb'],
      });
      const r = loadServers({ cwd: other.project, home: other.home, env: {}, platform: 'linux' });
      expect(r.servers.map((s) => s.displayName)).toContain('plugin:db-tools:inline');
      expect(r.warnings.some((w) => w.includes('x.mcpb'))).toBe(true);

      writeJson(path.join(other.project, '.claude', 'settings.local.json'), { disabledMcpServers: ['unannotated', 'plugin:db-tools:inline'] });
      const r2 = loadServers({ cwd: other.project, home: other.home, env: {}, platform: 'linux' });
      expect(r2.servers.map((s) => s.displayName)).not.toContain('unannotated');
      expect(r2.servers.map((s) => s.displayName)).not.toContain('plugin:db-tools:inline');

      const configDir = path.join(other.root, 'alt-config');
      mkdirSync(configDir, { recursive: true });
      writeJson(path.join(configDir, 'settings.json'), { enabledPlugins: { 'db-tools@demo-market': false } });
      const pluginCache = path.join(other.home, '.claude', 'plugins');
      const r3 = loadServers({ cwd: other.project, home: other.home, env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginCache }, platform: 'linux' });
      // the alt config disables db-tools; off-plugin, disabled only in the original user settings, now loads
      expect(r3.servers.some((s) => s.plugin?.name === 'db-tools')).toBe(false);
      expect(r3.servers.some((s) => s.displayName === 'plugin:off-plugin:hidden')).toBe(true);
      expect(r3.servers.some((s) => s.name === 'annotated')).toBe(true);
      writeJson(path.join(configDir, 'settings.json'), { enabledPlugins: { 'db-tools@demo-market': true } });
      const r4 = loadServers({ cwd: other.project, home: other.home, env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_PLUGIN_CACHE_DIR: pluginCache }, platform: 'linux' });
      expect(r4.servers.some((s) => s.displayName === 'plugin:db-tools:database')).toBe(true);
    } finally {
      other.cleanup();
    }
  });

  it('records a warning for an unset variable without a default and leaves it as written', () => {
    const other = makeFakeEnv();
    try {
      writeJson(path.join(other.project, '.mcp.json'), {
        mcpServers: { needs: { type: 'http', url: 'https://example.com/${TENANT}/mcp', headers: { 'X-Key': '${MY_API_KEY}' } } },
      });
      const r = loadServers({ cwd: other.project, home: other.home, env: {}, platform: 'linux' });
      const needs = r.servers.find((s) => s.name === 'needs')!;
      expect(needs.config.url).toBe('https://example.com/${TENANT}/mcp');
      expect(needs.warnings.join('\n')).toContain('${TENANT}');
      expect(needs.warnings.join('\n')).toContain('${MY_API_KEY}');
    } finally {
      other.cleanup();
    }
  });

  it('normalises endpoints the way the docs describe duplicates', () => {
    expect(endpointKey({ url: 'HTTPS://Example.com:443/mcp/' })).toBe(endpointKey({ url: 'https://example.com/mcp' }));
    expect(endpointKey({ url: 'https://example.com/mcp?x=1' })).not.toBe(endpointKey({ url: 'https://example.com/mcp' }));
    expect(endpointKey({ command: 'node', args: ['a'] })).not.toBe(endpointKey({ command: 'node', args: ['b'] }));
    expect(endpointKey({})).toBeUndefined();
  });
});
