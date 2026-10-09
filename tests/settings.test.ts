import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SettingsError, allowedMcpRules, localSettingsRoot, mergeIntoSettings, parseMarkerValue, readMarker, readSettingsFile, settingsPathFor } from '../src/settings.js';
import { expectGolden, fakePlan, tempDir, writeJson } from './helpers.js';

const NOW = '2026-10-03T00:00:00.000Z';
const ctx = (cwd: string, home: string, platform: NodeJS.Platform = 'linux') => ({ cwd, home, configDir: path.join(home, '.claude'), platform });

describe('settings file locations', () => {
  it('maps scopes to the documented files', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const cwd = path.join(home, 'proj');
    mkdirSync(cwd, { recursive: true });
    expect(settingsPathFor('user', ctx(cwd, home))).toBe(path.join(home, '.claude', 'settings.json'));
    expect(settingsPathFor('project', ctx(cwd, home))).toBe(path.join(cwd, '.claude', 'settings.json'));
    expect(settingsPathFor('local', ctx(cwd, home))).toBe(path.join(cwd, '.claude', 'settings.local.json'));
  });

  it('uses the git repository root for local settings, resolved through a worktree, except at home or on Windows', () => {
    const root = tempDir();
    const home = path.join(root, 'home');
    const repo = path.join(home, 'repo');
    const sub = path.join(repo, 'packages', 'a');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(sub, { recursive: true });
    expect(localSettingsRoot(ctx(sub, home))).toBe(repo);
    expect(localSettingsRoot(ctx(sub, home, 'win32'))).toBe(sub);

    const wt = path.join(home, 'wt');
    mkdirSync(wt, { recursive: true });
    writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`);
    expect(localSettingsRoot(ctx(path.join(wt), home))).toBe(repo);

    mkdirSync(path.join(home, '.git'), { recursive: true });
    const homeChild = path.join(home, 'loose');
    mkdirSync(homeChild, { recursive: true });
    expect(localSettingsRoot(ctx(homeChild, home))).toBe(homeChild);
  });

  it('reads a missing file as empty, detects indentation, and rejects invalid JSON', () => {
    const dir = tempDir();
    const missing = readSettingsFile(path.join(dir, 'none.json'));
    expect(missing.exists).toBe(false);
    expect(missing.data).toEqual({});
    writeFileSync(path.join(dir, 'four.json'), '{\n    "a": 1\n}');
    const four = readSettingsFile(path.join(dir, 'four.json'));
    expect(four.indent).toBe('    ');
    expect(four.trailingNewline).toBe(false);
    writeFileSync(path.join(dir, 'bad.json'), '{ "a": 1, }');
    expect(() => readSettingsFile(path.join(dir, 'bad.json'))).toThrow(SettingsError);
  });
});

describe('merging rules into settings', () => {
  it('prunes only recorded rules for servers no longer configured when explicitly requested', () => {
    const file = path.join(tempDir(), 'settings.json');
    const initial = mergeIntoSettings(readSettingsFile(file), {
      plan: fakePlan({ old: { read: 'allow', write: 'ask' }, active: { read: 'allow' } }),
      now: NOW, version: '0.1.0',
    });
    const data = initial.data;
    (data.permissions as { allow: string[] }).allow.push('mcp__old__manual');
    writeJson(file, data);
    const next = { plan: fakePlan({ active: { read: 'allow' } }), now: NOW, version: '0.1.0' };
    expect(readMarker(mergeIntoSettings(readSettingsFile(file), next).data)!.servers.old).toBeDefined();
    const pruned = mergeIntoSettings(readSettingsFile(file), { ...next, prune: true });
    expect(readMarker(pruned.data)!.servers.old).toBeUndefined();
    expect(pruned.removed).toEqual({ allow: ['mcp__old__read'], ask: ['mcp__old__write'] });
    expect((pruned.data.permissions as { allow: string[] }).allow).toContain('mcp__old__manual');
    expect(pruned.pruned).toEqual([{ server: 'old', rules: 2 }]);
  });

  it('preserves a configured server that was not listed successfully', () => {
    const file = path.join(tempDir(), 'settings.json');
    const initial = mergeIntoSettings(readSettingsFile(file), {
      plan: fakePlan({ failed: { read: 'allow' } }), now: NOW, version: '0.1.0',
    });
    writeFileSync(file, initial.text);
    const next = mergeIntoSettings(readSettingsFile(file), {
      plan: fakePlan({}), configuredServers: ['failed'], prune: true, now: NOW, version: '0.1.0',
    });
    expect(readMarker(next.data)!.servers.failed).toBeDefined();
    expect(next.removed.allow).toEqual([]);
  });
  const existing = {
    $schema: 'https://json.schemastore.org/claude-code-settings.json',
    permissions: { deny: ['Read(./.env)', 'mcp__s1__denied'], allow: ['Bash(npm test)', 'mcp__s1__by_hand'] },
    enabledMcpjsonServers: ['s1'],
  };

  it('preserves key order, indentation and unrelated rules, and adds the marker (golden)', () => {
    const dir = tempDir();
    const file = path.join(dir, 'settings.local.json');
    writeJson(file, existing, 4);
    const plan = fakePlan({ s1: { get_a: 'allow', denied: 'allow', by_hand: 'ask', delete_b: 'ask' }, s2: { list_c: 'allow' } });
    const merged = mergeIntoSettings(readSettingsFile(file), { plan, now: NOW, version: '0.1.0' });
    expect(Object.keys(merged.data)).toEqual(['$schema', 'permissions', 'enabledMcpjsonServers', 'claudeMcpAllow']);
    expect(Object.keys(merged.data.permissions as object)).toEqual(['deny', 'allow', 'ask']);
    expect(merged.added.allow).toEqual(['mcp__s1__get_a', 'mcp__s2__list_c']);
    expect(merged.added.ask).toEqual(['mcp__s1__by_hand', 'mcp__s1__delete_b']);
    expect(merged.removed).toEqual({ allow: [], ask: [] });
    expect(merged.warnings.join('\n')).toContain('mcp__s1__denied');
    expect(merged.warnings.join('\n')).toContain('mcp__s1__by_hand');
    expect(merged.text.startsWith('{\n    "$schema"')).toBe(true);
    expect(merged.text).toBe(expectGolden('merge-basic.json', merged.text));
  });

  it('replaces rules it wrote earlier, keeps hand-written ones, and is idempotent', () => {
    const dir = tempDir();
    const file = path.join(dir, 'settings.local.json');
    writeJson(file, existing);
    const first = mergeIntoSettings(readSettingsFile(file), { plan: fakePlan({ s1: { get_a: 'allow', by_hand: 'ask', old_tool: 'allow' } }), now: NOW, version: '0.1.0' });
    writeFileSync(file, first.text);

    const again = mergeIntoSettings(readSettingsFile(file), { plan: fakePlan({ s1: { get_a: 'allow', by_hand: 'ask', old_tool: 'allow' } }), now: NOW, version: '0.1.0' });
    expect(again.changed).toBe(false);
    expect(again.added).toEqual({ allow: [], ask: [] });
    expect(again.removed).toEqual({ allow: [], ask: [] });

    // old_tool disappeared and get_a is now destructive: the generated rules move, hand-written ones stay
    const second = mergeIntoSettings(readSettingsFile(file), { plan: fakePlan({ s1: { get_a: 'ask', by_hand: 'ask' } }), now: NOW, version: '0.1.0' });
    const permissions = second.data.permissions as { allow: string[]; ask: string[]; deny: string[] };
    expect(permissions.allow).toEqual(['Bash(npm test)', 'mcp__s1__by_hand']);
    expect(permissions.ask).toEqual(['mcp__s1__by_hand', 'mcp__s1__get_a']);
    expect(permissions.deny).toEqual(existing.permissions.deny);
    expect(second.removed.allow).toEqual(['mcp__s1__get_a', 'mcp__s1__old_tool']);
    expect(second.added.ask).toEqual(['mcp__s1__get_a']);
  });

  it('keeps marker entries and rules of servers that were not listed this run', () => {
    const dir = tempDir();
    const file = path.join(dir, 'settings.local.json');
    writeJson(file, {});
    const both = mergeIntoSettings(readSettingsFile(file), { plan: fakePlan({ s1: { get_a: 'allow' }, s2: { get_b: 'allow' } }), now: NOW, version: '0.1.0' });
    writeFileSync(file, both.text);
    const onlyS1 = mergeIntoSettings(readSettingsFile(file), { plan: fakePlan({ s1: { get_c: 'allow' } }), now: NOW, version: '0.1.0' });
    const marker = readMarker(onlyS1.data)!;
    expect(Object.keys(marker.servers)).toEqual(['s1', 's2']);
    expect(Object.keys(marker.servers.s1)).toEqual(['get_c']);
    expect(parseMarkerValue(marker.servers.s2.get_b)).toEqual({ decision: 'allow', hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((onlyS1.data.permissions as { allow: string[] }).allow).toEqual(['mcp__s2__get_b', 'mcp__s1__get_c']);
    expect(marker.generatedBy).toBe('claude-mcp-allow 0.1.0');
    expect(marker.generatedAt).toBe(NOW);
    expect(marker.heuristic).toBe(false);
  });

  it('refuses a permissions key that is not an object and lists MCP allow rules', () => {
    const dir = tempDir();
    const file = path.join(dir, 'settings.json');
    writeJson(file, { permissions: [] });
    expect(() => mergeIntoSettings(readSettingsFile(file), { plan: fakePlan({}), now: NOW, version: '0.1.0' })).toThrow(SettingsError);
    expect(allowedMcpRules({ permissions: { allow: ['Bash(ls)', 'mcp__s__t', 'mcp__s'] } })).toEqual(new Set(['mcp__s__t']));
    expect(parseMarkerValue('abc')).toEqual({ decision: undefined, hash: 'abc' });
    expect(readFileSync(file, 'utf8')).toContain('permissions');
  });
});
