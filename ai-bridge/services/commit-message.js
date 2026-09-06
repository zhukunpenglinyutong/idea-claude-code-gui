/**
 * Commit Message Generation Service — "provider ask" mode.
 *
 * Routes to:
 *   - Claude: Anthropic SDK messages.stream (stateless)
 *   - Codex:  Codex SDK one-shot thread
 *   - Grok / Kimi / OpenCode / PI: headless CLI ask (session-less)
 *
 * stdin JSON: { prompt, provider, model }
 *   - prompt:   the full commit prompt (spec + git diff), assembled by Java
 *   - provider: 'claude' | 'codex' | 'grok' | 'kimi' | 'opencode' | 'pi'
 *   - model:    resolved model id (mapped to the real provider model at runtime)
 *
 * stdout markers:
 *   [CONTENT_DELTA] <json-text>  — streamed token chunk
 *   [COMMIT]<text>               — success (newlines encoded as {{NEWLINE}})
 *   [COMMIT_ERROR]<msg>          — failure
 */

import { pathToFileURL } from 'node:url';

import {
  loadClaudeSdk,
  isClaudeSdkAvailable,
  loadCodexSdk,
  isCodexSdkAvailable,
} from '../utils/sdk-loader.js';
import {
  setupApiKey,
  buildCliEnv,
  buildWebviewControlledSettingsOverride,
  loadClaudeSettings,
  getCliUserAgent,
} from '../config/api-config.js';
import { mapModelIdToSdkName, resolveModelFromSettings } from '../utils/model-utils.js';
import { getRealHomeDir } from '../utils/path-utils.js';
import { getClaudeCliPathOverride } from '../utils/claude-cli-path.js';
import { ensureAnthropicSdk } from './claude/message-utils.js';
import { buildCodexCliEnvironment } from './codex/codex-utils.js';
import { askCliProvider, isCliAskProvider } from './cli-ask.js';

let claudeSdk = null;
let codexSdk = null;

/**
 * Lazy-load and cache the Claude Agent SDK (same pattern as ensureCodexSdk).
 */
async function ensureClaudeSdk() {
  if (!claudeSdk) {
    if (!isClaudeSdkAvailable()) {
      const error = new Error('Claude Agent SDK not installed. Please install via Settings > Dependencies.');
      error.code = 'SDK_NOT_INSTALLED';
      throw error;
    }
    claudeSdk = await loadClaudeSdk();
  }
  return claudeSdk;
}

/** Whether the stateless Anthropic SDK "ask" path can be used (needs a real key). */
function canUseAnthropicAskPath(config) {
  return Boolean(config && config.apiKey && (config.authType === 'api_key' || config.authType === 'api_key_helper' || config.authType === 'auth_token'));
}

/**
 * Resolve which Claude generation path to use for the current auth config.
 * Exposed for tests.
 * @returns {'ask' | 'agent'} 'ask' = stateless Anthropic SDK, 'agent' = Agent SDK (CLI login OAuth)
 */
export function resolveClaudeCommitPath(config) {
  return canUseAnthropicAskPath(config) ? 'ask' : 'agent';
}

async function ensureCodexSdk() {
  if (!codexSdk) {
    if (!isCodexSdkAvailable()) {
      const error = new Error('Codex SDK not installed. Please install via Settings > Dependencies.');
      error.code = 'SDK_NOT_INSTALLED';
      throw error;
    }
    codexSdk = await loadCodexSdk();
  }
  return codexSdk;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function extractAppendedDelta(previousText, nextText) {
  const previous = typeof previousText === 'string' ? previousText : '';
  const next = typeof nextText === 'string' ? nextText : '';
  if (!next.trim()) return '';
  if (!previous) return next;
  if (next === previous) return '';
  if (!next.startsWith(previous)) return next;
  return next.slice(previous.length);
}

/**
 * Claude path: direct "ask" via the Anthropic SDK messages.stream().
 * Stateless (no session persisted) + native token streaming.
 * Falls back to the Agent SDK when the ask path is unavailable
 * (CLI login / subscription OAuth has no raw API key) - same pattern
 * as prompt-enhancer.js.
 */
async function generateWithClaude(prompt, model) {
  const config = setupApiKey();

  if (canUseAnthropicAskPath(config)) {
    return generateWithClaudeAsk(prompt, model, config);
  }

  console.log(`[CommitMessage] Anthropic ask path unavailable (auth: ${config.authType || 'unknown'}), falling back to Agent SDK`);
  return generateWithClaudeAgent(prompt, model, config);
}

/**
 * Build the messages.stream() request for the commit ask path.
 * Reasoning models (e.g. DeepSeek) otherwise emit only `thinking` blocks and
 * never a `text` answer, leaving the commit message empty.
 * Exposed for tests.
 */
export function buildCommitAskRequest(modelId, prompt) {
  return {
    model: modelId,
    max_tokens: 1024,
    thinking: { type: 'disabled' },
    messages: [{ role: 'user', content: prompt }],
  };
}

/**
 * Fast path: Anthropic SDK messages.stream() with a real API key / auth token.
 */
async function generateWithClaudeAsk(prompt, model, config) {
  const anthropicModule = await ensureAnthropicSdk();
  const Anthropic = anthropicModule.default || anthropicModule.Anthropic || anthropicModule;

  // Resolve the real model id from the user's model mapping (e.g. claude-sonnet-4-7 -> GLM-5.2).
  const settings = loadClaudeSettings();
  const modelId = resolveModelFromSettings(model, settings && settings.env);
  console.log(`[CommitMessage] Claude model resolved: ${model} -> ${modelId}`);
  console.log(`[CommitMessage] Base URL: ${config.baseUrl || 'https://api.anthropic.com'}`);
  console.log(`[CommitMessage] Auth type: ${config.authType || 'api_key'}`);

  const clientOpts = {
    baseURL: config.baseUrl || undefined,
    defaultHeaders: { 'x-app': 'cli', 'User-Agent': getCliUserAgent() },
  };
  if (config.authType === 'auth_token') {
    clientOpts.authToken = config.apiKey;
    clientOpts.apiKey = null; // Bearer auth, no x-api-key
  } else {
    clientOpts.apiKey = config.apiKey;
  }
  const client = new Anthropic(clientOpts);

  console.log('[MESSAGE_START]');
  console.log('[CommitMessage] Streaming via Anthropic SDK messages.stream()...');

  let streamedText = '';
  const stream = client.messages.stream(buildCommitAskRequest(modelId, prompt));

  stream.on('text', (text) => {
    if (text) {
      process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(text)}\n`);
      streamedText += text;
    }
  });

  const finalMessage = await stream.finalMessage();
  console.log('[MESSAGE_END]');

  // Fallback: assemble from the final message content blocks if streaming yielded nothing.
  if (!streamedText.trim() && finalMessage && Array.isArray(finalMessage.content)) {
    for (const block of finalMessage.content) {
      if (block && block.type === 'text' && block.text) {
        streamedText += block.text;
      }
    }
  }

  console.log(`[CommitMessage] Claude response text length: ${streamedText.length}`);
  if (streamedText.trim()) {
    return streamedText.trim();
  }
  throw new Error('Claude commit response is empty');
}

/**
 * Fallback path: Claude Agent SDK (CLI login OAuth / apiKeyHelper / Bedrock).
 * The Agent SDK performs the CLI's native OAuth flow, so it works without a
 * raw API key (#1655). Mirrors enhancePromptWithClaudeAgent in prompt-enhancer.js.
 */
async function generateWithClaudeAgent(prompt, model, config) {
  const sdk = await ensureClaudeSdk();
  const { query } = sdk;

  console.log(`[CommitMessage] Agent SDK path (auth: ${config.authType}, base URL: ${config.baseUrl || 'https://api.anthropic.com'})`);

  const sdkModelName = mapModelIdToSdkName(model);
  console.log(`[CommitMessage] Claude Agent model mapping: ${model} -> ${sdkModelName}`);

  const workingDirectory = getRealHomeDir();
  const fullPrompt = [
    prompt,
    '',
    'Remember: output only the commit message, wrapped in <commit></commit>, with no explanation. Do not run tools.',
  ].join('\n');

  const claudeCliOverride = getClaudeCliPathOverride();
  const options = {
    cwd: workingDirectory,
    // Commit message generation only summarizes a diff - it must never execute
    // tools. Deny-all canUseTool, and do NOT load project/local settings (whose
    // permissions.allow could otherwise auto-approve a prompt-injected tool call).
    permissionMode: 'default',
    model: sdkModelName,
    maxTurns: 1,
    env: buildCliEnv(),
    settings: buildWebviewControlledSettingsOverride(model),
    settingSources: ['user'],
    canUseTool: async () => ({ behavior: 'deny', message: 'Commit message generation does not execute tools' }),
    includePartialMessages: true,
    ...(claudeCliOverride && { pathToClaudeCodeExecutable: claudeCliOverride }),
  };

  console.log('[CommitMessage] Calling Claude Agent SDK...');

  const result = query({
    prompt: fullPrompt,
    options,
  });

  let responseText = '';
  let hasStreamDeltas = false;
  let messageCount = 0;

  for await (const msg of result) {
    messageCount += 1;
    console.log(`[CommitMessage] Claude Agent message #${messageCount}, type: ${msg.type}`);

    if (msg.type === 'stream_event') {
      const event = msg.event;
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
        hasStreamDeltas = true;
        emitContentDelta(event.delta.text);
        responseText += event.delta.text;
      }
      continue;
    }

    if (msg.type === 'assistant' && !hasStreamDeltas) {
      const content = msg.message?.content;
      let snapshot = '';
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            snapshot += block.text;
          }
        }
      } else if (typeof content === 'string') {
        snapshot = content;
      }
      if (!snapshot) continue;

      if (!responseText) {
        emitContentDelta(snapshot);
        responseText = snapshot;
      } else if (snapshot.startsWith(responseText)) {
        const delta = snapshot.slice(responseText.length);
        if (delta) {
          emitContentDelta(delta);
          responseText = snapshot;
        }
      }
    }
  }

  console.log(`[CommitMessage] Claude Agent response length: ${responseText.length}`);
  if (responseText.trim()) {
    return responseText.trim();
  }
  throw new Error('Claude commit response is empty');
}

async function generateWithCodex(prompt, model) {
  const sdk = await ensureCodexSdk();
  const Codex = sdk.Codex || sdk.default || sdk;
  const { cliEnv } = buildCodexCliEnvironment(process.env);
  const codex = new Codex({ env: cliEnv });

  const workingDirectory = getRealHomeDir();
  const fullPrompt = [
    prompt,
    '',
    'Remember: output only the commit message, wrapped in <commit></commit>, with no explanation.',
  ].join('\n');

  // Stateless one-shot thread.
  const thread = codex.startThread({
    skipGitRepoCheck: true,
    maxTurns: 1,
    workingDirectory,
    model,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
  });

  console.log(`[CommitMessage] Calling Codex SDK with model: ${model}`);

  const { events } = await thread.runStreamed(fullPrompt);
  let responseText = '';
  let lastAgentMessage = '';

  for await (const event of events) {
    console.log(`[CommitMessage] Codex event: ${event.type}`);
    if (event.type === 'item.updated' || event.type === 'item.completed') {
      const item = event.item;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        const delta = extractAppendedDelta(lastAgentMessage, item.text);
        if (delta) {
          responseText += delta;
        }
        lastAgentMessage = item.text;
      }
    }
  }

  console.log(`[CommitMessage] Codex response text length: ${responseText.length}`);
  if (responseText.trim()) {
    return responseText.trim();
  }
  throw new Error('Codex commit response is empty');
}

function emitContentDelta(text) {
  if (typeof text !== 'string' || !text) return;
  process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(text)}\n`);
}

/**
 * Headless CLI path (Grok / Kimi / OpenCode / PI) — session-less ask.
 */
async function generateWithCli(provider, prompt, model) {
  const fullPrompt = [
    prompt,
    '',
    'Remember: output only the commit message, wrapped in <commit></commit>, with no explanation. Do not run tools.',
  ].join('\n');

  console.log(`[CommitMessage] CLI ask provider=${provider}, model=${model || '(default)'}`);

  return askCliProvider({
    provider,
    prompt: fullPrompt,
    model,
    cwd: getRealHomeDir(),
    onDelta: emitContentDelta,
  });
}

async function main() {
  try {
    const input = await readStdin();
    const data = JSON.parse(input);
    const { prompt, provider, model } = data;

    if (!prompt) {
      console.log('[COMMIT]');
      process.exit(0);
    }

    console.log(`[CommitMessage] provider=${provider}, model=${model || '(default)'}`);

    let text;
    if (provider === 'codex') {
      text = await generateWithCodex(prompt, model);
    } else if (isCliAskProvider(provider)) {
      text = await generateWithCli(provider, prompt, model);
    } else {
      text = await generateWithClaude(prompt, model);
    }

    const encoded = text.replace(/\n/g, '{{NEWLINE}}');
    console.log(`[COMMIT]${encoded}`);
    process.exit(0);
  } catch (error) {
    console.error('[CommitMessage] Error:', error && error.message ? error.message : String(error));
    console.log(`[COMMIT_ERROR]${error && error.message ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
