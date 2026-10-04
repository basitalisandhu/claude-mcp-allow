import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { authStatus, listServerTools } from '../src/connect.js';
import type { ResolvedServer } from '../src/types.js';
import { ANNOTATED, FIXTURES, fakeServer } from './helpers.js';

const opts = { timeoutMs: 20000, env: process.env, cwd: FIXTURES, clientVersion: 'test' };

function server(config: ResolvedServer['config']): ResolvedServer {
  return { ...fakeServer('s'), config };
}

describe('connecting to servers', () => {
  it('lists stdio tools with annotations and _meta passed through', async () => {
    const result = await listServerTools(server({ command: 'node', args: [ANNOTATED] }), opts);
    expect(result.status).toBe('listed');
    if (result.status !== 'listed') return;
    const names = result.tools.map((t) => t.name);
    expect(names).toEqual(['get_user', 'list_items', 'delete_item', 'update_item', 'read_and_wipe', 'grant_access', 'get_status']);
    expect(result.tools[0].annotations).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(result.tools.find((t) => t.name === 'grant_access')?.meta).toEqual({ 'anthropic/requiresUserInteraction': true });
  });

  it('skips entries with oauth and fails clearly for a command that cannot start', async () => {
    const oauth = await listServerTools(server({ type: 'http', url: 'https://example.invalid/mcp', oauth: {} }), opts);
    expect(oauth).toEqual({ status: 'skipped', reason: expect.stringContaining('oauth') });
    const broken = await listServerTools(server({ command: 'node', args: [path.join(FIXTURES, 'does-not-exist.mjs')] }), { ...opts, timeoutMs: 10000 });
    expect(broken.status).toBe('failed');
  });

  it('times out instead of hanging on a server that never answers', async () => {
    const result = await listServerTools(server({ command: 'node', args: ['-e', 'setInterval(() => {}, 1000)'] }), { ...opts, timeoutMs: 1500 });
    expect(result).toEqual({ status: 'failed', reason: expect.stringContaining('timed out') });
  });

  it('connects over Streamable HTTP with expanded headers and skips a 401 answer', async () => {
    const { start } = await import('./fixtures/http-fixture.mjs');
    const fixture = await start({ token: 'secret-token' });
    try {
      const ok = await listServerTools(server({ type: 'http', url: fixture.url, headers: { Authorization: 'Bearer secret-token' } }), opts);
      expect(ok.status).toBe('listed');
      if (ok.status === 'listed') expect(ok.tools.map((t) => t.name)).toEqual(['get_record', 'drop_table']);
      expect(fixture.requests[0].authorization).toBe('Bearer secret-token');

      const unauthorized = await listServerTools(server({ type: 'http', url: fixture.url, headers: { Authorization: 'Bearer wrong' } }), opts);
      expect(unauthorized).toEqual({ status: 'skipped', reason: expect.stringContaining('401') });

      const untyped = await listServerTools(server({ url: fixture.url, headers: { Authorization: 'Bearer secret-token' } }), opts);
      expect(untyped.status).toBe('listed');
    } finally {
      await fixture.close();
    }
  });

  it('recognises authentication errors from the SDK transports', () => {
    expect(authStatus(new Error('Error POSTing to endpoint (HTTP 401): nope'))).toBe(401);
    expect(authStatus(new Error('SSE error: Non-200 status code (403)'))).toBe(403);
    expect(authStatus(new Error('fetch failed: getaddrinfo ENOTFOUND 401.example'))).toBeUndefined();
    expect(authStatus(new Error('timed out after 401 ms'))).toBeUndefined();
  });
});
