import { createHash } from 'node:crypto';
import type { Classification, ClassifiedTool, Plan, ServerReport, ToolRecord } from './types.js';

/** Read verbs accepted by `--heuristic`. The separator is required, so `getdata` does not match. */
export const READ_VERB_RE = /^(get|list|read|search|find|fetch|describe|show|query|count|lookup)[_-]/;

export const REQUIRES_USER_INTERACTION_KEY = 'anthropic/requiresUserInteraction';

export interface ClassifyOptions {
  heuristic: boolean;
}

/** True when the tool says something about read-only or destructive behaviour. */
export function hasPermissionAnnotations(annotations: Record<string, unknown> | undefined): boolean {
  if (!annotations || typeof annotations !== 'object') return false;
  return 'readOnlyHint' in annotations || 'destructiveHint' in annotations;
}

/** The value must be the JSON boolean `true`; anything else is ignored, as Claude Code does. */
export function requiresUserInteraction(tool: ToolRecord): boolean {
  return tool.meta?.[REQUIRES_USER_INTERACTION_KEY] === true;
}

export function classifyTool(tool: ToolRecord, opts: ClassifyOptions): Classification {
  if (requiresUserInteraction(tool)) {
    return { decision: 'ask', reason: `_meta["${REQUIRES_USER_INTERACTION_KEY}"] is true; Claude Code prompts on every call` };
  }
  const a = tool.annotations;
  if (hasPermissionAnnotations(a)) {
    const readOnly = a?.readOnlyHint === true;
    const destructive = a?.destructiveHint === true;
    if (readOnly && !destructive) return { decision: 'allow', reason: 'readOnlyHint is true' };
    if (destructive) {
      return readOnly
        ? { decision: 'ask', reason: 'destructiveHint is true (readOnlyHint is also true; the destructive hint wins)' }
        : { decision: 'ask', reason: 'destructiveHint is true' };
    }
    return { decision: 'ask', reason: 'annotated but not marked read-only' };
  }
  if (opts.heuristic && READ_VERB_RE.test(tool.name)) {
    return { decision: 'allow', reason: 'no annotations; name starts with a read verb (--heuristic)' };
  }
  return { decision: 'ask', reason: opts.heuristic ? 'no annotations; name is not a read verb' : 'no annotations' };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * SHA-256 over the canonical JSON of the tool's annotations and its
 * requiresUserInteraction flag. The description and schema are not included,
 * so the hash changes only when the inputs to classification change.
 */
export function annotationHash(tool: ToolRecord): string {
  const subject = canonical({
    annotations: tool.annotations && typeof tool.annotations === 'object' ? tool.annotations : null,
    requiresUserInteraction: requiresUserInteraction(tool),
  });
  return createHash('sha256').update(JSON.stringify(subject)).digest('hex');
}

/** `mcp__<server>__<tool>`. Never a glob. */
export function ruleFor(ruleServer: string, toolName: string): string {
  return `mcp__${ruleServer}__${toolName}`;
}

export function isGlobRule(rule: string): boolean {
  return rule.includes('*');
}

export function parseRule(rule: string): { ruleServer: string; tool: string } | undefined {
  if (!rule.startsWith('mcp__')) return undefined;
  const rest = rule.slice('mcp__'.length);
  const at = rest.indexOf('__');
  if (at <= 0) return undefined;
  const tool = rest.slice(at + 2);
  if (!tool) return undefined;
  return { ruleServer: rest.slice(0, at), tool };
}

export function classifyTools(ruleServer: string, tools: ToolRecord[], opts: ClassifyOptions): ClassifiedTool[] {
  return tools.map((tool) => {
    const c = classifyTool(tool, opts);
    return { ...tool, decision: c.decision, reason: c.reason, hash: annotationHash(tool), rule: ruleFor(ruleServer, tool.name) };
  });
}

/** Collect sorted, de-duplicated rule lists from the per-server reports. */
export function buildPlan(reports: ServerReport[], heuristic: boolean): Plan {
  const allow = new Set<string>();
  const ask = new Set<string>();
  for (const report of reports) {
    if (report.status !== 'listed') continue;
    for (const tool of report.tools) {
      if (isGlobRule(tool.rule)) continue;
      (tool.decision === 'allow' ? allow : ask).add(tool.rule);
    }
  }
  return { allow: [...allow].sort(), ask: [...ask].sort(), reports, heuristic };
}
