// Scaling test: merging a plan of 2,000 and 20,000 tools into a settings file that already holds rules.
// Linear growth gives about 10 times the runtime for 10 times the tools; the merge used Array.includes
// inside its loops, which made 20,000 tools take most of a second.
import { expect, it } from 'vitest';
import { buildPlan, classifyTools } from '../src/classify.js';
import { mergeIntoSettings, type SettingsFile } from '../src/settings.js';
import type { ResolvedServer, ServerReport } from '../src/types.js';

function merge(n: number): { ms: number; added: number } {
  const tools = Array.from({ length: n }, (_, i) => ({
    name: `tool_${i}`,
    annotations: i % 2 ? { readOnlyHint: true } : { destructiveHint: true },
  }));
  const server = { ruleServer: 'big', displayName: 'big', origin: 'project', source: '.mcp.json' } as unknown as ResolvedServer;
  const report: ServerReport = { server, status: 'listed', tools: classifyTools('big', tools as never, { heuristic: false }) };
  const plan = buildPlan([report], false);
  const existing = plan.allow.slice(0, n / 4).concat(Array.from({ length: n / 4 }, (_, i) => `Bash(x${i})`));
  const file: SettingsFile = { path: 's.json', exists: true, text: '', data: { permissions: { allow: existing, ask: [] } }, indent: '  ', trailingNewline: true };
  const start = performance.now();
  const result = mergeIntoSettings(file, { plan, now: '2026-10-28T00:00:00Z', version: 'test', prune: false });
  return { ms: performance.now() - start, added: result.added.allow.length + result.added.ask.length };
}

it('merging grows linearly with the number of tools', () => {
  merge(500); // warm up
  const small = merge(2_000);
  const big = merge(20_000);
  expect(big.added).toBe(10 * small.added);
  expect(big.ms, `2,000 tools: ${small.ms.toFixed(0)} ms, 20,000 tools: ${big.ms.toFixed(0)} ms`).toBeLessThan(Math.max(small.ms, 10) * 30);
});
