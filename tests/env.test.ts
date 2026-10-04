import { describe, expect, it } from 'vitest';
import { expandServerConfig, expandString, referencesUserConfig } from '../src/env.js';

describe('environment variable expansion', () => {
  it('expands ${VAR} from the environment', () => {
    expect(expandString('token=${TOKEN}', { TOKEN: 'abc' })).toEqual({ value: 'token=abc', missing: [] });
  });

  it('uses the default from ${VAR:-default} only when VAR is unset', () => {
    expect(expandString('${HOST:-localhost}:${PORT:-8080}', { PORT: '9000' }).value).toBe('localhost:9000');
    expect(expandString('${EMPTY:-fallback}', { EMPTY: '' }).value).toBe('');
  });

  it('leaves an unset ${VAR} without a default as written and reports it', () => {
    const r = expandString('a ${MISSING} b', {});
    expect(r.value).toBe('a ${MISSING} b');
    expect(r.missing).toEqual(['MISSING']);
  });

  it('reads documented credential variables as empty in remote url and headers only', () => {
    const env = { ANTHROPIC_API_KEY: 'secret', NPM_TOKEN: 'npm' };
    expect(expandString('Bearer ${ANTHROPIC_API_KEY}', env, { remote: true }).value).toBe('Bearer ');
    expect(expandString('${NPM_TOKEN:-x}', env, { remote: true }).value).toBe('');
    expect(expandString('Bearer ${ANTHROPIC_API_KEY}', env).value).toBe('Bearer secret');
  });

  it('expands command, args, env, url and headers and nothing else', () => {
    const env = { DIR: '/srv', KEY: 'k', BASE: 'https://api.example.com' };
    const { config, missing } = expandServerConfig(
      {
        type: 'stdio',
        command: '${DIR}/bin/server',
        args: ['--key', '${KEY}', '${ABSENT:-none}'],
        env: { API_KEY: '${KEY}', OTHER: '${NOPE}' },
        url: '${BASE}/mcp',
        headers: { Authorization: 'Bearer ${KEY}' },
        note: '${DIR}',
      },
      env,
    );
    expect(config.command).toBe('/srv/bin/server');
    expect(config.args).toEqual(['--key', 'k', 'none']);
    expect(config.env).toEqual({ API_KEY: 'k', OTHER: '${NOPE}' });
    expect(config.url).toBe('https://api.example.com/mcp');
    expect(config.headers).toEqual({ Authorization: 'Bearer k' });
    expect(config.note).toBe('${DIR}');
    expect(missing).toEqual(['NOPE']);
  });

  it('gives extra placeholders such as CLAUDE_PLUGIN_ROOT precedence and detects user_config references', () => {
    const { config } = expandServerConfig(
      { command: '${CLAUDE_PLUGIN_ROOT}/server', env: { T: '${user_config.token}' } },
      { CLAUDE_PLUGIN_ROOT: '/wrong' },
      { CLAUDE_PLUGIN_ROOT: '/plugins/x' },
    );
    expect(config.command).toBe('/plugins/x/server');
    expect(referencesUserConfig(config)).toBe(true);
    expect(referencesUserConfig({ command: 'node' })).toBe(false);
  });
});
