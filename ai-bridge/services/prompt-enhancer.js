/**
 * Prompt Enhancement Service.
 * Routes enhancement requests to Claude or Codex based on prompt enhancer config.
 *
 * Supports context information:
 * - User selected code snippets
 * - Current open file information (path, content, language type)
 * - Cursor position and surrounding code
 * - Related file information
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

// stdout protocol markers (line-oriented; keep payloads JSON-encoded for deltas)
//   [CONTENT_DELTA] <json-string>  — progressive token chunk
//   [ENHANCED]<text>               — final success (newlines as {{NEWLINE}})
//   [ENHANCED_ERROR]<msg>          — final failure

/** Mirrors chat AVAILABLE_PROVIDERS / webview AiFeatureProvider. */
const AI_FEATURE_PROVIDERS = ['claude', 'codex', 'grok', 'kimi', 'opencode', 'pi', 'omp', 'mimo'];
const CLI_ONLY_PROVIDERS = new Set(['grok', 'kimi', 'opencode', 'pi', 'omp', 'mimo']);

const DEFAULT_PROMPT_ENHANCER_CONFIG = {
  provider: null,
  effectiveProvider: 'claude',
  resolutionSource: 'auto',
  models: {
    // claude-sonnet-4-6/4-7 are retired - defaults must stay on live models (#1678, #1693).
    claude: 'claude-sonnet-5',
    codex: 'gpt-5.5',
    grok: 'grok',
    kimi: 'auto',
    opencode: 'opencode-default',
    pi: 'auto',
    omp: 'auto',
  },
  availability: {
    claude: false,
    codex: false,
    grok: false,
    kimi: false,
    opencode: false,
    pi: false,
    omp: false,
  },
};

function isAiFeatureProvider(value) {
  return typeof value === 'string' && AI_FEATURE_PROVIDERS.includes(value);
}

async function ensureClaudeSdk() {
  if (!claudeSdk) {
    if (!isClaudeSdkAvailable()) {
      const error = new Error('Claude Code SDK not installed. Please install via Settings > Dependencies.');
      error.code = 'SDK_NOT_INSTALLED';
      throw error;
    }
    claudeSdk = await loadClaudeSdk();
  }
  return claudeSdk;
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

// Context length limits (in characters) to avoid exceeding model token limits
const MAX_SELECTED_CODE_LENGTH = 2000;
const MAX_CURSOR_CONTEXT_LENGTH = 1000;
const MAX_CURRENT_FILE_LENGTH = 3000;
const MAX_RELATED_FILES_LENGTH = 2000;
const MAX_SINGLE_RELATED_FILE_LENGTH = 500;

async function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
    process.stdin.on('error', reject);
  });
}

function truncateText(text, maxLength, fromEnd = false) {
  if (!text || text.length <= maxLength) {
    return text;
  }

  if (fromEnd) {
    return '...\n' + text.slice(-maxLength);
  }
  return text.slice(0, maxLength) + '\n...';
}

function getLanguageFromPath(filePath) {
  if (!filePath) return 'text';

  const ext = filePath.split('.').pop()?.toLowerCase();
  const langMap = {
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'java': 'java',
    'kt': 'kotlin',
    'kts': 'kotlin',
    'go': 'go',
    'rs': 'rust',
    'rb': 'ruby',
    'php': 'php',
    'c': 'c',
    'cpp': 'cpp',
    'cc': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'cs': 'csharp',
    'swift': 'swift',
    'scala': 'scala',
    'vue': 'vue',
    'html': 'html',
    'css': 'css',
    'scss': 'scss',
    'less': 'less',
    'json': 'json',
    'xml': 'xml',
    'yaml': 'yaml',
    'yml': 'yaml',
    'md': 'markdown',
    'sql': 'sql',
    'sh': 'bash',
    'bash': 'bash',
    'zsh': 'bash',
  };

  return langMap[ext] || 'text';
}

export function buildFullPrompt(originalPrompt, context) {
  let fullPrompt = `Please optimize the following prompt:\n\n${originalPrompt}`;

  if (!context) {
    return fullPrompt;
  }

  const contextParts = [];

  if (context.selectedCode && context.selectedCode.trim()) {
    const truncatedCode = truncateText(context.selectedCode, MAX_SELECTED_CODE_LENGTH);
    const language = context.currentFile?.language || getLanguageFromPath(context.currentFile?.path) || 'text';
    contextParts.push(`[User Selected Code]\n\`\`\`${language}\n${truncatedCode}\n\`\`\``);
    console.log(`[PromptEnhancer] Added selected code context, length: ${context.selectedCode.length}`);
  }

  if (!context.selectedCode && context.cursorContext && context.cursorContext.trim()) {
    const truncatedContext = truncateText(context.cursorContext, MAX_CURSOR_CONTEXT_LENGTH);
    const language = context.currentFile?.language || getLanguageFromPath(context.currentFile?.path) || 'text';
    const lineInfo = context.cursorPosition ? ` (line ${context.cursorPosition.line})` : '';
    contextParts.push(`[Code Around Cursor${lineInfo}]\n\`\`\`${language}\n${truncatedContext}\n\`\`\``);
    console.log(`[PromptEnhancer] Added cursor context, length: ${context.cursorContext.length}`);
  }

  if (context.currentFile) {
    const { path, language, content } = context.currentFile;
    let fileInfo = '';

    if (path) {
      const lang = language || getLanguageFromPath(path);
      fileInfo = `[Current File] ${path}\n[Language Type] ${lang}`;

      if (!context.selectedCode && !context.cursorContext && content && content.trim()) {
        const truncatedContent = truncateText(content, MAX_CURRENT_FILE_LENGTH);
        fileInfo += `\n[File Content Preview]\n\`\`\`${lang}\n${truncatedContent}\n\`\`\``;
        console.log(`[PromptEnhancer] Added file content preview, length: ${content.length}`);
      }

      contextParts.push(fileInfo);
      console.log(`[PromptEnhancer] Added current file info: ${path}`);
    }
  }

  if (context.relatedFiles && Array.isArray(context.relatedFiles) && context.relatedFiles.length > 0) {
    let totalLength = 0;
    const relatedFilesInfo = [];

    for (const file of context.relatedFiles) {
      if (totalLength >= MAX_RELATED_FILES_LENGTH) {
        console.log('[PromptEnhancer] Related files total length reached limit, skipping remaining files');
        break;
      }

      if (file.path) {
        let fileEntry = `- ${file.path}`;
        if (file.content && file.content.trim()) {
          const remainingLength = MAX_RELATED_FILES_LENGTH - totalLength;
          const maxLength = Math.min(MAX_SINGLE_RELATED_FILE_LENGTH, remainingLength);
          const truncatedContent = truncateText(file.content, maxLength);
          const lang = getLanguageFromPath(file.path);
          fileEntry += `\n\`\`\`${lang}\n${truncatedContent}\n\`\`\``;
          totalLength += truncatedContent.length;
        }
        relatedFilesInfo.push(fileEntry);
      }
    }

    if (relatedFilesInfo.length > 0) {
      contextParts.push(`[Related Files]\n${relatedFilesInfo.join('\n')}`);
      console.log(`[PromptEnhancer] Added ${relatedFilesInfo.length} related file(s)`);
    }
  }

  if (context.projectType) {
    contextParts.push(`[Project Type] ${context.projectType}`);
    console.log(`[PromptEnhancer] Added project type: ${context.projectType}`);
  }

  if (contextParts.length > 0) {
    fullPrompt += '\n\n---\nThe following is relevant context information, please refer to it when optimizing the prompt:\n\n'
      + contextParts.join('\n\n');
  }

  return fullPrompt;
}

function normalizePromptEnhancerConfig(config) {
  if (!config || typeof config !== 'object') {
    return structuredClone(DEFAULT_PROMPT_ENHANCER_CONFIG);
  }

  const models = { ...DEFAULT_PROMPT_ENHANCER_CONFIG.models };
  const availability = { ...DEFAULT_PROMPT_ENHANCER_CONFIG.availability };
  for (const provider of AI_FEATURE_PROVIDERS) {
    if (typeof config.models?.[provider] === 'string' && config.models[provider].trim()) {
      models[provider] = config.models[provider].trim();
    }
    if (config.availability && provider in config.availability) {
      availability[provider] = Boolean(config.availability[provider]);
    }
  }

  return {
    provider: isAiFeatureProvider(config.provider) ? config.provider : null,
    effectiveProvider: isAiFeatureProvider(config.effectiveProvider) ? config.effectiveProvider : null,
    resolutionSource: typeof config.resolutionSource === 'string' ? config.resolutionSource : 'auto',
    models,
    availability,
  };
}

/**
 * In auto mode, prefer the model currently selected in the chat input when the
 * resolved enhancer provider matches the chat provider. Manual mode keeps the
 * remembered per-provider enhancer model.
 *
 * @param {object} options
 * @param {string} options.provider - resolved effective provider
 * @param {string} options.configuredModel - models[provider] from settings
 * @param {string} [options.resolutionSource]
 * @param {string} [options.chatProvider]
 * @param {string} [options.chatModel]
 * @returns {string}
 */
export function resolveAutoChatModel({
  provider,
  configuredModel,
  resolutionSource,
  chatProvider,
  chatModel,
} = {}) {
  const isAuto = resolutionSource === 'auto';
  if (!isAuto || !provider) {
    return configuredModel;
  }
  const chatProv = typeof chatProvider === 'string' ? chatProvider.trim().toLowerCase() : '';
  const chatMod = typeof chatModel === 'string' ? chatModel.trim() : '';
  if (!chatProv || !chatMod) {
    return configuredModel;
  }
  if (chatProv !== String(provider).trim().toLowerCase()) {
    return configuredModel;
  }
  return chatMod;
}

export function resolvePromptEnhancerRuntimeConfig({
  promptEnhancerConfig,
  legacyModel,
  chatProvider,
  chatModel,
} = {}) {
  if (!promptEnhancerConfig) {
    return {
      provider: 'claude',
      model: legacyModel || DEFAULT_PROMPT_ENHANCER_CONFIG.models.claude,
      resolutionSource: 'legacy',
    };
  }

  const config = normalizePromptEnhancerConfig(promptEnhancerConfig);
  const claudeSdkInstalled = isClaudeSdkAvailable();
  const codexSdkInstalled = isCodexSdkAvailable();

  // Prefer Java-resolved effectiveProvider (includes CLI providers when available).
  if (isAiFeatureProvider(config.effectiveProvider)) {
    const provider = config.effectiveProvider;
    const configuredModel = config.models[provider] || DEFAULT_PROMPT_ENHANCER_CONFIG.models[provider];
    return {
      provider,
      model: resolveAutoChatModel({
        provider,
        configuredModel,
        resolutionSource: config.resolutionSource,
        chatProvider,
        chatModel,
      }),
      resolutionSource: config.resolutionSource,
    };
  }

  if (config.provider === 'codex') {
    if (!codexSdkInstalled) {
      throw new Error('Codex prompt enhancer is unavailable because the Codex SDK is not installed. Please install it in Settings > Dependencies.');
    }
    throw new Error('Codex prompt enhancer is unavailable because no active Codex provider is configured.');
  }

  if (config.provider === 'claude') {
    if (!claudeSdkInstalled) {
      throw new Error('Claude Code prompt enhancer is unavailable because the Claude Code SDK is not installed. Please install it in Settings > Dependencies.');
    }
    throw new Error('Claude Code prompt enhancer is unavailable because no active Claude Code provider is configured.');
  }

  if (config.provider && CLI_ONLY_PROVIDERS.has(config.provider)) {
    throw new Error(
      `${config.provider} prompt enhancer is unavailable because the CLI is not installed or not detected. Install it and re-check Settings → Provider Management → CLI.`
    );
  }

  if (!codexSdkInstalled && !claudeSdkInstalled) {
    throw new Error('No available prompt enhancer provider is configured because both Claude Code and Codex SDKs are not installed.');
  }

  throw new Error('No available prompt enhancer provider is configured. Please configure a provider in Settings → Prompt Enhancer.');
}

export function extractAppendedDelta(previousText, nextText) {
  const previous = typeof previousText === 'string' ? previousText : '';
  const next = typeof nextText === 'string' ? nextText : '';
  if (!next.trim()) return '';
  if (!previous) return next;
  if (next === previous) return '';
  if (!next.startsWith(previous)) return next;
  return next.slice(previous.length);
}

/**
 * Whether the Anthropic messages.stream "ask" path can be used.
 * Requires a concrete API key / auth token (not CLI login / helper / Bedrock).
 */
export function canUseAnthropicAskPath(config) {
  if (!config || !config.apiKey) return false;
  return config.authType === 'api_key' || config.authType === 'auth_token';
}

/**
 * Cap output tokens based on input size so long requirements are not truncated
 * while short prompts stay cheap.
 */
export function computeMaxTokens(promptLength) {
  const len = typeof promptLength === 'number' && Number.isFinite(promptLength) && promptLength > 0
    ? promptLength
    : 0;
  return Math.min(8192, Math.max(2048, Math.ceil(len * 2)));
}

/**
 * Emit a progressive content delta marker for the Java process runner.
 * Uses stdout.write so markers stay line-atomic and unbuffered relative to logs.
 */
export function emitContentDelta(text) {
  if (typeof text !== 'string' || !text) return;
  process.stdout.write(`[CONTENT_DELTA] ${JSON.stringify(text)}\n`);
}

/**
 * Fast Claude path: Anthropic SDK messages.stream (no Agent SDK cold start).
 * Native SSE token streaming via .on('text').
 */
async function enhancePromptWithClaudeAsk(originalPrompt, systemPrompt, model, context) {
  const anthropicModule = await ensureAnthropicSdk();
  const Anthropic = anthropicModule.default || anthropicModule.Anthropic || anthropicModule;

  const config = setupApiKey();
  if (!canUseAnthropicAskPath(config)) {
    throw new Error('Anthropic ask path unavailable for current auth');
  }

  const settings = loadClaudeSettings();
  const modelId = resolveModelFromSettings(model, settings && settings.env);
  const fullPrompt = buildFullPrompt(originalPrompt, context);
  const maxTokens = computeMaxTokens(fullPrompt.length);

  console.log(`[PromptEnhancer] Claude ask path model: ${model} -> ${modelId}`);
  console.log(`[PromptEnhancer] Base URL: ${config.baseUrl || 'https://api.anthropic.com'}`);
  console.log(`[PromptEnhancer] Auth type: ${config.authType}`);
  console.log(`[PromptEnhancer] Full prompt length: ${fullPrompt.length}, max_tokens: ${maxTokens}`);

  const clientOpts = {
    baseURL: config.baseUrl || undefined,
    defaultHeaders: { 'x-app': 'cli', 'User-Agent': getCliUserAgent() },
  };
  if (config.authType === 'auth_token') {
    clientOpts.authToken = config.apiKey;
    clientOpts.apiKey = null;
  } else {
    clientOpts.apiKey = config.apiKey;
  }
  const client = new Anthropic(clientOpts);

  console.log('[PromptEnhancer] Streaming via Anthropic SDK messages.stream()...');

  let streamedText = '';
  const request = {
    model: modelId,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: fullPrompt }],
  };
  if (systemPrompt && String(systemPrompt).trim()) {
    request.system = String(systemPrompt).trim();
  }

  const stream = client.messages.stream(request);
  stream.on('text', (text) => {
    if (text) {
      emitContentDelta(text);
      streamedText += text;
    }
  });

  const finalMessage = await stream.finalMessage();

  if (!streamedText.trim() && finalMessage && Array.isArray(finalMessage.content)) {
    for (const block of finalMessage.content) {
      if (block && block.type === 'text' && block.text) {
        emitContentDelta(block.text);
        streamedText += block.text;
      }
    }
  }

  console.log(`[PromptEnhancer] Claude ask response length: ${streamedText.length}`);
  if (streamedText.trim()) {
    return streamedText.trim();
  }
  throw new Error('Claude enhancement response is empty');
}

/**
 * Fallback Claude path: Agent SDK (CLI login / apiKeyHelper / Bedrock).
 * Emits CONTENT_DELTA from stream_event text deltas when available.
 */
async function enhancePromptWithClaudeAgent(originalPrompt, systemPrompt, model, context) {
  const sdk = await ensureClaudeSdk();
  const { query } = sdk;

  const config = setupApiKey();
  console.log(`[PromptEnhancer] Auth type: ${config.authType}`);
  console.log(`[PromptEnhancer] Base URL: ${config.baseUrl || 'https://api.anthropic.com'}`);

  const sdkModelName = mapModelIdToSdkName(model);
  console.log(`[PromptEnhancer] Claude Agent model mapping: ${model} -> ${sdkModelName}`);

  const workingDirectory = getRealHomeDir();
  const fullPrompt = buildFullPrompt(originalPrompt, context);
  console.log(`[PromptEnhancer] Full prompt length: ${fullPrompt.length}`);

  const claudeCliOverride = getClaudeCliPathOverride();
  const options = {
    cwd: workingDirectory,
    // Prompt enhancement only rewrites text — it must never execute tools. Use default
    // mode with a deny-all canUseTool, and do NOT load project/local settings (whose
    // permissions.allow could otherwise auto-approve a prompt-injected tool call).
    permissionMode: 'default',
    model: sdkModelName,
    maxTurns: 1,
    env: buildCliEnv(),
    settings: buildWebviewControlledSettingsOverride(model),
    systemPrompt,
    settingSources: ['user'],
    canUseTool: async () => ({ behavior: 'deny', message: 'Prompt enhancement does not execute tools' }),
    includePartialMessages: true,
    ...(claudeCliOverride && { pathToClaudeCodeExecutable: claudeCliOverride }),
  };

  console.log('[PromptEnhancer] Calling Claude Agent SDK...');

  const result = query({
    prompt: fullPrompt,
    options,
  });

  let responseText = '';
  let hasStreamDeltas = false;
  let messageCount = 0;

  for await (const msg of result) {
    messageCount += 1;
    console.log(`[PromptEnhancer] Claude message #${messageCount}, type: ${msg.type}`);

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

  console.log(`[PromptEnhancer] Claude Agent response length: ${responseText.length}`);
  if (responseText.trim()) {
    return responseText.trim();
  }

  throw new Error('Claude enhancement response is empty');
}

async function enhancePromptWithClaude(originalPrompt, systemPrompt, model, context) {
  const config = setupApiKey();
  // Prefer the lightweight Anthropic messages.stream path when a real API key is present.
  // Do not fall back mid-stream: partial CONTENT_DELTA markers may already have been
  // flushed to Java, and a second path would corrupt the progressive UI.
  if (canUseAnthropicAskPath(config)) {
    console.log('[PromptEnhancer] Using Anthropic ask (messages.stream) path');
    return enhancePromptWithClaudeAsk(originalPrompt, systemPrompt, model, context);
  }
  console.log(`[PromptEnhancer] Using Agent SDK path (auth: ${config.authType || 'unknown'})`);
  return enhancePromptWithClaudeAgent(originalPrompt, systemPrompt, model, context);
}

async function enhancePromptWithCodex(originalPrompt, systemPrompt, model, context) {
  const sdk = await ensureCodexSdk();
  const Codex = sdk.Codex || sdk.default || sdk;
  const { cliEnv } = buildCodexCliEnvironment(process.env);
  const codex = new Codex({ env: cliEnv });

  const workingDirectory = getRealHomeDir();
  const systemPromptText = (systemPrompt || '').trim();
  const fullPrompt = [
    systemPromptText,
    '',
    buildFullPrompt(originalPrompt, context),
    '',
    'Remember: output only the optimized prompt text with no explanation.',
  ].join('\n');
  console.log(`[PromptEnhancer] Full prompt length: ${fullPrompt.length}`);

  const thread = codex.startThread({
    skipGitRepoCheck: true,
    maxTurns: 1,
    workingDirectory,
    model,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
  });

  console.log(`[PromptEnhancer] Calling Codex SDK with model: ${model}`);

  const { events } = await thread.runStreamed(fullPrompt);
  let responseText = '';
  let lastAgentMessage = '';

  for await (const event of events) {
    console.log(`[PromptEnhancer] Codex event: ${event.type}`);
    if (event.type === 'item.updated' || event.type === 'item.completed') {
      const item = event.item;
      if (item?.type === 'agent_message' && typeof item.text === 'string') {
        const delta = extractAppendedDelta(lastAgentMessage, item.text);
        if (delta) {
          emitContentDelta(delta);
          responseText += delta;
        }
        lastAgentMessage = item.text;
      }
      continue;
    }

    if (event.type === 'turn.failed') {
      throw new Error(event.error?.message || 'Codex enhancement turn failed');
    }

    if (event.type === 'error') {
      throw new Error(event.message || 'Codex enhancement failed');
    }
  }

  const finalText = responseText.trim() || lastAgentMessage.trim();
  console.log(`[PromptEnhancer] Codex response text length: ${finalText.length}`);
  if (finalText) {
    return finalText;
  }

  throw new Error('Codex enhancement response is empty');
}

/**
 * Headless CLI path (Grok / Kimi / OpenCode / PI).
 * Session-less ask — never emits chat markers; only CONTENT_DELTA via onDelta.
 */
async function enhancePromptWithCli(originalPrompt, systemPrompt, provider, model, context) {
  const systemPromptText = (systemPrompt || '').trim();
  const parts = [];
  if (systemPromptText) {
    parts.push(systemPromptText);
  }
  parts.push(buildFullPrompt(originalPrompt, context));
  parts.push('Remember: output only the optimized prompt text with no explanation. Do not run tools.');
  const fullPrompt = parts.join('\n\n');

  console.log(`[PromptEnhancer] CLI ask provider=${provider}, model=${model || '(default)'}, promptLen=${fullPrompt.length}`);

  return askCliProvider({
    provider,
    prompt: fullPrompt,
    model,
    cwd: getRealHomeDir(),
    onDelta: emitContentDelta,
  });
}

async function enhancePrompt(originalPrompt, systemPrompt, runtimeConfig, context) {
  if (runtimeConfig.provider === 'codex') {
    return enhancePromptWithCodex(originalPrompt, systemPrompt, runtimeConfig.model, context);
  }
  if (runtimeConfig.provider === 'claude') {
    return enhancePromptWithClaude(originalPrompt, systemPrompt, runtimeConfig.model, context);
  }
  if (isCliAskProvider(runtimeConfig.provider) || CLI_ONLY_PROVIDERS.has(runtimeConfig.provider)) {
    return enhancePromptWithCli(
      originalPrompt,
      systemPrompt,
      runtimeConfig.provider,
      runtimeConfig.model,
      context,
    );
  }
  return enhancePromptWithClaude(originalPrompt, systemPrompt, runtimeConfig.model, context);
}

export async function runPromptEnhancerRequest(data) {
  const {
    prompt,
    systemPrompt,
    legacyModel,
    context,
    promptEnhancerConfig,
    chatProvider,
    chatModel,
  } = data;

  if (!prompt) {
    return '';
  }

  const runtimeConfig = resolvePromptEnhancerRuntimeConfig({
    promptEnhancerConfig,
    legacyModel,
    chatProvider,
    chatModel,
  });
  console.log(`[PromptEnhancer] Resolved provider: ${runtimeConfig.provider}, model: ${runtimeConfig.model}, source: ${runtimeConfig.resolutionSource}`);

  return enhancePrompt(prompt, systemPrompt, runtimeConfig, context);
}

async function main() {
  try {
    const input = await readStdin();
    const data = JSON.parse(input);

    const { prompt, context } = data;

    if (!prompt) {
      process.stdout.write('[ENHANCED]\n');
      process.exit(0);
    }

    if (context) {
      console.log('[PromptEnhancer] Received context info:');
      if (context.selectedCode) {
        console.log(`  - Selected code: ${context.selectedCode.length} chars`);
      }
      if (context.currentFile) {
        console.log(`  - Current file: ${context.currentFile.path}`);
      }
      if (context.cursorPosition) {
        console.log(`  - Cursor position: line ${context.cursorPosition.line}`);
      }
      if (context.relatedFiles) {
        console.log(`  - Related files: ${context.relatedFiles.length}`);
      }
    } else {
      console.log('[PromptEnhancer] No context info received');
    }

    const enhancedPrompt = await runPromptEnhancerRequest(data);
    const encodedPrompt = enhancedPrompt.replace(/\n/g, '{{NEWLINE}}');
    process.stdout.write(`[ENHANCED]${encodedPrompt}\n`);
    process.exit(0);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error('[PromptEnhancer] Error:', message);
    process.stdout.write(`[ENHANCED_ERROR]${message}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
