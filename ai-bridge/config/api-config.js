/**
 * API configuration module.
 * Loads and manages Claude API configuration.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getClaudeDir, getCodemossDir, getManagedSettingsPath } from '../utils/path-utils.js';

// Conditional debug logging: set CLAUDE_DEBUG=1 to enable verbose diagnostics
const DEBUG = process.env.CLAUDE_DEBUG === '1' || process.env.CLAUDE_DEBUG === 'true';
function debugLog(...args) {
  if (DEBUG) {
    console.log(...args);
  }
}

// ============================================================================
// CLI Client Identity
// ============================================================================
// Simulates CLI client identity so the API treats our SDK calls as CLI traffic.
// The CLI version is resolved dynamically from the installed SDK's manifest.json,
// which embeds the CLI version that was bundled with the SDK.

const FALLBACK_CLI_VERSION = '2.1.88';

let _cachedCliVersion = null;

/**
 * Resolve CLI version from the installed SDK's manifest.json.
 * The SDK bundles a manifest.json with ` "version": "<cli-version>" }`.
 * Falls back to converting the SDK package version (0.x.y -> x.1.y),
 * then to the hardcoded fallback.
 */
function resolveCliVersionFromSdk() {
  if (_cachedCliVersion) return _cachedCliVersion;

  try {
    const depsBase = join(getCodemossDir(), 'dependencies');
    const sdkDir = join(depsBase, 'claude-sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');

    // Try manifest.json first (contains the bundled CLI version)
    const manifestPath = join(sdkDir, 'manifest.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest?.version) {
        _cachedCliVersion = manifest.version;
        return _cachedCliVersion;
      }
    }

    // Fallback: derive from SDK package.json version (0.x.y -> x.1.y)
    // e.g., SDK 0.2.88 -> CLI 2.1.88
    const pkgPath = join(sdkDir, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg?.version) {
        const parts = pkg.version.split('.');
        if (parts.length >= 3) {
          _cachedCliVersion = `${parts[1]}.1.${parts[2]}`;
          return _cachedCliVersion;
        }
      }
    }
  } catch {
    // Ignore errors, use fallback
  }

  _cachedCliVersion = FALLBACK_CLI_VERSION;
  return _cachedCliVersion;
}

/**
 * Get the CLI version for User-Agent header.
 * Priority: CLAUDE_CLI_VERSION env var > SDK manifest > SDK version conversion > fallback
 * @returns {string} CLI version string (e.g., "2.1.88")
 */
export function getCliVersion() {
  return process.env.CLAUDE_CLI_VERSION || resolveCliVersionFromSdk();
}

/**
 * Build CLI-style User-Agent header value.
 * Format: claude-cli/{VERSION} ({USER_TYPE}, {ENTRYPOINT})
 *
 * Does NOT include agent-sdk version suffix — we simulate a pure CLI client.
 * @returns {string} User-Agent header value
 */
export function getCliUserAgent() {
  const version = getCliVersion();
  const userType = process.env.USER_TYPE || 'external';
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT || 'cli';
  return `claude-cli/${version} (${userType}, ${entrypoint})`;
}

// Cloud-provider routing switches in settings.json. When any of these is
// enabled, the user's settings.json — not the plugin — owns inference routing,
// so the plugin must NOT advertise host-managed provider control (see
// shouldHostManageProvider / buildCliEnv).
const CLOUD_PROVIDER_FLAGS = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

/**
 * Whether a settings.json env flag is enabled.
 *
 * Claude Code reads these switches from both JSON booleans and stringified
 * truthy values ("1"/"true"), so this normalizes every accepted spelling in one
 * place. Shared by auth detection (setupApiKey) and provider-management gating
 * (shouldHostManageProvider) so the two can never disagree on what "enabled"
 * means.
 *
 * @param {*} value - Raw value from settings.json env.
 * @returns {boolean} true for any accepted truthy spelling.
 */
function isEnvFlagEnabled(value) {
  return value === '1' || value === 1 || value === 'true' || value === true;
}

// Env vars whose value the webview owns per request. Settings.json copies of
// these must never be applied on top of the current request's selections.
//
// Model routing: chosen by the webview model selector and written to
// process.env by setModelEnvironmentVariables() each turn.
const MODEL_ROUTING_ENV_VARS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'CLAUDE_CODE_SUBAGENT_MODEL',
];

// Reasoning / context controls: explicit SDK options in this bridge. Claude Code
// gives env vars higher priority than SDK args, so stale settings values must be
// neutralized — stripped from the child env (buildCliEnv) and overridden inline
// (buildWebviewControlledSettingsOverride). The 1M flag is set per request from
// the selected model.
const REASONING_CONTROL_ENV_VARS = [
  'CLAUDE_CODE_EFFORT_LEVEL',
  'MAX_THINKING_TOKENS',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
];

export const WEBVIEW_CONTROLLED_ENV_VARS = Object.freeze([
  ...MODEL_ROUTING_ENV_VARS,
  ...REASONING_CONTROL_ENV_VARS,
]);

const WEBVIEW_CONTROLLED_ENV_VAR_SET = new Set(
  WEBVIEW_CONTROLLED_ENV_VARS.map((varName) => varName.toUpperCase())
);

// Subset stripped from the SDK child env: the reasoning/context controls must
// reach the CLI only via SDK options + the inline settings override, never
// inherited from process.env.
const CLI_ENV_OVERRIDE_VAR_SET = new Set(
  REASONING_CONTROL_ENV_VARS.map((varName) => varName.toUpperCase())
);

export function isWebviewControlledEnvVar(varName) {
  return WEBVIEW_CONTROLLED_ENV_VAR_SET.has(String(varName ?? '').toUpperCase());
}

// Security (C): environment variables that can hijack process startup or load arbitrary
// native/JS code. These must NEVER be accepted from request params / settings.json env,
// otherwise a malicious project's .claude/settings.json {env:{NODE_OPTIONS:'--require ...'}}
// would achieve code execution in the daemon or any child process the SDK spawns.
// NOTE: PATH is intentionally NOT listed — the daemon's legitimate PATH is supplied by the
// Java EnvironmentConfigurator, and blanket-rejecting PATH would risk breaking it.
const DANGEROUS_ENV_VAR_SET = new Set([
  'NODE_OPTIONS',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_EXTRA_CA_CERTS',
  'ELECTRON_RUN_AS_NODE',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'BASH_ENV',
  'ENV',
  'PERL5LIB',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'GIT_SSH_COMMAND',
  'GIT_EXTERNAL_DIFF',
]);

export function isDangerousEnvVar(varName) {
  return DANGEROUS_ENV_VAR_SET.has(String(varName ?? '').toUpperCase());
}

export function buildWebviewControlledSettingsOverride(modelId) {
  const env = {
    // Empty strings intentionally override settings.json env values while
    // evaluating as "not set" in Claude Code's env-precedence checks.
    CLAUDE_CODE_EFFORT_LEVEL: '',
    MAX_THINKING_TOKENS: '',
  };

  const normalizedModel = typeof modelId === 'string' ? modelId.trim() : '';
  if (normalizedModel) {
    env.CLAUDE_CODE_DISABLE_1M_CONTEXT = /\[1m\]$/i.test(normalizedModel) ? '' : '1';
  }

  return { env };
}

/**
 * Whether the host should hand off provider routing to Claude Code itself.
 *
 * When truthy, the CLI strips provider/model routing vars (CLAUDE_CODE_USE_BEDROCK,
 * ANTHROPIC_*_BASE_URL, ANTHROPIC_API_KEY/AUTH_TOKEN, …) from every settings
 * source, so a user's ~/.claude/settings.json cannot redirect requests away
 * from the host-configured provider. That is exactly what we want when the
 * plugin owns the API key and base URL.
 *
 * It is NOT what we want for cloud-provider auth (Bedrock/Vertex/Foundry):
 * there the user's settings.json IS the source of truth for
 * CLAUDE_CODE_USE_BEDROCK and its peers. Setting the flag there would make the
 * CLI silently drop the very switch that turns Bedrock on → 403.
 *
 * The plugin's "host" role is conditional on who actually holds the
 * credentials — for cloud providers that owner is AWS/GCP/Azure, so the plugin
 * must step back and let Claude Code honor the user's settings.json switch.
 *
 * Reads settings via loadClaudeSettings() (same source as setupApiKey) so the
 * auth-decision and the provider-management-decision always see the same env.
 *
 * @returns {boolean} true unless a cloud provider switch is active in settings.
 */
function shouldHostManageProvider() {
  const settings = loadClaudeSettings();
  return !CLOUD_PROVIDER_FLAGS.some((flag) => isEnvFlagEnabled(settings?.env?.[flag]));
}

/**
 * Build a clean env object for SDK child processes that identifies as CLI.
 *
 * The SDK's query() checks `options.env` — if absent, it copies process.env
 * (which includes CLAUDE_AGENT_SDK_VERSION set by the SDK itself).
 * By passing our own env, we control exactly what the child process sees.
 *
 * @returns {Object} Environment variables object for options.env
 */
export function buildCliEnv() {
  const env = {};
  // When a cloud provider owns routing, the host must NOT advertise provider
  // management: otherwise Claude Code strips CLAUDE_CODE_USE_BEDROCK (and
  // peers) from settings → 403. We skip setting it AND drop any copy inherited
  // from this process's own env (the daemon may itself have been spawned under
  // the flag, e.g. when run from inside another Claude Code host).
  const hostManaged = shouldHostManageProvider();
  const skipKeys = new Set([...CLI_ENV_OVERRIDE_VAR_SET, 'CLAUDE_AGENT_SDK_VERSION']);
  if (!hostManaged) {
    skipKeys.add('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST');
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (!skipKeys.has(key.toUpperCase())) {
      env[key] = value;
    }
  }
  env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  env.USER_TYPE = 'external';
  // Claude Code applies settings.json env with overwrite semantics. This flag
  // makes the CLI strip settings-sourced provider/model vars so the host's
  // request-scoped routing wins — but only when the plugin owns routing. For
  // cloud-provider modes (Bedrock/Vertex/Foundry) the CLI must honor the
  // user's settings.json switch, so we leave the flag unset there.
  if (hostManaged) {
    env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1';
  }
  return env;
}

/**
 * Configure process.env for CLI client identity at startup.
 * Sets CLAUDE_CODE_ENTRYPOINT and USER_TYPE, deletes CLAUDE_AGENT_SDK_VERSION.
 * Call once at process startup before any SDK loading.
 */
export function configureCliIdentity() {
  if (!process.env.CLAUDE_CODE_ENTRYPOINT) {
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  }
  if (!process.env.USER_TYPE) {
    process.env.USER_TYPE = 'external';
  }
  delete process.env.CLAUDE_AGENT_SDK_VERSION;
}

// ============================================================================
// Startup Environment Variables
// ============================================================================

/**
 * Environment variable names that should be injected from settings.json into
 * process.env early at startup.
 *
 * IDEs launched from a desktop launcher (macOS Dock, Windows Start Menu,
 * Linux app launcher) do NOT inherit the user's shell environment. Variables
 * configured in settings.json therefore never reach process.env, causing
 * Bedrock auth and proxy/TLS settings to silently fail. Reading them here
 * ensures every subprocess the daemon spawns (the claude binary, MCP servers,
 * Bash tool, etc.) sees the correct env.
 *
 * For corporate SSL-inspection proxies, prefer NODE_EXTRA_CA_CERTS (path to
 * a PEM bundle) over NODE_TLS_REJECT_UNAUTHORIZED=0 — the former adds custom
 * CAs while keeping verification intact; the latter disables ALL verification.
 */
const STARTUP_ENV_VARS = [
  // Proxy and TLS
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  // AWS credentials — required for Bedrock auth when the IDE is desktop-launched
  'AWS_PROFILE', 'AWS_DEFAULT_PROFILE',
  'AWS_REGION', 'AWS_DEFAULT_REGION',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
];

const LOCAL_SETTINGS_PROVIDER_ID = '__local_settings_json__';
const CLI_LOGIN_PROVIDER_ID = '__cli_login__';
const CODEX_CLI_LOGIN_PROVIDER_ID = '__codex_cli_login__';
const injectedStartupEnvVars = new Map();

function clearInjectedStartupEnvVars() {
  for (const [varName, injectedValue] of injectedStartupEnvVars.entries()) {
    if (process.env[varName] === injectedValue) {
      delete process.env[varName];
    }
  }
  injectedStartupEnvVars.clear();
}

function clearRuntimeAuthEnv() {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_API_URL;
}

function readJsonFile(filePath) {
  try {
    if (!existsSync(filePath)) {
      return null;
    }
    const raw = readFileSync(filePath, 'utf8');
    // PowerShell commonly writes UTF-8 with BOM on Windows. Strip the BOM
    // before parsing so provider state files remain readable across tools.
    const normalized = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    return JSON.parse(normalized);
  } catch (error) {
    debugLog('[DEBUG] Failed to read JSON file:', filePath, error.message);
    return null;
  }
}

function readClaudeSettingsFromDisk() {
  return readJsonFile(join(getClaudeDir(), 'settings.json'));
}

function loadCodemossConfig() {
  return readJsonFile(join(getCodemossDir(), 'config.json'));
}

export function getClaudeRuntimeState() {
  const config = loadCodemossConfig();
  const claude = config?.claude && typeof config.claude === 'object' ? config.claude : null;
  const providers = claude?.providers && typeof claude.providers === 'object' ? claude.providers : {};
  const providerIds = Object.keys(providers);
  const hasExplicitCurrent = !!claude && Object.prototype.hasOwnProperty.call(claude, 'current') && claude.current !== null;
  const currentId = hasExplicitCurrent ? String(claude.current).trim() : '';

  if (currentId === LOCAL_SETTINGS_PROVIDER_ID) {
    return { access: 'local', currentId };
  }

  if (currentId === CLI_LOGIN_PROVIDER_ID) {
    return { access: 'cli_login', currentId };
  }

  if (currentId && Object.prototype.hasOwnProperty.call(providers, currentId)) {
    return { access: 'managed', currentId };
  }

  if (!hasExplicitCurrent && providerIds.length > 0) {
    return { access: 'managed', currentId: providerIds[0] };
  }

  return { access: 'inactive', currentId };
}

export function getCodexRuntimeState() {
  const config = loadCodemossConfig();
  const codex = config?.codex && typeof config.codex === 'object' ? config.codex : null;
  const providers = codex?.providers && typeof codex.providers === 'object' ? codex.providers : {};
  const hasExplicitCurrent = !!codex && Object.prototype.hasOwnProperty.call(codex, 'current') && codex.current !== null;
  const currentId = hasExplicitCurrent ? String(codex.current).trim() : '';

  if (currentId === CODEX_CLI_LOGIN_PROVIDER_ID) {
    return { access: 'cli_login', currentId };
  }

  if (currentId && Object.prototype.hasOwnProperty.call(providers, currentId)) {
    return { access: 'managed', currentId };
  }

  return { access: 'inactive', currentId };
}

function canReadClaudeSettings(runtimeState) {
  return runtimeState.access !== 'inactive';
}

function canUseLocalSettingsEnv(runtimeState) {
  return runtimeState.access === 'local' || runtimeState.access === 'cli_login';
}

/**
 * Inject environment variables from settings.json into process.env.
 *
 * This covers proxy/TLS configuration and AWS credentials for Bedrock. It must
 * be called as early as possible in every Node.js entry point — before any
 * HTTPS connection is made (including SDK preloading) — so that authorized
 * Local settings / CLI Login modes can use corporate proxies, custom CA
 * setups, and Bedrock credentials safely.
 *
 * Users behind corporate SSL-inspection proxies should prefer setting:
 *   { "env": { "NODE_EXTRA_CA_CERTS": "/path/to/ca-bundle.pem" } }
 *
 * As a last resort (disables ALL TLS verification — MITM risk):
 *   { "env": { "NODE_TLS_REJECT_UNAUTHORIZED": "0" } }
 *
 * @param {Object} [settings] - Parsed settings object. If omitted, loads from disk.
 */
export function injectStartupEnvVars(settings) {
  const runtimeState = getClaudeRuntimeState();
  clearInjectedStartupEnvVars();

  if (!canUseLocalSettingsEnv(runtimeState)) {
    debugLog('[DEBUG] Skipping settings.json env sync for provider mode:', runtimeState.access);
    return;
  }

  const resolvedSettings = settings || readClaudeSettingsFromDisk();
  for (const varName of STARTUP_ENV_VARS) {
    const value = resolvedSettings?.env?.[varName];
    if (value === undefined || value === null || process.env[varName]) {
      continue;
    }

    // Validate proxy URLs before injecting
    if (['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'].includes(varName)) {
      try {
        new URL(String(value));
      } catch {
        debugLog(`[DEBUG] Skipping ${varName}: invalid URL "${value}"`);
        continue;
      }
    }

    const stringValue = String(value);
    process.env[varName] = stringValue;
    injectedStartupEnvVars.set(varName, stringValue);
    debugLog(`[DEBUG] Set ${varName} from settings.json`);

    if (varName === 'NODE_TLS_REJECT_UNAUTHORIZED' && String(value) === '0') {
      console.warn('[SECURITY WARNING] TLS certificate verification is disabled via settings.json. All HTTPS connections are vulnerable to MITM attacks. Prefer NODE_EXTRA_CA_CERTS for corporate proxies.');
    }
  }
}

/**
 * Load managed settings from the platform-specific managed-settings.json.
 * These are typically configured by enterprise IT administrators.
 * @returns {Object|null} Parsed managed settings or null if not found/invalid
 */
export function loadManagedSettings() {
  try {
    const managedPath = getManagedSettingsPath();
    if (!existsSync(managedPath)) {
      return null;
    }
    const settings = JSON.parse(readFileSync(managedPath, 'utf8'));
    debugLog('[DEBUG] Loaded managed settings from:', managedPath);
    return settings;
  } catch (error) {
    debugLog('[DEBUG] Failed to load managed settings:', error.message);
    return null;
  }
}

/**
 * Read Claude Code configuration only when an active Claude provider is authorized.
 * Managed providers read the plugin-synced settings.json copy; local/CLI modes
 * read the user's local Claude settings directly.
 */
export function loadClaudeSettings() {
  const runtimeState = getClaudeRuntimeState();
  if (!canReadClaudeSettings(runtimeState)) {
    debugLog('[DEBUG] Skipping ~/.claude/settings.json read: Claude provider is inactive');
    return null;
  }
  return readClaudeSettingsFromDisk();
}

/**
 * Configure the API Key.
 * @returns {Object} Contains apiKey, baseUrl, authType and their sources
 */
export function setupApiKey() {
  const runtimeState = getClaudeRuntimeState();
  const settings = loadClaudeSettings();
  injectStartupEnvVars(settings);
  clearRuntimeAuthEnv();

  let apiKey;
  let baseUrl;
  let authType = 'api_key';  // Default to api_key (x-api-key header)
  let apiKeySource = 'default';
  let baseUrlSource = 'default';

  // Configuration priority: only read from settings.json, ignore system environment variables.
  // This ensures a single source of truth and avoids interference from shell environment variables.
  debugLog('[DEBUG] Loading configuration from settings.json only (ignoring shell environment variables)...');

  if (settings?.env?.ANTHROPIC_BASE_URL) {
    baseUrl = settings.env.ANTHROPIC_BASE_URL;
    baseUrlSource = 'settings.json';
  }

  // HIGHEST PRIORITY: CLI login mode. When user explicitly opted in via plugin UI,
  // strictly use SDK native OAuth flow. No fallback to other auth methods.
  //
  // Source of truth: ~/.codemoss/config.json (claude.current === "__cli_login__"),
  // surfaced by getClaudeRuntimeState() above. We deliberately do NOT consult
  // ~/.claude/settings.json for this signal — that file is user-owned and must not
  // be mutated by provider switches. The legacy CCGUI_CLI_LOGIN_AUTHORIZED env flag
  // is honored as a fallback for users upgrading from versions that wrote it to
  // settings.json, so they keep working until that residue is cleaned up.
  const cliLoginAuthorized =
    runtimeState.access === 'cli_login' || settings?.env?.CCGUI_CLI_LOGIN_AUTHORIZED === '1';
  if (cliLoginAuthorized) {
    // Use empty string assignment instead of delete so the SDK falls through to
    // its native OAuth flow without inheriting stale values from prior requests.
    process.env.ANTHROPIC_API_KEY = '';
    process.env.ANTHROPIC_AUTH_TOKEN = '';

    if (baseUrl) {
      process.env.ANTHROPIC_BASE_URL = baseUrl;
    }

    return { apiKey: null, baseUrl, authType: 'cli_login', apiKeySource: 'CLI login (SDK native auth)', baseUrlSource };
  }

  // Prefer ANTHROPIC_AUTH_TOKEN (Bearer auth), fall back to ANTHROPIC_API_KEY (x-api-key auth).
  // This supports both authentication methods used by the Claude Code CLI.
  if (settings?.env?.ANTHROPIC_AUTH_TOKEN) {
    apiKey = settings.env.ANTHROPIC_AUTH_TOKEN;
    authType = 'auth_token';  // Bearer authentication
    apiKeySource = 'settings.json (ANTHROPIC_AUTH_TOKEN)';
  } else if (settings?.env?.ANTHROPIC_API_KEY) {
    apiKey = settings.env.ANTHROPIC_API_KEY;
    authType = 'api_key';  // x-api-key authentication
    apiKeySource = 'settings.json (ANTHROPIC_API_KEY)';
  } else if (isEnvFlagEnabled(settings?.env?.CLAUDE_CODE_USE_BEDROCK)) {
    apiKey = settings?.env?.CLAUDE_CODE_USE_BEDROCK;
    authType = 'aws_bedrock';  // AWS Bedrock authentication
    apiKeySource = 'settings.json (AWS_BEDROCK)';
  }

  if (!apiKey) {
    debugLog('[DEBUG] No API Key found in settings.json, checking for apiKeyHelper...');

    // Check for apiKeyHelper in managed settings or user settings before giving up.
    // The SDK handles apiKeyHelper execution natively, so we just need to not throw.
    const managedSettings = loadManagedSettings();
    const hasApiKeyHelper = managedSettings?.apiKeyHelper || settings?.apiKeyHelper;

    if (hasApiKeyHelper) {
      authType = 'api_key_helper';
      apiKeySource = managedSettings?.apiKeyHelper
        ? 'managed-settings.json (apiKeyHelper)'
        : 'settings.json (apiKeyHelper)';

      if (baseUrl) {
        process.env.ANTHROPIC_BASE_URL = baseUrl;
      }

      debugLog('[DEBUG] Auth type:', authType);
      return { apiKey: null, baseUrl, authType, apiKeySource, baseUrlSource };
    }

    console.error('[ERROR] API Key not configured.');
    console.error('[ERROR] Please either:');
    console.error('[ERROR]   1. Configure ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in Provider Management');
    console.error('[ERROR]   2. Explicitly enable local ~/.claude/settings.json mode and set credentials there');
    console.error('[ERROR]   3. Configure apiKeyHelper in managed-settings.json or settings.json');
    throw new Error('API Key not configured');
  }

  // Set the corresponding environment variables based on auth type
  if (authType === 'auth_token') {
    process.env.ANTHROPIC_AUTH_TOKEN = apiKey;
  } else if (authType === 'aws_bedrock') {
  } else {
    process.env.ANTHROPIC_API_KEY = apiKey;
  }

  if (baseUrl) {
    process.env.ANTHROPIC_BASE_URL = baseUrl;
  }

  debugLog('[DEBUG] Auth type:', authType);

  return { apiKey, baseUrl, authType, apiKeySource, baseUrlSource };
}

/**
 * Detect whether a custom Base URL (non-official Anthropic API) is being used.
 * @param {string} baseUrl - Base URL
 * @returns {boolean} Whether the URL is custom
 */
export function isCustomBaseUrl(baseUrl) {
  if (!baseUrl) return false;
  const officialUrls = [
    'https://api.anthropic.com',
    'https://api.anthropic.com/',
    'api.anthropic.com'
  ];
  return !officialUrls.some(url => baseUrl.toLowerCase().includes('api.anthropic.com'));
}
