import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  buildCliEnv,
  buildWebviewControlledSettingsOverride,
  isWebviewControlledEnvVar,
} from './api-config.js';

const API_CONFIG_MODULE = pathToFileURL(path.resolve('ai-bridge/config/api-config.js')).href;

function buildChildEnv(homeDir) {
  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
  };

  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_API_URL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    'NODE_TLS_REJECT_UNAUTHORIZED',
    'AWS_PROFILE',
    'AWS_DEFAULT_PROFILE',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
  ]) {
    delete env[key];
  }

  return env;
}

function runSetupApiKey(homeDir) {
  const script = `
    import { setupApiKey } from ${JSON.stringify(API_CONFIG_MODULE)};
    try {
      const result = setupApiKey();
      console.log(JSON.stringify({ ok: true, result }));
    } catch (error) {
      console.log(JSON.stringify({ ok: false, error: error.message }));
    }
  `;

  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: path.resolve('.'),
      env: buildChildEnv(homeDir),
      encoding: 'utf8',
    }
  );

  const lastLine = output.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

function runInjectStartupEnv(homeDir) {
  const script = `
    import { injectStartupEnvVars } from ${JSON.stringify(API_CONFIG_MODULE)};
    injectStartupEnvVars();
    console.log(JSON.stringify({
      HTTP_PROXY: process.env.HTTP_PROXY ?? null,
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
      AWS_PROFILE: process.env.AWS_PROFILE ?? null,
      AWS_REGION: process.env.AWS_REGION ?? null,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? null,
    }));
  `;

  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: path.resolve('.'),
      env: buildChildEnv(homeDir),
      encoding: 'utf8',
    }
  );

  const lastLine = output.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

function runResyncStartupEnv(homeDir) {
  const script = `
    import fs from 'node:fs';
    import path from 'node:path';
    import { injectStartupEnvVars } from ${JSON.stringify(API_CONFIG_MODULE)};

    const home = process.env.HOME;
    const codemossDir = path.join(home, '.codemoss');
    const configPath = path.join(codemossDir, 'config.json');

    injectStartupEnvVars();

    fs.writeFileSync(configPath, JSON.stringify({
      claude: {
        current: 'provider-a',
        providers: {
          'provider-a': {
            name: 'Provider A',
            settingsConfig: {}
          }
        }
      }
    }), 'utf8');

    injectStartupEnvVars();

    console.log(JSON.stringify({
      HTTP_PROXY: process.env.HTTP_PROXY ?? null,
      HTTPS_PROXY: process.env.HTTPS_PROXY ?? null,
      AWS_PROFILE: process.env.AWS_PROFILE ?? null,
      AWS_REGION: process.env.AWS_REGION ?? null,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY ?? null,
    }));
  `;

  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: path.resolve('.'),
      env: buildChildEnv(homeDir),
      encoding: 'utf8',
    }
  );

  const lastLine = output.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

function writeCodemossClaudeConfig(homeDir, current, providers = {}) {
  const codemossDir = path.join(homeDir, '.codemoss');
  fs.mkdirSync(codemossDir, { recursive: true });
  fs.writeFileSync(
    path.join(codemossDir, 'config.json'),
    JSON.stringify({
      claude: {
        current,
        providers,
      },
    }),
    'utf8'
  );
}

function writeClaudeSettingsEnv(homeDir, env) {
  const claudeDir = path.join(homeDir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({ env }),
    'utf8'
  );
}

// Run buildCliEnv() in an isolated child process whose HOME points at tempHome,
// so the provider-management decision is driven solely by the temp settings.json
// — never by the developer's real ~/.claude/settings.json.
function runBuildCliEnv(tempHome) {
  const script = `
    import { buildCliEnv } from ${JSON.stringify(API_CONFIG_MODULE)};
    const env = buildCliEnv();
    console.log(JSON.stringify({
      ENTRYPOINT: env.CLAUDE_CODE_ENTRYPOINT,
      USER_TYPE: env.USER_TYPE,
      HOST_MANAGED: env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST,
      EFFORT: env.CLAUDE_CODE_EFFORT_LEVEL,
      MAX_THINKING: env.MAX_THINKING_TOKENS,
      DISABLE_1M: env.CLAUDE_CODE_DISABLE_1M_CONTEXT,
      SDK_VERSION: env.CLAUDE_AGENT_SDK_VERSION,
    }));
  `;

  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    {
      cwd: path.resolve('.'),
      env: {
        ...buildChildEnv(tempHome),
        // Verify the "drop inherited copy" path: the daemon may itself carry
        // the flag from a parent host. buildCliEnv must clear it for cloud
        // providers even when it is already in process.env.
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
        CLAUDE_CODE_EFFORT_LEVEL: 'max',
        MAX_THINKING_TOKENS: '64000',
        CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
        CLAUDE_AGENT_SDK_VERSION: 'should-not-leak',
        ANTHROPIC_MODEL: 'current-webview-model',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'current-webview-model',
        HTTPS_PROXY: 'http://proxy.example.com:8080',
      },
      encoding: 'utf8',
    }
  );

  const lastLine = output.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(lastLine);
}

test('isWebviewControlledEnvVar classifies model, context, and reasoning controls correctly', () => {
  assert.equal(isWebviewControlledEnvVar('ANTHROPIC_MODEL'), true);
  assert.equal(isWebviewControlledEnvVar('anthropic_model'), true); // case-insensitive
  assert.equal(isWebviewControlledEnvVar('CLAUDE_CODE_EFFORT_LEVEL'), true);
  assert.equal(isWebviewControlledEnvVar('MAX_THINKING_TOKENS'), true);
  assert.equal(isWebviewControlledEnvVar('CLAUDE_CODE_DISABLE_1M_CONTEXT'), true);
  assert.equal(isWebviewControlledEnvVar('HTTPS_PROXY'), false);
  assert.equal(isWebviewControlledEnvVar('ANTHROPIC_API_KEY'), false);
});

test('buildCliEnv strips stale CLI override env vars and sets host-managed for first-party auth', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  // Active managed provider so loadClaudeSettings() returns settings; no cloud
  // flag set → host-managed should be '1'.
  writeCodemossClaudeConfig(tempHome, 'provider-a', {
    'provider-a': { name: 'Provider A', settingsConfig: { env: { ANTHROPIC_AUTH_TOKEN: 'sk-test' } } },
  });
  writeClaudeSettingsEnv(tempHome, { ANTHROPIC_AUTH_TOKEN: 'sk-test' });

  const env = runBuildCliEnv(tempHome);

  // Reasoning/context controls stripped from the child env
  assert.equal(env.EFFORT, undefined);
  assert.equal(env.MAX_THINKING, undefined);
  assert.equal(env.DISABLE_1M, undefined);
  assert.equal(env.SDK_VERSION, undefined);
  // Identity + host-managed flag set for first-party auth
  assert.equal(env.ENTRYPOINT, 'cli');
  assert.equal(env.USER_TYPE, 'external');
  assert.equal(env.HOST_MANAGED, '1');
});

test('buildWebviewControlledSettingsOverride neutralizes Claude CLI settings env precedence', () => {
  assert.deepEqual(buildWebviewControlledSettingsOverride('claude-sonnet-4-6[1m]'), {
    env: {
      CLAUDE_CODE_EFFORT_LEVEL: '',
      MAX_THINKING_TOKENS: '',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '',
    },
  });

  assert.deepEqual(buildWebviewControlledSettingsOverride('claude-sonnet-4-6'), {
    env: {
      CLAUDE_CODE_EFFORT_LEVEL: '',
      MAX_THINKING_TOKENS: '',
      CLAUDE_CODE_DISABLE_1M_CONTEXT: '1',
    },
  });

  assert.deepEqual(buildWebviewControlledSettingsOverride(), {
    env: {
      CLAUDE_CODE_EFFORT_LEVEL: '',
      MAX_THINKING_TOKENS: '',
    },
  });
});

test('buildCliEnv leaves CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST unset for cloud providers', () => {
  // Bedrock/Vertex/Foundry: the user's settings.json owns the provider switch.
  // The host-managed flag would make Claude Code strip it → 403, so it must be
  // absent — even when process.env already carries an inherited copy.
  for (const flag of ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
    writeCodemossClaudeConfig(tempHome, 'provider-a', {
      'provider-a': { name: 'Provider A', settingsConfig: { env: { [flag]: '1' } } },
    });
    writeClaudeSettingsEnv(tempHome, { [flag]: '1' });

    const env = runBuildCliEnv(tempHome);

    assert.equal(env.HOST_MANAGED, undefined,
      `${flag} should suppress the host-managed flag (and clear any inherited copy)`);
    // Identity env must still be present regardless of provider mode.
    assert.equal(env.ENTRYPOINT, 'cli');
    assert.equal(env.USER_TYPE, 'external');
  }
});

test('setupApiKey does not fall back to Claude CLI credentials on disk', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });

  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: {} }), 'utf8');
  fs.writeFileSync(
    path.join(claudeDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'should-not-be-used' } }),
    'utf8'
  );

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'API Key not configured');
});

test('setupApiKey accepts synced provider credentials when a managed provider is active', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, 'provider-a', {
    'provider-a': {
      name: 'Provider A',
      settingsConfig: {}
    }
  });

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-test-token',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      },
    }),
    'utf8'
  );

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, true);
  assert.equal(result.result.authType, 'auth_token');
  assert.equal(result.result.baseUrl, 'https://api.anthropic.com');
});

test('setupApiKey does not read settings.json credentials when Claude provider is inactive', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, '');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-should-not-be-used',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      },
    }),
    'utf8'
  );

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'API Key not configured');
});

test('setupApiKey enters CLI login when config.json sets claude.current=__cli_login__', () => {
  // CLI login mode is identified by ~/.codemoss/config.json — NOT by any flag in
  // ~/.claude/settings.json. The plugin must never mutate the user's settings.json.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, '__cli_login__');

  // settings.json has no CLI login flag — we are explicitly verifying it is not required
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ env: {} }), 'utf8');

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, true);
  assert.equal(result.result.authType, 'cli_login');
  assert.equal(result.result.apiKey, null);
});

test('setupApiKey CLI login takes priority over existing API keys (no fallback)', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, '__cli_login__');

  // Real-world scenario: user previously configured an API key under "use local
  // settings.json" mode, then switched to CLI login. The key remains in settings.json
  // (the plugin no longer deletes it), but CLI login mode MUST win — no silent fallback.
  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: 'sk-ant-should-be-ignored',
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      },
    }),
    'utf8'
  );

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, true);
  assert.equal(result.result.authType, 'cli_login');
  assert.equal(result.result.apiKey, null);
  assert.equal(result.result.apiKeySource, 'CLI login (SDK native auth)');
});

test('setupApiKey honors legacy CCGUI_CLI_LOGIN_AUTHORIZED flag for backwards compatibility', () => {
  // Earlier plugin versions wrote CCGUI_CLI_LOGIN_AUTHORIZED=1 into settings.json.
  // Users upgrading from those versions may still have the flag — keep honoring it
  // as a fallback so they keep working until the residue is cleaned up.
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  // config.json points at the legacy provider id, not __cli_login__
  writeCodemossClaudeConfig(tempHome, '__cli_login__');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        CCGUI_CLI_LOGIN_AUTHORIZED: '1',
      },
    }),
    'utf8'
  );

  const result = runSetupApiKey(tempHome);
  assert.equal(result.ok, true);
  assert.equal(result.result.authType, 'cli_login');
  assert.equal(result.result.apiKey, null);
});

test('injectStartupEnvVars ignores local proxy settings when Claude provider is inactive', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, '');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        HTTP_PROXY: 'http://proxy.example.com:8080',
        HTTPS_PROXY: 'https://proxy.example.com:8443',
      },
    }),
    'utf8'
  );

  const result = runInjectStartupEnv(tempHome);
  assert.equal(result.HTTP_PROXY, null);
  assert.equal(result.HTTPS_PROXY, null);
});

test('injectStartupEnvVars ignores local proxy settings for managed providers', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, 'provider-a', {
    'provider-a': {
      name: 'Provider A',
      settingsConfig: {}
    }
  });

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        HTTP_PROXY: 'http://proxy.example.com:8080',
        HTTPS_PROXY: 'https://proxy.example.com:8443',
      },
    }),
    'utf8'
  );

  const result = runInjectStartupEnv(tempHome);
  assert.equal(result.HTTP_PROXY, null);
  assert.equal(result.HTTPS_PROXY, null);
});

test('injectStartupEnvVars accepts proxy settings for the authorized local provider', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, '__local_settings_json__');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        HTTP_PROXY: 'http://proxy.example.com:8080',
        HTTPS_PROXY: 'https://proxy.example.com:8443',
      },
    }),
    'utf8'
  );

  const result = runInjectStartupEnv(tempHome);
  assert.equal(result.HTTP_PROXY, 'http://proxy.example.com:8080');
  assert.equal(result.HTTPS_PROXY, 'https://proxy.example.com:8443');
});

test('injectStartupEnvVars clears previously injected proxy vars after switching away from local mode', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, '__local_settings_json__');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        HTTP_PROXY: 'http://proxy.example.com:8080',
        HTTPS_PROXY: 'https://proxy.example.com:8443',
      },
    }),
    'utf8'
  );

  const result = runResyncStartupEnv(tempHome);
  assert.equal(result.HTTP_PROXY, null);
  assert.equal(result.HTTPS_PROXY, null);
});

test('injectStartupEnvVars injects AWS credential vars for the authorized local provider', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, '__local_settings_json__');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        AWS_PROFILE: 'bedrock-profile',
        AWS_REGION: 'us-west-2',
        AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      },
    }),
    'utf8'
  );

  const result = runInjectStartupEnv(tempHome);
  assert.equal(result.AWS_PROFILE, 'bedrock-profile');
  assert.equal(result.AWS_REGION, 'us-west-2');
  assert.equal(result.AWS_SECRET_ACCESS_KEY, 'test-secret-key');
});

test('injectStartupEnvVars clears previously injected AWS credential vars after switching away from local mode', () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-gui-api-config-'));
  const claudeDir = path.join(tempHome, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  writeCodemossClaudeConfig(tempHome, '__local_settings_json__');

  fs.writeFileSync(
    path.join(claudeDir, 'settings.json'),
    JSON.stringify({
      env: {
        AWS_PROFILE: 'bedrock-profile',
        AWS_REGION: 'us-west-2',
        AWS_SECRET_ACCESS_KEY: 'test-secret-key',
      },
    }),
    'utf8'
  );

  const result = runResyncStartupEnv(tempHome);
  assert.equal(result.AWS_PROFILE, null);
  assert.equal(result.AWS_REGION, null);
  assert.equal(result.AWS_SECRET_ACCESS_KEY, null);
});
