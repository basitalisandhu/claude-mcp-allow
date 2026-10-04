import { describe, expect, it } from 'vitest';
import { annotationHash, buildPlan, classifyTool, isGlobRule, parseRule, ruleFor } from '../src/classify.js';
import { fakeServer, fakeTool } from './helpers.js';

const off = { heuristic: false };
const on = { heuristic: true };

describe('classification', () => {
  it('allows readOnlyHint true when destructiveHint is not true', () => {
    expect(classifyTool({ name: 'get_user', annotations: { readOnlyHint: true } }, off).decision).toBe('allow');
    expect(classifyTool({ name: 'get_user', annotations: { readOnlyHint: true, destructiveHint: false } }, off).decision).toBe('allow');
  });

  it('asks when destructiveHint is true, even next to readOnlyHint true', () => {
    expect(classifyTool({ name: 'delete_item', annotations: { destructiveHint: true } }, off).decision).toBe('ask');
    const both = classifyTool({ name: 'x', annotations: { readOnlyHint: true, destructiveHint: true } }, off);
    expect(both.decision).toBe('ask');
    expect(both.reason).toContain('destructive');
  });

  it('asks for annotated tools that are not marked read-only, with or without --heuristic', () => {
    const tool = { name: 'get_thing', annotations: { readOnlyHint: false } };
    expect(classifyTool(tool, off).decision).toBe('ask');
    expect(classifyTool(tool, on).decision).toBe('ask');
    expect(classifyTool({ name: 'get_x', annotations: { destructiveHint: false } }, on).decision).toBe('ask');
  });

  it('asks for unannotated tools by default', () => {
    expect(classifyTool({ name: 'get_weather' }, off)).toEqual({ decision: 'ask', reason: 'no annotations' });
    expect(classifyTool({ name: 'get_weather', annotations: {} }, off).decision).toBe('ask');
    expect(classifyTool({ name: 'get_weather', annotations: { openWorldHint: true } }, off).decision).toBe('ask');
  });

  it('allows unannotated read verbs only with --heuristic and only with a separator', () => {
    for (const name of ['get_weather', 'list-files', 'read_file', 'search_docs', 'find_x', 'fetch-url', 'describe_table', 'show_status', 'query_db', 'count_rows', 'lookup_user']) {
      expect(classifyTool({ name }, on).decision, name).toBe('allow');
    }
    for (const name of ['getdata', 'send_email', 'delete_all', 'update_record', 'run_job', 'getter_x', 'listing_y']) {
      expect(classifyTool({ name }, on).decision, name).toBe('ask');
    }
  });

  it('asks whenever _meta anthropic/requiresUserInteraction is the boolean true', () => {
    const meta = { 'anthropic/requiresUserInteraction': true };
    expect(classifyTool({ name: 'grant_access', annotations: { readOnlyHint: true }, meta }, off).decision).toBe('ask');
    expect(classifyTool({ name: 'get_consent', meta }, on).decision).toBe('ask');
  });

  it('ignores a non-boolean requiresUserInteraction value, as Claude Code does', () => {
    const meta = { 'anthropic/requiresUserInteraction': 'true' };
    expect(classifyTool({ name: 'get_flag', annotations: { readOnlyHint: true }, meta }, off).decision).toBe('allow');
  });
});

describe('annotation hash and rules', () => {
  it('is stable, ignores description and key order, and changes with annotations or the meta flag', () => {
    const a = annotationHash({ name: 'x', annotations: { readOnlyHint: true, destructiveHint: false } });
    const b = annotationHash({ name: 'x', annotations: { destructiveHint: false, readOnlyHint: true } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(annotationHash({ name: 'x', annotations: { readOnlyHint: false, destructiveHint: false } })).not.toBe(a);
    expect(annotationHash({ name: 'x', annotations: { readOnlyHint: true, destructiveHint: false }, meta: { 'anthropic/requiresUserInteraction': true } })).not.toBe(a);
    expect(annotationHash({ name: 'y' })).toBe(annotationHash({ name: 'z' }));
  });

  it('emits mcp__<server>__<tool> and never a glob', () => {
    expect(ruleFor('github', 'get_issue')).toBe('mcp__github__get_issue');
    expect(ruleFor('plugin_db-tools_database', 'query')).toBe('mcp__plugin_db-tools_database__query');
    expect(isGlobRule('mcp__github__*')).toBe(true);
    expect(parseRule('mcp__github__get_issue')).toEqual({ ruleServer: 'github', tool: 'get_issue' });
    expect(parseRule('mcp__github')).toBeUndefined();
    expect(parseRule('Bash(npm test)')).toBeUndefined();
    const server = fakeServer('s');
    const plan = buildPlan(
      [{ server, status: 'listed', tools: [fakeTool('s', 'b_tool', 'allow'), fakeTool('s', 'a_tool', 'allow'), fakeTool('s', 'c', 'ask'), { ...fakeTool('s', 'star', 'allow'), rule: 'mcp__s__*' }] }],
      false,
    );
    expect(plan.allow).toEqual(['mcp__s__a_tool', 'mcp__s__b_tool']);
    expect(plan.ask).toEqual(['mcp__s__c']);
    expect(plan.allow.concat(plan.ask).every((r) => /^mcp__[^*]+__[^*]+$/.test(r))).toBe(true);
  });
});
