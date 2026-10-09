/** Settings file scope that `--scope` selects. */
export type Scope = 'local' | 'project' | 'user';

/** Where a server definition was read from, in precedence order. */
export type ServerOrigin = 'local' | 'project' | 'user' | 'plugin';

/** One entry of an `mcpServers` map, after environment variable expansion. */
export interface RawServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  oauth?: unknown;
  [key: string]: unknown;
}

export interface PluginRef {
  /** `name@marketplace` as written in installed_plugins.json and enabledPlugins. */
  id: string;
  name: string;
  marketplace: string;
  /** The plugin root (`installPath`), which `${CLAUDE_PLUGIN_ROOT}` expands to. */
  root: string;
}

export interface ResolvedServer {
  /** The key under `mcpServers`. */
  name: string;
  /**
   * The server segment of a permission rule: `name` for local, project and user
   * servers, `plugin_<plugin>_<server>` for plugin servers.
   */
  ruleServer: string;
  /** `name`, or `plugin:<plugin>:<server>` for plugin servers. */
  displayName: string;
  origin: ServerOrigin;
  /** Human readable location of the definition. */
  source: string;
  config: RawServerConfig;
  plugin?: PluginRef;
  warnings: string[];
}

export interface SkippedServer {
  name: string;
  /** Exact server segment of permission rules, as resolved by the loader. */
  ruleServer: string;
  origin: ServerOrigin;
  source: string;
  reason: string;
}

export interface LoadResult {
  servers: ResolvedServer[];
  shadowed: { server: ResolvedServer; by: ResolvedServer }[];
  skipped: SkippedServer[];
  warnings: string[];
}

export interface ToolRecord {
  name: string;
  annotations?: Record<string, unknown> | undefined;
  meta?: Record<string, unknown> | undefined;
}

export type Decision = 'allow' | 'ask';

export interface Classification {
  decision: Decision;
  reason: string;
}

export interface ClassifiedTool extends ToolRecord {
  decision: Decision;
  reason: string;
  hash: string;
  rule: string;
}

export type ServerStatus = 'listed' | 'skipped' | 'failed';

export interface ServerReport {
  server: ResolvedServer;
  status: ServerStatus;
  reason?: string;
  tools: ClassifiedTool[];
}

export interface Plan {
  allow: string[];
  ask: string[];
  reports: ServerReport[];
  heuristic: boolean;
}

/** The sibling key `claudeMcpAllow` written next to `permissions`. */
export interface Marker {
  generatedBy: string;
  generatedAt: string;
  heuristic: boolean;
  servers: Record<string, Record<string, string>>;
}
