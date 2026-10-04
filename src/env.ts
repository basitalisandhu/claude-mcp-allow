import type { RawServerConfig } from './types.js';

/**
 * Credential variables that Claude Code reads as empty in a remote server's
 * `url` and `headers`, so that a project `.mcp.json` or a plugin cannot send
 * them to a server it names. The documented examples are listed here; Claude
 * Code's own list may be longer.
 */
export const CREDENTIAL_VARS_READ_AS_EMPTY: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'HTTPS_PROXY',
  'NPM_TOKEN',
]);

/** `${VAR}` and `${VAR:-default}`. Dots are accepted so `${user_config.KEY}` is recognised. */
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_.]*)(?::-([^}]*))?\}/g;

export interface ExpandOptions {
  /** Apply the credential rule for remote `url` and `headers`. */
  remote?: boolean;
}

export interface ExpandResult {
  value: string;
  /** Variables that were referenced without a default and are not set. */
  missing: string[];
}

export type Environment = Record<string, string | undefined>;

export function expandString(value: string, env: Environment, opts: ExpandOptions = {}): ExpandResult {
  const missing: string[] = [];
  const expanded = value.replace(REFERENCE, (whole: string, name: string, fallback: string | undefined) => {
    if (opts.remote && CREDENTIAL_VARS_READ_AS_EMPTY.has(name)) return '';
    const current = env[name];
    if (current !== undefined) return current;
    if (fallback !== undefined) return fallback;
    missing.push(name);
    return whole;
  });
  return { value: expanded, missing };
}

export interface ExpandedConfig {
  config: RawServerConfig;
  missing: string[];
}

/**
 * Expand references in the fields Claude Code expands: `command`, `args`,
 * `env`, `url` and `headers`. Other fields are copied untouched.
 */
export function expandServerConfig(
  config: RawServerConfig,
  env: Environment,
  extra: Record<string, string> = {},
): ExpandedConfig {
  const lookup: Environment = { ...env, ...extra };
  const missing = new Set<string>();
  const take = (result: ExpandResult): string => {
    for (const name of result.missing) missing.add(name);
    return result.value;
  };
  const out: RawServerConfig = { ...config };
  if (typeof config.command === 'string') out.command = take(expandString(config.command, lookup));
  if (Array.isArray(config.args)) {
    out.args = config.args.map((arg) => (typeof arg === 'string' ? take(expandString(arg, lookup)) : String(arg)));
  }
  if (config.env && typeof config.env === 'object') {
    const expandedEnv: Record<string, string> = {};
    for (const [key, raw] of Object.entries(config.env)) {
      expandedEnv[key] = typeof raw === 'string' ? take(expandString(raw, lookup)) : String(raw);
    }
    out.env = expandedEnv;
  }
  if (typeof config.url === 'string') out.url = take(expandString(config.url, lookup, { remote: true }));
  if (config.headers && typeof config.headers === 'object') {
    const headers: Record<string, string> = {};
    for (const [key, raw] of Object.entries(config.headers)) {
      headers[key] = typeof raw === 'string' ? take(expandString(raw, lookup, { remote: true })) : String(raw);
    }
    out.headers = headers;
  }
  return { config: out, missing: [...missing] };
}

/** True when any expanded field still carries a `${user_config.KEY}` reference. */
export function referencesUserConfig(config: RawServerConfig): boolean {
  const probe = (value: unknown): boolean => {
    if (typeof value === 'string') return value.includes('${user_config.');
    if (Array.isArray(value)) return value.some(probe);
    if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(probe);
    return false;
  };
  return probe({ command: config.command, args: config.args, env: config.env, url: config.url, headers: config.headers });
}
