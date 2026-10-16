import { describe, expect, it } from 'vitest';
import { CheckError, runCheck } from '../src/check.js';
import { annotationHash } from '../src/classify.js';
import { listServerTools } from '../src/connect.js';
import type { SettingsFile } from '../src/settings.js';
import type { ResolvedServer, ToolRecord } from '../src/types.js';
import { ANNOTATED, FIXTURES, fakeServer } from './helpers.js';

const connect = { timeoutMs: 20000, env: { ...process.env, FIXTURE_DRIFT: '' }, cwd: FIXTURES, clientVersion: 'test' };

function annotatedServer(env: Record<string, string> = {}): ResolvedServer {
  return { ...fakeServer('annotated'), config: { command: 'node', args: [ANNOTATED], env } };
}

function settings(data: Record<string, unknown>): SettingsFile {
  return { path: '/virtual/settings.local.json', exists: true, text: JSON.stringify(data), data, indent: '  ', trailingNewline: true };
}

async function liveTools(): Promise<ToolRecord[]> {
  const result = await listServerTools(annotatedServer(), connect);
  if (result.status !== 'listed') throw new Error(`fixture did not list: ${result.reason}`);
  return result.tools;
}

/** A marker and permissions block that match the fixture exactly as it is now. */
async function cleanSettings(): Promise<Record<string, unknown>> {
  const tools = await liveTools();
  const recorded: Record<string, string> = {};
  const allow: string[] = [];
  const ask: string[] = [];
  for (const tool of tools) {
    const decision = tool.name === 'get_user' || tool.name === 'list_items' ? 'allow' : 'ask';
    recorded[tool.name] = `${decision}:${annotationHash(tool)}`;
    (decision === 'allow' ? allow : ask).push(`mcp__annotated__${tool.name}`);
  }
  return {
    permissions: { allow, ask },
    claudeMcpAllow: { generatedBy: 'test', generatedAt: '', heuristic: false, servers: { annotated: recorded } },
  };
}

describe('runCheck', () => {
  it('refuses a settings file without a marker', async () => {
    await expect(runCheck({ settings: settings({}), servers: [], connect })).rejects.toBeInstanceOf(CheckError);
  });

  it('reports no findings when the server matches the marker', async () => {
    const result = await runCheck({ settings: settings(await cleanSettings()), servers: [annotatedServer()], connect });
    expect(result).toEqual({ ok: true, findings: [], heuristic: false });
  });

  it('reports an allowed tool whose annotations changed and a tool that disappeared', async () => {
    const data = await cleanSettings();
    const flipped = await runCheck({ settings: settings(data), servers: [annotatedServer({ FIXTURE_DRIFT: 'flip' })], connect });
    expect(flipped.ok).toBe(false);
    expect(flipped.findings).toEqual([
      expect.objectContaining({ level: 'drift', server: 'annotated', message: expect.stringContaining('annotations of get_user changed; it is allowed but is no longer read-only') }),
    ]);
    const dropped = await runCheck({ settings: settings(data), servers: [annotatedServer({ FIXTURE_DRIFT: 'drop' })], connect });
    expect(dropped.findings).toEqual([
      expect.objectContaining({ level: 'drift', message: 'tool list_items is no longer listed (its allow rule is stale)' }),
    ]);
  });

  it('reports servers that are gone, new tools as info, and honours the only filter', async () => {
    const data = await cleanSettings();
    const marker = data.claudeMcpAllow as { servers: Record<string, Record<string, string>> };
    const recorded = marker.servers.annotated;
    delete recorded.get_status;
    marker.servers.gone = { read: 'allow:abc' };
    const result = await runCheck({ settings: settings(data), servers: [annotatedServer()], connect });
    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual({ level: 'drift', server: 'gone', message: 'server is no longer configured (1 recorded tools)' });
    expect(result.findings).toContainEqual({
      level: 'info',
      server: 'annotated',
      message: 'new tool get_status is not covered (would be ask); re-run with --write to add it',
    });
    const onlyAnnotated = await runCheck({ settings: settings(data), servers: [annotatedServer()], only: new Set(['annotated']), connect });
    expect(onlyAnnotated.ok).toBe(true);
    expect(onlyAnnotated.findings.map((f) => f.server)).toEqual(['annotated']);
  });

  it('notes a hand-written allow rule on a tool classified ask, and a server it cannot reach', async () => {
    const data = await cleanSettings();
    (data.permissions as { allow: string[] }).allow.push('mcp__annotated__delete_item');
    const result = await runCheck({ settings: settings(data), servers: [annotatedServer()], connect });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([expect.objectContaining({ level: 'info', message: expect.stringContaining('delete_item is allowed by a rule this tool did not write') })]);
    const broken: ResolvedServer = { ...fakeServer('annotated'), config: { command: 'node', args: [`${FIXTURES}/does-not-exist.mjs`] } };
    const unreachable = await runCheck({ settings: settings(data), servers: [broken], connect: { ...connect, timeoutMs: 10000 } });
    expect(unreachable.findings).toEqual([expect.objectContaining({ level: 'drift', message: expect.stringContaining('could not verify') })]);
  });

  it('treats a bare hash without a decision as allowed only when an allow rule exists', async () => {
    const tools = await liveTools();
    const updateItem = tools.find((t) => t.name === 'update_item')!;
    const data = {
      permissions: { allow: ['mcp__annotated__update_item'] },
      claudeMcpAllow: { heuristic: false, servers: { annotated: { update_item: annotationHash(updateItem) } } },
    };
    const result = await runCheck({ settings: settings(data), servers: [annotatedServer()], only: new Set(['annotated']), connect });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ level: 'drift', message: expect.stringContaining('update_item is allowed but would not be allowed now') }),
    );
  });
});
