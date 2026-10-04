import { annotationHash, classifyTool, ruleFor } from './classify.js';
import { listServerTools, type ConnectOptions } from './connect.js';
import { allowedMcpRules, parseMarkerValue, readMarker, type SettingsFile } from './settings.js';
import type { ResolvedServer } from './types.js';

export interface Finding {
  level: 'drift' | 'info';
  server: string;
  message: string;
}

export interface CheckResult {
  ok: boolean;
  findings: Finding[];
  heuristic: boolean;
}

export class CheckError extends Error {}

export interface CheckOptions {
  settings: SettingsFile;
  servers: ResolvedServer[];
  /** Restrict to these rule-server segments; undefined checks every recorded server. */
  only?: Set<string>;
  heuristic?: boolean;
  connect: ConnectOptions;
}

/**
 * Reconnect to every server recorded in the marker, recompute annotation
 * hashes and report drift: a changed hash, a tool that disappeared, an allowed
 * tool that is no longer read-only, a server that cannot be verified.
 */
export async function runCheck(opts: CheckOptions): Promise<CheckResult> {
  const marker = readMarker(opts.settings.data);
  if (!marker) {
    throw new CheckError(`${opts.settings.path} has no claudeMcpAllow marker; run claude-mcp-allow --write first`);
  }
  const heuristic = opts.heuristic ?? marker.heuristic;
  const allowed = allowedMcpRules(opts.settings.data);
  const findings: Finding[] = [];
  const byRuleServer = new Map(opts.servers.map((s) => [s.ruleServer, s]));

  for (const [ruleServer, recorded] of Object.entries(marker.servers)) {
    if (opts.only && !opts.only.has(ruleServer)) continue;
    const server = byRuleServer.get(ruleServer);
    const recordedTools = Object.keys(recorded);
    if (!server) {
      findings.push({ level: 'drift', server: ruleServer, message: `server is no longer configured (${recordedTools.length} recorded tools)` });
      continue;
    }
    const result = await listServerTools(server, opts.connect);
    if (result.status !== 'listed') {
      findings.push({ level: 'drift', server: ruleServer, message: `could not verify: ${result.reason}` });
      continue;
    }
    const live = new Map(result.tools.map((t) => [t.name, t]));
    for (const [tool, value] of Object.entries(recorded)) {
      const { decision: recordedDecision, hash } = parseMarkerValue(value);
      const rule = ruleFor(ruleServer, tool);
      const allowedNow = allowed.has(rule);
      // "allowed" means allowed by a rule this tool wrote; a marker without a decision falls back to the settings file
      const wasAllowed = recordedDecision ? recordedDecision === 'allow' : allowedNow;
      const current = live.get(tool);
      if (!current) {
        findings.push({ level: 'drift', server: ruleServer, message: `tool ${tool} is no longer listed${wasAllowed && allowedNow ? ' (its allow rule is stale)' : ''}` });
        continue;
      }
      const decision = classifyTool(current, { heuristic });
      if (annotationHash(current) !== hash) {
        const extra = wasAllowed && decision.decision !== 'allow' ? `; it is allowed but is no longer read-only (${decision.reason})` : '';
        findings.push({ level: 'drift', server: ruleServer, message: `annotations of ${tool} changed${extra}` });
        continue;
      }
      if (wasAllowed && decision.decision !== 'allow') {
        findings.push({ level: 'drift', server: ruleServer, message: `${tool} is allowed but would not be allowed now (${decision.reason})` });
        continue;
      }
      if (!wasAllowed && allowedNow && decision.decision !== 'allow') {
        findings.push({ level: 'info', server: ruleServer, message: `${tool} is allowed by a rule this tool did not write; the generated ask rule is evaluated first and prompts` });
      }
    }
    for (const tool of result.tools) {
      if (!(tool.name in recorded)) {
        const decision = classifyTool(tool, { heuristic });
        findings.push({ level: 'info', server: ruleServer, message: `new tool ${tool.name} is not covered (would be ${decision.decision}); re-run with --write to add it` });
      }
    }
  }
  return { ok: !findings.some((f) => f.level === 'drift'), findings, heuristic };
}
