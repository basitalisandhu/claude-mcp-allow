import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { endpointKey, loadServers, resolvePaths } from '../src/config.js';
import { ANNOTATED, UNANNOTATED, makeFakeEnv, writeJson, type FakeEnv } from './helpers.js';

let env: FakeEnv;
beforeAll(() => {
  env = makeFakeEnv();
});
afterAll(() => env.cleanup());

const load = (extraEnv: Record<string, string> = {}, cwd?: string) =>
  loadServers({ cwd: cwd ?? env.project, home: env.home, env: { FIXTURE_DIR: path.dirname(ANNOTATED), ...extraEnv }, platform: 'linux' });

describe('server discovery', () => {
  it('maps managed policy files to the documented platform paths', () => {
    const base = { cwd: env.project, home: env.home, env: {} };
    expect(resolvePaths({ ...base, platform: 'linux' }).managedMcp).toBe('/etc/claude-code/managed-mcp.json');
    expect(resolvePaths({ ...base, platform: 'darwin' }).managedSettings).toBe('/Library/Application Support/ClaudeCode/managed-settings.json');
    expect(resolvePaths({ ...base, platform: 'win32' }).managedMcp).toBe('C:\\Program Files\\ClaudeCode\\managed-mcp.json');
  });

  it.each(['disabled', 'user-config', 'unsupported', 'empty'])('keeps the loader rule identifier for skipped plugin servers (%s)', (reason) => {
    const other = makeFakeEnv();
    try {
      writeJson(path.join(other.home, '.claude', 'plugins', 'installed_plugins.json'), {
        plugins: { 'db.tools@demo-market': { installPath: other.pluginRoot } },
      });
      writeJson(path.join(other.pluginRoot, '.mcp.json'), {
        mcpServers: {
          'data:base.v1': reason === 'empty' ? {}
            : reason === 'user-config' ? { command: '${user_config.command}' }
              : { type: reason === 'unsupported' ? 'ws' : 'stdio', command: 'node' },
        },
      });
      if (reason === 'disabled') {
        writeJson(path.join(other.home, '.claude', 'settings.json'), {
          disabledMcpServers: ['plugin:db.tools:data:base.v1'],
        });
      }
      const result = loadServers({ cwd: other.project, home: other.home, env: {}, platform: 'linux' });
      expect(result.servers.some((s) => s.plugin?.name === 'db.tools')).toBe(false);
      expect(result.skipped.find((s) => s.name === 'plugin:db.tools:data:base.v1')).toHaveProperty('ruleServer', 'plugin_db_tools_data_base_v1');
    } finally {
      other.cleanup();
    }
  });

  it.each(['setting', 'manifest'])('records disabled plugin servers without loading them (%s)', (disabledBy) => {
    const other = makeFakeEnv();
    try {
      writeJson(path.join(other.home, '.claude', 'settings.json'), {
        enabledPlugins: { 'off-plugin@demo-market': false, ...(disabledBy === 'setting' ? { 'db-tools@demo-market': false } : {}) },
      });
      writeJson(path.join(other.pluginRoot, '.claude-plugin', 'plugin.json'), {
        name: 'db-tools', defaultEnabled: disabledBy !== 'manifest',
        mcpServers: { 'extra.server': { command: 'node', args: ['never-run.mjs'] } },
      });
      const result = loadServers({ cwd: other.project, home: other.home, env: {}, platform: 'linux' });
      expect(result.servers.some((s) => s.plugin?.name === 'db-tools')).toBe(false);
      expect(result.skipped.filter((s) => s.name.startsWith('plugin:db-tools:'))).toEqual([
        expect.objectContaining({ name: 'plugin:db-tools:database', ruleServer: 'plugin_db-tools_database', reason: 'plugin is disabled' }),
        expect.objectContaining({ name: 'plugin:db-tools:extra.server', ruleServer: 'plugin_db-tools_extra_server', reason: 'plugin is disabled' }),
      ]);
    } finally {
      other.cleanup();
    }
  });

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

  it('gives a valid managed-mcp.json exclusive control while loading managed settings alongside it', () => {
    const other = makeFakeEnv();
    try {
      const managedDir = path.join(other.home, 'managed');
      writeJson(path.join(managedDir, 'managed-mcp.json'), {
        mcpServers: {
          unannotated: { command: 'node', args: ['managed.mjs'] },
          'managed-file': { type: 'http', url: 'https://managed.example/mcp' },
        },
      });
      writeJson(path.join(managedDir, 'managed-settings.json'), {
        managedMcpServers: {
          'managed-setting': { type: 'streamable-http', url: 'https://settings.example/mcp' },
          'disabled-managed': { type: 'http', url: 'https://settings.example/disabled' },
        },
      });
      writeJson(path.join(other.home, '.claude', 'settings.json'), {
        disabledMcpServers: ['disabled-managed'],
      });

      const result = loadServers({
        cwd: other.project,
        home: other.home,
        env: {},
        platform: 'linux',
        managedConfigDir: managedDir,
      });

      expect(result.servers.find((server) => server.name === 'unannotated')).toMatchObject({
        origin: 'managed',
        source: path.join(managedDir, 'managed-mcp.json'),
      });
      expect(result.servers.find((server) => server.name === 'managed-file')?.origin).toBe('managed');
      expect(result.servers.find((server) => server.name === 'managed-setting')).toMatchObject({
        origin: 'managed',
        source: path.join(managedDir, 'managed-settings.json'),
        config: { type: 'http', url: 'https://settings.example/mcp' },
      });
      expect(result.servers.map((server) => server.name)).not.toContain('disabled-managed');
      expect(result.skipped.find((server) => server.name === 'disabled-managed')).toMatchObject({
        origin: 'managed',
        reason: 'listed in disabledMcpServers',
      });
      expect(result.skipped.find((server) => server.name === 'annotated')?.reason).toBe('managed-mcp.json has exclusive control');
      expect(result.skipped.find((server) => server.name === 'unannotated')?.reason).toBe('managed-mcp.json has exclusive control');
    } finally {
      other.cleanup();
    }
  });

  it('falls back to normal discovery when managed-mcp.json cannot be parsed', () => {
    const other = makeFakeEnv();
    try {
      const managedDir = path.join(other.home, 'managed');
      mkdirSync(managedDir, { recursive: true });
      const managedFile = path.join(managedDir, 'managed-mcp.json');
      writeFileSync(managedFile, '{broken');
      const result = loadServers({ cwd: other.project, home: other.home, env: {}, platform: 'linux', managedConfigDir: managedDir });
      expect(result.servers.map((server) => server.name)).toContain('annotated');
      expect(result.warnings.some((warning) => warning.startsWith(`${managedFile}: invalid JSON`))).toBe(true);
    } finally {
      other.cleanup();
    }
  });

  it('validates managedMcpServers as literal HTTPS remote definitions', () => {
    const other = makeFakeEnv();
    try {
      const managedDir = path.join(other.home, 'managed');
      writeJson(path.join(managedDir, 'managed-settings.json'), {
        managedMcpServers: {
          templated: { type: 'http', url: 'https://managed.example/${TENANT}' },
          'valid-sse': { type: 'sse', url: 'https://managed.example/events', headers: { Authorization: 'Bearer literal' } },
          aliased: { type: 'streamable-http', url: 'https://managed.example/mcp' },
          'bad name': { type: 'http', url: 'https://managed.example/name' },
          command: { type: 'http', url: 'https://managed.example/command', command: 'node' },
          insecure: { type: 'http', url: 'http://managed.example/mcp' },
          malformed: 'https://managed.example/mcp',
        },
      });
      const result = loadServers({ cwd: other.project, home: other.home, env: { TENANT: 'expanded' }, platform: 'linux', managedConfigDir: managedDir });
      expect(result.servers.find((server) => server.name === 'valid-sse')?.config.headers).toEqual({ Authorization: 'Bearer literal' });
      expect(result.servers.find((server) => server.name === 'aliased')?.config.type).toBe('http');
      expect(result.servers.map((server) => server.name)).not.toContain('templated');
      expect(result.skipped.find((server) => server.name === 'templated')?.reason).toContain('literal values');
      expect(result.skipped.find((server) => server.name === 'bad name')?.reason).toContain('names may contain');
      expect(result.skipped.find((server) => server.name === 'command')?.reason).toContain('may not define command');
      expect(result.skipped.find((server) => server.name === 'insecure')?.reason).toContain('HTTPS URL');
      expect(result.skipped.find((server) => server.name === 'malformed')?.reason).toContain('JSON objects');
    } finally {
      other.cleanup();
    }
  });

  it('refuses managedMcpServers entries with control or invisible characters, and warns on the array form', () => {
    const other = makeFakeEnv();
    try {
      const managedDir = path.join(other.home, 'managed');
      writeJson(path.join(managedDir, 'managed-settings.json'), {
        managedMcpServers: {
          bidi: { type: 'http', url: 'https://managed.example/mcp', headers: { 'X-Key': 'abc\u202edef' } },
          zero: { type: 'http', url: 'https://managed\u200b.example/mcp' },
          'no-type': { url: 'https://managed.example/mcp' },
          helper: { type: 'http', url: 'https://managed.example/mcp', headersHelper: '/bin/echo' },
          clean: { type: 'http', url: 'https://managed.example/mcp' },
        },
      });
      const result = loadServers({ cwd: other.project, home: other.home, env: {}, platform: 'linux', managedConfigDir: managedDir });
      for (const name of ['bidi', 'zero']) {
        expect(result.skipped.find((server) => server.name === name)?.reason).toContain('control or invisible formatting characters');
      }
      expect(result.skipped.find((server) => server.name === 'no-type')?.reason).toContain('type "http"');
      expect(result.skipped.find((server) => server.name === 'helper')?.reason).toContain('may not define headersHelper');
      expect(result.servers.find((server) => server.name === 'clean')?.origin).toBe('managed');

      writeJson(path.join(managedDir, 'managed-settings.json'), { managedMcpServers: [{ name: 'desktop', url: 'https://managed.example/mcp' }] });
      const arrayForm = loadServers({ cwd: other.project, home: other.home, env: {}, platform: 'linux', managedConfigDir: managedDir });
      expect(arrayForm.warnings.some((warning) => warning.includes('managedMcpServers is an array'))).toBe(true);
      expect(arrayForm.servers.some((server) => server.origin === 'managed')).toBe(false);
    } finally {
      other.cleanup();
    }
  });

  it('prefers managed-mcp.json when both managed sources define the same name', () => {
    const other = makeFakeEnv();
    try {
      const managedDir = path.join(other.home, 'managed');
      writeJson(path.join(managedDir, 'managed-mcp.json'), {
        mcpServers: { shared: { command: 'node', args: ['managed-file.mjs'] } },
      });
      writeJson(path.join(managedDir, 'managed-settings.json'), {
        managedMcpServers: { shared: { type: 'http', url: 'https://managed.example/mcp' } },
      });
      const result = loadServers({ cwd: other.project, home: other.home, env: {}, platform: 'linux', managedConfigDir: managedDir });
      expect(result.servers.find((server) => server.name === 'shared')?.source).toBe(path.join(managedDir, 'managed-mcp.json'));
      expect(result.shadowed.find((entry) => entry.server.name === 'shared')).toMatchObject({
        server: { source: path.join(managedDir, 'managed-settings.json') },
        by: { source: path.join(managedDir, 'managed-mcp.json') },
      });
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
    expect(result.skipped.find((s) => s.name === 'disabled-one')).toHaveProperty('ruleServer', 'disabled-one');

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
      expect(r.skipped.find((s) => s.name === 'sock')).toHaveProperty('ruleServer', 'sock');
      expect(r.skipped.find((s) => s.name === 'empty')).toHaveProperty('ruleServer', 'empty');
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
      expect(r2.skipped.find((s) => s.name === 'unannotated')).toHaveProperty('ruleServer', 'unannotated');
      expect(r2.skipped.find((s) => s.name === 'plugin:db-tools:inline')).toHaveProperty('ruleServer', 'plugin_db-tools_inline');

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
