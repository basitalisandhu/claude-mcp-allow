import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROOT, expectGolden, makeFakeEnv, normalizeGeneratedAt, readJson, runCli, writeJson, type FakeEnv } from './helpers.js';

const RULE = /^mcp__[^*]+__[^*]+$/;

describe('claude-mcp-allow CLI', () => {
  let env: FakeEnv;
  beforeAll(() => {
    env = makeFakeEnv();
  });
  afterAll(() => env.cleanup());

  it.each(['setting', 'manifest'])('preserves disabled plugin rules and markers during pruning (%s)', async (disabledBy) => {
    const isolated = makeFakeEnv();
    try {
      const initial = await runCli(['--write', '--server', 'plugin_db-tools_database'], isolated);
      expect(initial.code).toBe(0);
      const file = path.join(isolated.project, '.claude', 'settings.local.json');
      const before = readJson(file);
      const marker = before.claudeMcpAllow.servers['plugin_db-tools_database'];
      const pluginRules = {
        allow: before.permissions.allow.filter((r: string) => r.startsWith('mcp__plugin_db-tools_database__')),
        ask: before.permissions.ask.filter((r: string) => r.startsWith('mcp__plugin_db-tools_database__')),
      };
      expect(pluginRules.allow.length).toBeGreaterThan(0);
      expect(pluginRules.ask.length).toBeGreaterThan(0);
      before.permissions.allow.push('mcp__removed__read', 'mcp__removed__manual');
      before.claudeMcpAllow.servers.removed = { read: 'allow:old' };
      writeJson(file, before);
      writeJson(path.join(isolated.home, '.claude', 'settings.json'), {
        enabledPlugins: { 'off-plugin@demo-market': false, ...(disabledBy === 'setting' ? { 'db-tools@demo-market': false } : {}) },
      });
      writeJson(path.join(isolated.pluginRoot, '.claude-plugin', 'plugin.json'), {
        name: 'db-tools', defaultEnabled: disabledBy !== 'manifest',
      });

      const bytes = readFileSync(file);
      const diff = await runCli(['--diff', '--prune', '--server', 'annotated'], isolated);
      expect(diff.code).toBe(0);
      expect(diff.stdout).toContain('- allow mcp__removed__read');
      expect(readFileSync(file)).toEqual(bytes);

      const result = await runCli(['--write', '--prune', '--server', 'annotated'], isolated);
      expect(result.code).toBe(0);
      const after = readJson(file);
      expect(after.claudeMcpAllow.servers['plugin_db-tools_database']).toEqual(marker);
      expect(diff.stdout).not.toMatch(/^- (allow|ask)\s+mcp__plugin_db-tools_database__/m);
      for (const list of ['allow', 'ask'] as const) {
        expect(after.permissions[list].filter((r: string) => r.startsWith('mcp__plugin_db-tools_database__'))).toEqual(pluginRules[list]);
      }
      expect(after.claudeMcpAllow.servers.removed).toBeUndefined();
      expect(after.permissions.allow).not.toContain('mcp__removed__read');
      expect(after.permissions.allow).toContain('mcp__removed__manual');
    } finally {
      isolated.cleanup();
    }
  });
  it('refuses pruning with incomplete configuration and preserves the settings bytes', async () => {
    const isolated = makeFakeEnv();
    try {
      const file = path.join(isolated.project, '.mcp.json');
      writeFileSync(file, '{invalid');
      const settings = path.join(isolated.project, '.claude', 'settings.local.json');
      const before = readFileSync(settings);
      const result = await runCli(['--write', '--prune'], isolated);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('refusing --prune');
      expect(readFileSync(settings)).toEqual(before);
    } finally {
      isolated.cleanup();
    }
  });
  it('shows pruning in a read-only diff and requires opt-in for user-scope removal', async () => {
    const settings = {
      permissions: { allow: ['mcp__other_project__read', 'mcp__other_project__manual'], ask: ['mcp__other_project__write'] },
      claudeMcpAllow: {
        generatedBy: 'claude-mcp-allow 0.1.0', generatedAt: '', heuristic: false,
        servers: { other_project: { read: 'allow:old', write: 'ask:old' } },
      },
    };
    const isolated = makeFakeEnv({ userSettings: settings });
    try {
      const file = path.join(isolated.home, '.claude', 'settings.json');
      const plain = await runCli(['--server', 'annotated', '--scope', 'user', '--write'], isolated);
      expect(plain.code).toBe(0);
      expect(readJson(file).claudeMcpAllow.servers.other_project).toBeDefined();
      const bytes = readFileSync(file);
      const diff = await runCli(['--server', 'annotated', '--scope', 'user', '--diff', '--prune'], isolated);
      expect(diff.code).toBe(0);
      expect(diff.stdout).toContain('- allow mcp__other_project__read');
      expect(diff.stdout).toContain('- ask   mcp__other_project__write');
      expect(readFileSync(file)).toEqual(bytes);
      const pruned = await runCli(['--server', 'annotated', '--scope', 'user', '--write', '--prune'], isolated);
      expect(pruned.code).toBe(0);
      expect(pruned.stderr).toContain('pruned other_project: 2 rules');
      const result = readJson(file);
      expect(result.claudeMcpAllow.servers.other_project).toBeUndefined();
      expect(result.permissions.allow).toContain('mcp__other_project__manual');
    } finally {
      isolated.cleanup();
    }
  });
  it('prints help and version, and rejects unknown flags with exit 2', async () => {
    expect((await runCli(['--help'], env)).stdout).toContain('Usage: claude-mcp-allow');
    expect((await runCli(['--version'], env)).stdout.trim()).toBe(readJson(path.join(ROOT, 'package.json')).version);
    const bad = await runCli(['--bogus'], env);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('unknown argument');
    expect((await runCli(['--scope', 'global'], env)).code).toBe(2);
    expect((await runCli(['--prune'], env)).code).toBe(2);
    expect((await runCli(['--prune', '--check'], env)).code).toBe(2);
  });

  it('proposes allow and ask rules from live annotations (golden) and explains each decision', async () => {
    const r = await runCli([], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(expectGolden('cli-default.stdout.json', r.stdout));
    const block = JSON.parse(r.stdout) as { permissions: { allow: string[]; ask: string[] } };
    expect(block.permissions.allow).toContain('mcp__annotated__get_user');
    expect(block.permissions.allow).toContain('mcp__annotated__get_default');
    expect(block.permissions.allow).toContain('mcp__plugin_db-tools_database__list_items');
    expect(block.permissions.allow).toContain('mcp__local-only__get_user');
    expect(block.permissions.ask).toContain('mcp__annotated__grant_access');
    expect(block.permissions.ask).toContain('mcp__unannotated__get_weather');
    expect(block.permissions.allow.concat(block.permissions.ask).every((rule) => RULE.test(rule))).toBe(true);
    expect(r.stderr).toContain('shared from ~/.claude.json is shadowed by the project definition');
    expect(r.stderr).toContain('oauth-remote  (user, ~/.claude.json)  skipped: entry has oauth');
    expect(r.stderr).toContain('disabled-one (project, .mcp.json) skipped: listed in disabledMcpjsonServers');
    expect(r.stderr).toMatch(/allow {2}get_user\s+readOnlyHint is true/);
    expect(r.stderr).toMatch(/ask {4}grant_access\s+_meta\["anthropic\/requiresUserInteraction"\] is true/);
  });

  it('allows unannotated read verbs only with --heuristic (golden)', async () => {
    const r = await runCli(['--heuristic'], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(expectGolden('cli-heuristic.stdout.json', r.stdout));
    const block = JSON.parse(r.stdout) as { permissions: { allow: string[]; ask: string[] } };
    expect(block.permissions.allow).toContain('mcp__unannotated__get_weather');
    expect(block.permissions.allow).toContain('mcp__unannotated__fetch-url');
    expect(block.permissions.ask).toContain('mcp__unannotated__getdata');
    expect(block.permissions.ask).toContain('mcp__unannotated__send_email');
    expect(block.permissions.ask).toContain('mcp__unannotated__get_consent');
  });

  it('expands ${VAR:-default} in env through the whole pipeline', async () => {
    const r = await runCli(['--server', 'annotated'], env, { EXTRA_TOOL: 'get_custom' });
    const block = JSON.parse(r.stdout) as { permissions: { allow: string[] } };
    expect(block.permissions.allow).toContain('mcp__annotated__get_custom');
    expect(block.permissions.allow).not.toContain('mcp__annotated__get_default');
    expect(block.permissions.allow.some((rule) => rule.startsWith('mcp__unannotated__'))).toBe(false);
  });

  it('filters with --server and warns about names that match nothing', async () => {
    const r = await runCli(['--server', 'unannotated', '--server', 'nothing'], env);
    expect(r.stderr).toContain('--server nothing matches no configured server');
    const block = JSON.parse(r.stdout) as { permissions: { allow: string[]; ask: string[] } };
    expect(block.permissions.allow).toEqual([]);
    expect(block.permissions.ask.every((rule) => rule.startsWith('mcp__unannotated__'))).toBe(true);
  });

  it('shows the diff before writing and reports no changes afterwards', async () => {
    const fresh = makeFakeEnv();
    try {
      const before = await runCli(['--diff'], fresh);
      expect(before.stdout).toContain('Diff against .claude/settings.local.json:');
      expect(before.stdout).toContain('+ allow mcp__annotated__get_user');
      expect(before.stdout).toContain('+ ask   mcp__annotated__delete_item');
      expect(before.stdout).not.toContain('- ');
      const write = await runCli(['--write'], fresh);
      expect(write.code).toBe(0);
      expect(write.stderr).toMatch(/wrote \.claude\/settings\.local\.json: \+\d+\/-0 allow, \+\d+\/-0 ask/);
      const after = await runCli(['--diff'], fresh);
      expect(after.stdout).toContain('(no rule changes)');
    } finally {
      fresh.cleanup();
    }
  });

  it('merges into settings.local.json without touching unrelated keys (golden) and is idempotent', async () => {
    const fresh = makeFakeEnv();
    try {
      const file = path.join(fresh.project, '.claude', 'settings.local.json');
      const first = await runCli(['--write'], fresh);
      expect(first.code).toBe(0);
      expect(first.stderr).toContain('mcp__annotated__delete_item: classified ask but a rule you wrote by hand allows it');
      const text = normalizeGeneratedAt(readFileSync(file, 'utf8'));
      expect(text).toBe(expectGolden('settings.local.json', text));
      const data = readJson(file) as { permissions: { deny: string[]; allow: string[] }; enabledMcpjsonServers: string[]; claudeMcpAllow: { servers: Record<string, Record<string, string>> } };
      expect(Object.keys(data)[0]).toBe('$schema');
      expect(data.permissions.deny).toEqual(['Read(./.env)']);
      expect(data.permissions.allow.slice(0, 2)).toEqual(['Bash(npm test)', 'mcp__annotated__delete_item']);
      expect(data.enabledMcpjsonServers).toEqual(['annotated', 'shared']);
      expect(Object.keys(data.claudeMcpAllow.servers)).toEqual(['local-only', 'annotated', 'shared', 'unannotated', 'plugin_db-tools_database']);
      expect(data.claudeMcpAllow.servers.annotated.get_user).toMatch(/^allow:[0-9a-f]{64}$/);

      const second = await runCli(['--write'], fresh);
      expect(second.stderr).toContain('.claude/settings.local.json is already up to date');
      expect(normalizeGeneratedAt(readFileSync(file, 'utf8'))).toBe(text);
      expect(readJson(file).permissions).toEqual(data.permissions);
    } finally {
      fresh.cleanup();
    }
  });

  it('writes to the project or user settings file with --scope', async () => {
    const fresh = makeFakeEnv();
    try {
      const project = await runCli(['--write', '--scope', 'project', '--server', 'annotated'], fresh);
      expect(project.code).toBe(0);
      const projectFile = path.join(fresh.project, '.claude', 'settings.json');
      expect(readJson(projectFile).permissions).toEqual({
        allow: ['mcp__annotated__get_default', 'mcp__annotated__get_user', 'mcp__annotated__list_items'],
        ask: ['mcp__annotated__delete_item', 'mcp__annotated__get_status', 'mcp__annotated__grant_access', 'mcp__annotated__read_and_wipe', 'mcp__annotated__update_item'],
      });

      const user = await runCli(['--write', '--scope', 'user', '--server', 'unannotated'], fresh);
      expect(user.code).toBe(0);
      const userFile = path.join(fresh.home, '.claude', 'settings.json');
      const data = readJson(userFile) as { enabledPlugins: Record<string, boolean>; permissions: { allow?: string[]; ask: string[] } };
      expect(data.enabledPlugins).toEqual({ 'db-tools@demo-market': true, 'off-plugin@demo-market': false });
      expect(data.permissions.allow).toBeUndefined();
      expect(data.permissions.ask).toContain('mcp__unannotated__get_weather');
      expect(existsSync(path.join(fresh.project, '.claude', 'settings.local.json'))).toBe(true);
    } finally {
      fresh.cleanup();
    }
  });

  it('--check passes after --write and fails on annotation drift, a vanished tool, or a missing marker', async () => {
    const fresh = makeFakeEnv();
    try {
      const none = await runCli(['--check'], fresh);
      expect(none.code).toBe(2);
      expect(none.stderr).toContain('has no claudeMcpAllow marker');

      await runCli(['--write'], fresh);
      const ok = await runCli(['--check'], fresh);
      expect(ok.code).toBe(0);
      expect(ok.stdout).toContain('ok: no drift against .claude/settings.local.json');
      expect(ok.stdout).toContain('info   annotated: delete_item is allowed by a rule this tool did not write');
      expect(ok.stdout).not.toMatch(/^drift/m);

      const flip = await runCli(['--check', '--server', 'annotated'], fresh, { FIXTURE_DRIFT: 'flip' });
      expect(flip.code).toBe(1);
      expect(flip.stdout).toContain('drift  annotated: annotations of get_user changed; it is allowed but is no longer read-only');
      expect(flip.stdout).not.toContain('plugin_db-tools_database');

      const drop = await runCli(['--check', '--server', 'annotated'], fresh, { FIXTURE_DRIFT: 'drop' });
      expect(drop.code).toBe(1);
      expect(drop.stdout).toContain('tool list_items is no longer listed (its allow rule is stale)');

      const added = await runCli(['--check', '--server', 'annotated'], fresh, { EXTRA_TOOL: 'get_more' });
      expect(added.stdout).toContain('info   annotated: new tool get_more is not covered (would be allow)');

      const file = path.join(fresh.project, '.claude', 'settings.local.json');
      const data = readJson(file) as { claudeMcpAllow: { servers: Record<string, unknown> } };
      data.claudeMcpAllow.servers.gone = { get_x: 'allow:0000' };
      writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
      const gone = await runCli(['--check'], fresh);
      expect(gone.code).toBe(1);
      expect(gone.stdout).toContain('drift  gone: server is no longer configured (1 recorded tools)');
    } finally {
      fresh.cleanup();
    }
  }, 120000);

  it('--check honours the heuristic recorded at generation time', async () => {
    const fresh = makeFakeEnv();
    try {
      await runCli(['--write', '--heuristic', '--server', 'unannotated'], fresh);
      const data = readJson(path.join(fresh.project, '.claude', 'settings.local.json')) as { claudeMcpAllow: { heuristic: boolean }; permissions: { allow: string[] } };
      expect(data.claudeMcpAllow.heuristic).toBe(true);
      expect(data.permissions.allow).toContain('mcp__unannotated__get_weather');
      const check = await runCli(['--check', '--server', 'unannotated'], fresh);
      expect(check.code).toBe(0);
      expect(check.stdout).toContain('ok: no drift');
    } finally {
      fresh.cleanup();
    }
  });
});
