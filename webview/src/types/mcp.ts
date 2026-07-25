/**
 * MCP (Model Context Protocol) type definitions
 *
 * MCP is Anthropic's standard protocol for AI models to communicate with external tools and data sources.
 *
 * Two configuration sources are supported:
 * 1. cc-switch format: ~/.cc-switch/config.json (primary)
 * 2. Claude native format: ~/.claude.json (compatible)
 */

/**
 * MCP server connection specification
 * Supports three connection types: stdio, http, sse
 */
export interface McpServerSpec {
  /** Connection type, defaults to stdio */
  type?: 'stdio' | 'http' | 'sse';

  // stdio type fields
  /** Command to execute (required for stdio type) */
  command?: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;

  // http/sse type fields
  /** Server URL (required for http/sse type) */
  url?: string;
  /** Request headers */
  headers?: Record<string, string>;

  /** Allow extension fields */
  [key: string]: any;
}

/**
 * MCP app enablement status (cc-switch v3.7.0 format)
 * Indicates which clients the server is applied to
 */
export interface McpApps {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
}

/**
 * MCP server full configuration
 */
export interface McpServer {
  /** Unique identifier (key in config file) */
  id: string;
  /** Display name */
  name?: string;
  /** Server connection specification */
  server: McpServerSpec;
  /** App enablement status (cc-switch format) */
  apps?: McpApps;
  /** Description */
  description?: string;
  /** Tags */
  tags?: string[];
  /** Homepage link */
  homepage?: string;
  /** Documentation link */
  docs?: string;
  /** Whether enabled (legacy format compatibility) */
  enabled?: boolean;
  /** Allow extension fields */
  [key: string]: any;
}

/**
 * MCP server map (id -> McpServer)
 */
export type McpServersMap = Record<string, McpServer>;

/**
 * cc-switch config file structure (~/.cc-switch/config.json)
 */
export interface CCSwitchConfig {
  /** MCP configuration */
  mcp?: {
    /** Server list */
    servers?: Record<string, McpServer>;
  };
  /** Claude provider configuration */
  claude?: {
    providers?: Record<string, any>;
    current?: string;
  };
  /** Other configuration */
  [key: string]: any;
}

/**
 * Claude config file structure (~/.claude.json)
 * Based on the official format
 */
export interface ClaudeConfig {
  /** MCP server configuration */
  mcpServers?: Record<string, McpServerSpec>;
  /** Other configuration */
  [key: string]: any;
}

/**
 * MCP preset configuration
 */
export interface McpPreset {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  server: McpServerSpec;
  homepage?: string;
  docs?: string;
}

/**
 * MCP server status
 */
export type McpServerStatus = 'connected' | 'checking' | 'error' | 'unknown';

/**
 * MCP server connection status info (from Claude SDK)
 */
export interface McpServerStatusInfo {
  /** Server name */
  name: string;
  /** Connection status */
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  /** Server info (available on successful connection) */
  serverInfo?: {
    name: string;
    version: string;
  };
  /** Error message (available on connection failure) */
  error?: string;
}

/**
 * MCP connection log entry
 */
export interface McpLogEntry {
  /** Unique identifier */
  id: string;
  /** Timestamp */
  timestamp: Date;
  /** Server name */
  serverName: string;
  /** Log level */
  level: 'info' | 'warn' | 'error' | 'success';
  /** Log message */
  message: string;
}

/**
 * MCP server validation result
 */
export interface McpServerValidationResult {
  valid: boolean;
  serverId?: string;
  errors?: string[];
  warnings?: string[];
}

// ==================== Codex MCP Types ====================

/**
 * Codex MCP server connection specification
 * Configuration format based on ~/.codex/config.toml
 *
 * Supports two connection types:
 * 1. STDIO: Local command-line tool
 * 2. Streamable HTTP: Remote HTTP service
 */
export interface CodexMcpServerSpec {
  // STDIO type fields
  /** Command to execute (required for STDIO type) */
  command?: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
  /** Additional environment variable allowlist */
  env_vars?: string[];

  // Streamable HTTP type fields
  /** Server URL (required for HTTP type) */
  url?: string;
  /** Bearer token environment variable name */
  bearer_token_env_var?: string;
  /** HTTP request headers */
  http_headers?: Record<string, string>;
  /** HTTP headers read from environment variables */
  env_http_headers?: Record<string, string>;

  // Common optional fields
  /** Whether enabled */
  enabled?: boolean;
  /** Startup timeout in seconds */
  startup_timeout_sec?: number;
  /** Tool call timeout in seconds */
  tool_timeout_sec?: number;
  /** List of enabled tools */
  enabled_tools?: string[];
  /** List of disabled tools */
  disabled_tools?: string[];

  /** Allow extension fields */
  [key: string]: any;
}

/**
 * Codex MCP server full configuration
 */
export interface CodexMcpServer {
  /** Unique identifier (key in config file) */
  id: string;
  /** Display name */
  name?: string;
  /** Server connection specification */
  server: CodexMcpServerSpec;
  /** App enablement status */
  apps?: McpApps;
  /** Whether enabled */
  enabled?: boolean;
  /** Startup timeout in seconds */
  startup_timeout_sec?: number;
  /** Tool call timeout in seconds */
  tool_timeout_sec?: number;
  /** List of enabled tools */
  enabled_tools?: string[];
  /** List of disabled tools */
  disabled_tools?: string[];
  /** Allow extension fields */
  [key: string]: any;
}

/**
 * Codex config.toml structure (~/.codex/config.toml)
 */
export interface CodexConfig {
  /** MCP server configuration */
  mcp_servers?: Record<string, CodexMcpServerSpec>;
  /** Other configuration */
  [key: string]: any;
}

// ==================== MCP Marketplace Types ====================

/**
 * MCP marketplace source returned by the backend.
 */
export interface McpMarketplaceSource {
  id: string;
  name: string;
  type: 'BUILT_IN' | 'REGISTRY' | 'GITHUB_ORG';
  url: string;
  enabled: boolean;
}

/**
 * Install option for a marketplace entry.
 */
export interface McpInstallOption {
  label: string;
  type: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  source?: string;
  riskLevel?: string;
}

/**
 * Normalized MCP marketplace entry.
 */
export interface McpMarketplaceEntry {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  status?: string;
  sourceId: string;
  sourceName: string;
  sourceType: string;
  homepage?: string;
  repositoryUrl?: string;
  docsUrl?: string;
  official: boolean;
  tags: string[];
  installOptions: McpInstallOption[];
}

/**
 * MCP marketplace search response.
 */
export interface McpMarketplaceSearchResponse {
  query: string;
  sourceId: string;
  entries: McpMarketplaceEntry[];
  error?: string;
}

/**
 * Response for an external MCP configuration import (e.g. GitHub Copilot format).
 * The servers are already mapped to internal entries by the Java backend.
 */
export interface McpImportPreviewResponse {
  servers: McpServer[];
  error?: string;
}
