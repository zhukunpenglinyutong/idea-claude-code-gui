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
import { setupApiKey, buildCliEnv, buildWebviewControlledSettingsOverride } from '../config/api-config.js';
import { mapModelIdToSdkName } from '../utils/model-utils.js';
import { getRealHomeDir } from '../utils/path-utils.js';
import { getClaudeCliPathOverride } from '../utils/claude-cli-path.js';
import { buildCodexCliEnvironment } from './codex/codex-utils.js';

let claudeSdk = null;
let codexSdk = null;

const DEFAULT_PROMPT_ENHANCER_CONFIG = {
  provider: null,
  effectiveProvider: 'claude',
  resolutionSource: 'auto',
  models: {
    claude: 'claude-sonnet-4-6',
    codex: 'gpt-5.5',
  },
  availability: {
    claude: false,
    codex: false,
  },
};

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

  return {
    provider: config.provider === 'claude' || config.provider === 'codex' ? config.provider : null,
    effectiveProvider: config.effectiveProvider === 'claude' || config.effectiveProvider === 'codex'
      ? config.effectiveProvider
      : null,
    resolutionSource: typeof config.resolutionSource === 'string' ? config.resolutionSource : 'auto',
    models: {
      claude: config.models?.claude || DEFAULT_PROMPT_ENHANCER_CONFIG.models.claude,
      codex: config.models?.codex || DEFAULT_PROMPT_ENHANCER_CONFIG.models.codex,
    },
    availability: {
      claude: Boolean(config.availability?.claude),
      codex: Boolean(config.availability?.codex),
    },
  };
}

export function resolvePromptEnhancerRuntimeConfig({ promptEnhancerConfig, legacyModel } = {}) {
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

  if (config.effectiveProvider === 'codex') {
    return {
      provider: 'codex',
      model: config.models.codex || DEFAULT_PROMPT_ENHANCER_CONFIG.models.codex,
      resolutionSource: config.resolutionSource,
    };
  }

  if (config.effectiveProvider === 'claude') {
    return {
      provider: 'claude',
      model: config.models.claude || DEFAULT_PROMPT_ENHANCER_CONFIG.models.claude,
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

  if (!codexSdkInstalled && !claudeSdkInstalled) {
    throw new Error('No available prompt enhancer provider is configured because both Claude Code and Codex SDKs are not installed.');
  }

  throw new Error('No available prompt enhancer provider is configured. Please configure Codex or Claude Code in Settings.');
}

async function enhancePromptWithClaude(originalPrompt, systemPrompt, model, context) {
  const sdk = await ensureClaudeSdk();
  const { query } = sdk;

  const config = setupApiKey();
  console.log(`[PromptEnhancer] Auth type: ${config.authType}`);
  console.log(`[PromptEnhancer] Base URL: ${config.baseUrl || 'https://api.anthropic.com'}`);

  const sdkModelName = mapModelIdToSdkName(model);
  console.log(`[PromptEnhancer] Claude model mapping: ${model} -> ${sdkModelName}`);

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
    ...(claudeCliOverride && { pathToClaudeCodeExecutable: claudeCliOverride }),
  };

  console.log('[PromptEnhancer] Calling Claude Agent SDK...');

  const result = query({
    prompt: fullPrompt,
    options,
  });

  let responseText = '';
  let messageCount = 0;

  for await (const msg of result) {
    messageCount += 1;
    console.log(`[PromptEnhancer] Claude message #${messageCount}, type: ${msg.type}`);

    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            responseText += block.text;
          }
        }
      } else if (typeof content === 'string') {
        responseText += content;
      }
    }
  }

  console.log(`[PromptEnhancer] Claude response text length: ${responseText.length}`);
  if (responseText.trim()) {
    return responseText.trim();
  }

  throw new Error('Claude enhancement response is empty');
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

async function enhancePrompt(originalPrompt, systemPrompt, runtimeConfig, context) {
  if (runtimeConfig.provider === 'codex') {
    return enhancePromptWithCodex(originalPrompt, systemPrompt, runtimeConfig.model, context);
  }
  return enhancePromptWithClaude(originalPrompt, systemPrompt, runtimeConfig.model, context);
}

export async function runPromptEnhancerRequest(data) {
  const { prompt, systemPrompt, legacyModel, context, promptEnhancerConfig } = data;

  if (!prompt) {
    return '';
  }

  const runtimeConfig = resolvePromptEnhancerRuntimeConfig({
    promptEnhancerConfig,
    legacyModel,
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
      console.log('[ENHANCED]');
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
    console.log(`[ENHANCED]${encodedPrompt}`);
    process.exit(0);
  } catch (error) {
    console.error('[PromptEnhancer] Error:', error.message);
    console.log(`[ENHANCED]Enhancement failed: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
