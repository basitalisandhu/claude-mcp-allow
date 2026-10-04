import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ResolvedServer, ToolRecord } from './types.js';

export interface ConnectOptions {
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  cwd: string;
  clientVersion: string;
}

export type ConnectResult =
  | { status: 'listed'; tools: ToolRecord[] }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** HTTP status when the error means the server wants authentication. */
export function authStatus(err: unknown): number | undefined {
  if (err instanceof UnauthorizedError) return 401;
  if (err instanceof StreamableHTTPError && (err.code === 401 || err.code === 403)) return err.code;
  if (err instanceof SseError && (err.code === 401 || err.code === 403)) return err.code;
  const message = err instanceof Error ? err.message : String(err);
  const m = /\b(?:HTTP\s+)?(401|403)\b/.exec(message);
  if (m && /HTTP|Unauthorized|Forbidden|status/i.test(message)) return Number(m[1]);
  return undefined;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') out[k] = v;
  return out;
}

interface StdioHandle {
  transport: StdioClientTransport;
  stderrTail: () => string;
}

function makeStdio(server: ResolvedServer, opts: ConnectOptions): StdioHandle {
  const { command, args, env } = server.config;
  const transport = new StdioClientTransport({
    command: command as string,
    args: args ?? [],
    env: { ...stringEnv(opts.env), ...(env ?? {}) },
    cwd: opts.cwd,
    stderr: 'pipe',
  });
  let tail = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString('utf8')).slice(-2000);
  });
  return { transport, stderrTail: () => tail.trim() };
}

function makeHttp(kind: 'http' | 'sse', server: ResolvedServer): Transport {
  const url = new URL(server.config.url as string);
  const headers = server.config.headers ?? {};
  if (kind === 'sse') return new SSEClientTransport(url, { requestInit: { headers } });
  return new StreamableHTTPClientTransport(url, { requestInit: { headers } });
}

async function listWith(transport: Transport, opts: ConnectOptions): Promise<ToolRecord[]> {
  const client = new Client({ name: 'claude-mcp-allow', version: opts.clientVersion });
  try {
    await withTimeout(client.connect(transport), opts.timeoutMs, 'connect');
    const tools: ToolRecord[] = [];
    let cursor: string | undefined;
    do {
      const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined), opts.timeoutMs, 'tools/list');
      for (const tool of page.tools) {
        tools.push({
          name: tool.name,
          annotations: tool.annotations ? { ...tool.annotations } : undefined,
          meta: tool._meta ? { ...tool._meta } : undefined,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Connect to one server with its expanded command, args, env and headers,
 * call tools/list (following pagination) and close the connection. Servers
 * that declare `oauth`, or answer 401 or 403, are skipped rather than failed.
 */
export async function listServerTools(server: ResolvedServer, opts: ConnectOptions): Promise<ConnectResult> {
  const config = server.config;
  if (config.oauth !== undefined) {
    return { status: 'skipped', reason: 'entry has oauth; sign in with /mcp in Claude Code, this tool does not run OAuth flows' };
  }
  const type = config.type ?? (config.command ? 'stdio' : 'http');
  if (type === 'stdio') {
    if (typeof config.command !== 'string' || !config.command) return { status: 'failed', reason: 'stdio entry has no command' };
    const handle = makeStdio(server, opts);
    try {
      return { status: 'listed', tools: await listWith(handle.transport, opts) };
    } catch (err) {
      const tail = handle.stderrTail();
      return { status: 'failed', reason: describe(err) + (tail ? `\n    stderr: ${tail.split('\n').slice(-3).join(' | ')}` : '') };
    }
  }
  if (typeof config.url !== 'string' || !config.url) return { status: 'failed', reason: `${type} entry has no url` };
  const kinds: ('http' | 'sse')[] = type === 'sse' ? ['sse'] : config.type === 'http' ? ['http'] : ['http', 'sse'];
  let lastError: unknown;
  for (const kind of kinds) {
    try {
      return { status: 'listed', tools: await listWith(makeHttp(kind, server), opts) };
    } catch (err) {
      const status = authStatus(err);
      if (status !== undefined) {
        return { status: 'skipped', reason: `server answered ${status}; it needs authentication that this tool does not provide` };
      }
      lastError = err;
    }
  }
  return { status: 'failed', reason: describe(lastError) };
}
