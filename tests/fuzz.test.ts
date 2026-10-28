// Seeded fuzz tests: bad bytes and wrong value types in every configuration and settings file the CLI
// reads, run through main() with a time limit per run. Every run must end with exit code 0, 1 or 2 and
// no exception. Server commands point at a program that does not exist and URLs at a closed local port,
// so nothing real is started or contacted.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NO_SUCH = 'claude-mcp-allow-fuzz-no-such-program';
const WRONG: unknown[] = [null, true, 7, -1.5, NO_SUCH, [], {}, [1, [2]], { a: { b: null } }, '\u0000', 'https://127.0.0.1:9/mcp'];
const BAD: Record<string, string> = {
  empty: '',
  truncated: '{"mcpServers": {"x": [',
  array: '[1, 2]',
  deep: '['.repeat(100_000) + ']'.repeat(100_000),
  nul: '\u0000\u0000',
  notUtf8: Buffer.from([0xff, 0xfe, 0x00, 0x7b]).toString('latin1'),
};

const sink = () =>
  new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });

let savedHome: string | undefined;
let savedConfigDir: string | undefined;
beforeAll(() => {
  savedHome = process.env.HOME;
  savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
});
afterAll(() => {
  process.env.HOME = savedHome;
  if (savedConfigDir !== undefined) process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
});

interface Layout {
  root: string;
  home: string;
  project: string;
  managed: string;
}

function layout(): Layout {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cma-fuzz-'));
  const l = { root, home: path.join(root, 'home'), project: path.join(root, 'project'), managed: path.join(root, 'managed') };
  for (const d of [l.home, path.join(l.project, '.claude'), l.managed]) mkdirSync(d, { recursive: true });
  return l;
}

const BASE: Record<string, (l: Layout) => [string, unknown]> = {
  mcp: (l) => [path.join(l.project, '.mcp.json'), { mcpServers: { s1: { command: NO_SUCH, args: ['a'] }, h1: { type: 'http', url: 'https://127.0.0.1:9/mcp' } } }],
  claudeJson: (l) => [
    path.join(l.home, '.claude.json'),
    { mcpServers: { u1: { command: NO_SUCH } }, projects: { [l.project]: { mcpServers: { p1: { command: NO_SUCH } } } } },
  ],
  local: (l) => [path.join(l.project, '.claude', 'settings.local.json'), { permissions: { allow: ['mcp__s1__get'], ask: [] }, enabledMcpjsonServers: ['s1'] }],
  project: (l) => [path.join(l.project, '.claude', 'settings.json'), { permissions: { deny: ['mcp__s1__delete'] }, enableAllProjectMcpServers: true }],
  managedMcp: (l) => [path.join(l.managed, 'managed-mcp.json'), { mcpServers: { m1: { type: 'http', url: 'https://127.0.0.1:9/m' } } }],
  managedSettings: (l) => [path.join(l.managed, 'managed-settings.json'), { allowedMcpServers: [{ serverName: 's1' }], deniedMcpServers: [] }],
};

function write(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

async function runAll(l: Layout): Promise<void> {
  process.env.HOME = l.home;
  for (const extra of [[], ['--diff'], ['--check']]) {
    const argv = ['--cwd', l.project, '--managed-dir', l.managed, '--timeout', '2000', ...extra];
    const start = performance.now();
    let code: number;
    try {
      code = await main(argv, { out: sink(), err: sink() } as unknown as { out: NodeJS.WriteStream; err: NodeJS.WriteStream });
    } catch (err) {
      throw new Error(`claude-mcp-allow ${argv.join(' ')} threw: ${(err as Error).stack}`);
    }
    expect([0, 1, 2]).toContain(code);
    expect(performance.now() - start).toBeLessThan(15_000);
  }
}

function paths(node: unknown, prefix: (string | number)[] = []): (string | number)[][] {
  const out = [prefix];
  if (Array.isArray(node)) node.forEach((v, i) => out.push(...paths(v, [...prefix, i])));
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) out.push(...paths(v, [...prefix, k]));
  return out;
}

describe('fuzz', () => {
  for (const [name, make] of Object.entries(BASE)) {
    it(`bad bytes in ${name} never throw`, async () => {
      for (const [kind, text] of Object.entries(BAD)) {
        const l = layout();
        for (const other of Object.values(BASE)) {
          const [file, doc] = other(l);
          write(file, JSON.stringify(doc));
        }
        const [file] = make(l);
        write(file, text);
        await runAll(l);
        expect(kind).toBeTruthy();
      }
    }, 120_000);

    it(`wrong value types in ${name} never throw`, async () => {
      const r = rng(name.length * 7919);
      for (let trial = 0; trial < 12; trial++) {
        const l = layout();
        for (const other of Object.values(BASE)) {
          const [file, doc] = other(l);
          write(file, JSON.stringify(doc));
        }
        const [file, original] = make(l);
        let doc = JSON.parse(JSON.stringify(original)) as unknown;
        const all = paths(doc).filter((p) => p.length > 0);
        const target = all[Math.floor(r() * all.length)];
        const value = JSON.parse(JSON.stringify(WRONG[Math.floor(r() * WRONG.length)] ?? null)) as unknown;
        if (target === undefined) doc = value;
        else {
          let node = doc as Record<string | number, unknown>;
          for (const key of target.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
          node[target[target.length - 1]] = value;
        }
        write(file, JSON.stringify(doc));
        await runAll(l);
      }
    }, 120_000);
  }
});
