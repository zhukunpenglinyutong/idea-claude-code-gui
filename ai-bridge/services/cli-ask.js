/**
 * Session-less one-shot text generation via headless CLIs.
 *
 * Used by prompt-enhancer and commit-message so Grok / Kimi / OpenCode / PI
 * can run outside the chat marker protocol (no [MESSAGE_START]/SESSION_ID]/SEND_ERROR]).
 * Optional progressive tokens go through `onDelta` only — callers emit their own
 * `[CONTENT_DELTA]` markers for Java process runners.
 *
 * SECURITY NOTE: prompts here embed third-party controlled text (git diffs,
 * pasted content). Grok runs with permissionMode 'deny' (all tool requests
 * auto-rejected). Kimi / OpenCode / PI expose no headless tool-disable flag;
 * they rely on each CLI's non-interactive defaults plus a prompt-level
 * "Do not run tools" instruction. If these CLIs add a read-only/no-tools
 * flag, wire it here.
 */

import { homedir } from 'os';

import {
  resolveGrokCliPath,
  resolveKimiCliPath,
  resolveOpenCodeCliPath,
  resolvePiCliPath,
  resolveOmpCliPath,
  resolveMimoCliPath,
  enrichPathWithBinDirs,
  commonCliBinDirs,
} from '../utils/cli-path.js';
import { runCliStreaming } from '../utils/cli-spawn.js';
import { safePromptArg } from '../utils/marker-protocol.js';
import { getRealHomeDir } from '../utils/path-utils.js';
import { runAcpTurn } from './grok/grok-acp-client.js';
import { buildGrokEnv, resolveEffectiveGrokAuth } from './grok/grok-utils.js';

export const CLI_ASK_PROVIDERS = ['grok', 'kimi', 'opencode', 'pi', 'omp', 'mimo'];

const DEFAULT_MODELS = {
  grok: 'grok',
  kimi: 'auto',
  opencode: 'opencode-default',
  pi: 'auto',
  omp: 'auto',
  mimo: 'auto',
};

function isDefaultModelToken(model) {
  if (model == null) return true;
  const trimmed = String(model).trim();
  if (!trimmed) return true;
  const lower = trimmed.toLowerCase();
  return (
    lower === '__config_default__'
    || lower === 'auto'
    || lower === 'default'
    || lower === '(default)'
    || lower === 'config-default'
    || lower === 'config_default'
    || lower === 'opencode-default'
    || lower === 'opencode default'
    || lower === 'pi-default'
    || lower === 'pi default'
    || lower === 'omp-default'
    || lower === 'omp default'
    || lower === 'mimo-default'
    || lower === 'mimo default'
  );
}

function resolveModelFlag(model) {
  if (isDefaultModelToken(model)) return null;
  const value = String(model).trim();
  // A leading dash would be parsed as a new flag instead of the --model value.
  if (value.startsWith('-')) {
    console.error(`[CliAsk] dropping suspicious model id: ${value}`);
    return null;
  }
  return value;
}

function extractAcpText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (typeof content === 'object') {
    if (typeof content.text === 'string') return content.text;
    if (typeof content.content === 'string') return content.content;
  }
  return '';
}

function extractAssistantText(value) {
  const content = value?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .join('');
  }
  return '';
}

/**
 * Snapshot-style assistant text merge (Kimi often re-emits growing prefixes).
 */
export function mergeAssistantTextSnapshot(accumulated, incoming) {
  if (!incoming) return null;
  if (!accumulated) return incoming;
  if (incoming === accumulated) return null;
  if (incoming.startsWith(accumulated)) return incoming.slice(accumulated.length);
  if (accumulated.startsWith(incoming)) return null;
  return `\n${incoming}`;
}

function firstNonEmptyStr(candidates) {
  for (const value of candidates) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
}

/**
 * Extract a human-readable error from CLI JSON events.
 * OpenCode 1.x uses nested `{ error: { name, data: { message } } }`.
 * Exported for unit tests.
 */
export function extractCliEventErrorMessage(event) {
  if (!event || typeof event !== 'object') return null;
  return firstNonEmptyStr([
    event?.error?.message,
    event?.error?.data?.message,
    typeof event?.error?.data === 'string' ? event.error.data : null,
    typeof event?.error === 'string' ? event.error : null,
    event?.message,
    event?.data?.message,
    typeof event?.error?.name === 'string' ? event.error.name : null,
  ]);
}

function extractOpenCodeTextDelta(event) {
  const direct = firstNonEmptyStr([
    event?.text,
    event?.delta,
    event?.content,
    event?.data,
    event?.part?.text,
    event?.part?.delta,
    event?.output_text,
  ]);
  if (direct) return direct;

  const message = event?.message;
  if (message && typeof message === 'object') {
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      const joined = message.content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
          return '';
        })
        .join('');
      if (joined) return joined;
    }
    if (typeof message.text === 'string') return message.text;
  }
  return null;
}

function buildWorkCwd(cwd) {
  if (cwd && cwd !== 'undefined' && cwd !== 'null' && String(cwd).trim()) {
    return String(cwd).trim();
  }
  try {
    return getRealHomeDir() || process.cwd();
  } catch {
    return process.cwd();
  }
}

function buildCliEnv() {
  const env = { ...process.env };
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  enrichPathWithBinDirs(env, commonCliBinDirs(home));
  return env;
}

async function collectFromStreamingCli({
  bin,
  args,
  cwd,
  label,
  onLine,
  onDelta,
}) {
  let text = '';
  let streamError = '';
  const result = await runCliStreaming({
    bin,
    args,
    cwd,
    env: buildCliEnv(),
    label,
    emitEndStream: false,
    onError: (message) => {
      streamError = message;
    },
    onLine: (line) => {
      const delta = onLine(line);
      if (typeof delta === 'string' && delta) {
        text += delta;
        if (typeof onDelta === 'function') onDelta(delta);
      }
    },
  });

  if (result.hadError) {
    throw new Error(streamError || result.errorMessage || `${label} CLI failed`);
  }
  const finalText = text.trim();
  if (!finalText) {
    throw new Error(`${label} CLI response is empty`);
  }
  return finalText;
}

async function askGrok(prompt, { model, cwd, onDelta } = {}) {
  const preferredAuth = process.env.GROK_AUTH_METHOD || '';
  const resolvedAuth = resolveEffectiveGrokAuth({
    preferredAuth,
    apiKey: process.env.XAI_API_KEY || process.env.GROK_API_KEY || '',
    baseUrl: process.env.GROK_BASE_URL || '',
  });
  const env = buildGrokEnv(
    process.env,
    resolvedAuth.apiKey,
    resolvedAuth.baseUrl,
    resolvedAuth.authMethod,
    false
  );

  // Warm path resolution for clearer errors when the binary is missing.
  resolveGrokCliPath();

  let text = '';
  await runAcpTurn({
    message: prompt,
    sessionId: '',
    cwd: buildWorkCwd(cwd),
    model: resolveModelFlag(model) || '',
    apiKey: resolvedAuth.apiKey,
    baseUrl: resolvedAuth.baseUrl,
    authMethod: resolvedAuth.authMethod,
    // Text-only, session-less features: auto-DENY all tool requests. There is
    // no UI to render a permission dialog, and the prompt embeds third-party
    // controlled text (git diffs / pasted content) that must not be able to
    // drive silent tool execution.
    permissionMode: 'deny',
    env,
    onEvent: (type, payload) => {
      if (type !== 'notification') return;
      if (payload?.method !== 'session/update') return;
      const update = payload?.params?.update || payload?.params;
      if (!update || typeof update !== 'object') return;
      const kind = update.sessionUpdate || update.type || '';
      // Only final answer chunks — ignore thoughts / tools / noise.
      if (kind !== 'agent_message_chunk') return;
      const chunk = extractAcpText(update.content) || (typeof update.text === 'string' ? update.text : '');
      if (!chunk) return;
      text += chunk;
      if (typeof onDelta === 'function') onDelta(chunk);
    },
    onStderr: (chunk) => {
      const s = String(chunk || '').trim();
      if (s) console.error('[CliAsk][Grok]', s.slice(0, 500));
    },
  });

  const finalText = text.trim();
  if (!finalText) {
    throw new Error('Grok CLI response is empty');
  }
  return finalText;
}

async function askKimi(prompt, { model, cwd, onDelta } = {}) {
  const bin = resolveKimiCliPath();
  const args = [
    '--output-format', 'stream-json',
    '--prompt', safePromptArg(prompt),
  ];
  const modelFlag = resolveModelFlag(model);
  if (modelFlag) args.push('--model', modelFlag);

  let accumulated = '';
  return collectFromStreamingCli({
    bin,
    args,
    cwd: buildWorkCwd(cwd),
    label: 'Kimi',
    onDelta,
    onLine: (line) => {
      if (!line || !line.trim()) return '';
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        return '';
      }
      if (!value || typeof value !== 'object' || value.role !== 'assistant') return '';
      // Skip pure tool_calls frames.
      if (Array.isArray(value.tool_calls) && value.tool_calls.length > 0 && !extractAssistantText(value)) {
        return '';
      }
      const incoming = extractAssistantText(value);
      const delta = mergeAssistantTextSnapshot(accumulated, incoming);
      if (!delta) return '';
      if (!accumulated) {
        accumulated = incoming;
      } else if (incoming.startsWith(accumulated)) {
        accumulated = incoming;
      } else if (!accumulated.startsWith(incoming)) {
        accumulated = `${accumulated}${delta}`;
      }
      return delta;
    },
  });
}

async function askOpenCode(prompt, { model, cwd, onDelta } = {}) {
  const bin = resolveOpenCodeCliPath();
  const args = ['run', '--format', 'json'];
  const modelFlag = resolveModelFlag(model);
  if (modelFlag) args.push('--model', modelFlag);
  args.push(safePromptArg(prompt));

  let structuredError = '';
  try {
    return await collectFromStreamingCli({
      bin,
      args,
      cwd: buildWorkCwd(cwd),
      label: 'OpenCode',
      onDelta,
      onLine: (line) => {
        if (!line || !line.trim()) return '';
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return '';
        }
        if (!event || typeof event !== 'object') return '';
        const type = typeof event.type === 'string' ? event.type : '';
        const lower = type.toLowerCase();
        if (lower === 'error' || lower.endsWith('.error')) {
          const message = extractCliEventErrorMessage(event);
          if (message) structuredError = message;
          return '';
        }
        if (
          lower === 'reasoning_delta'
          || lower.includes('reasoning')
          || lower.includes('think')
        ) {
          return '';
        }
        if (
          lower === 'text'
          || lower === 'content_delta'
          || lower === 'text_delta'
          || lower === 'output_text_delta'
          || lower === 'assistant_message_delta'
          || lower === 'message_delta'
          || lower === 'assistant_message'
          || lower === 'message'
          || ((lower.includes('delta') || lower.includes('message') || lower.includes('text'))
            && extractOpenCodeTextDelta(event))
        ) {
          return extractOpenCodeTextDelta(event) || '';
        }
        return '';
      },
    });
  } catch (error) {
    if (structuredError) {
      throw new Error(structuredError);
    }
    throw error;
  }
}

async function askPi(prompt, { model, cwd, onDelta } = {}) {
  const bin = resolvePiCliPath();
  const args = ['--print', '--mode', 'json'];
  const modelFlag = resolveModelFlag(model);
  if (modelFlag) args.push('--model', modelFlag);
  args.push(safePromptArg(prompt));

  return collectFromStreamingCli({
    bin,
    args,
    cwd: buildWorkCwd(cwd),
    label: 'PI',
    onDelta,
    onLine: (line) => {
      if (!line || !line.trim()) return '';
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return '';
      }
      if (!event || typeof event !== 'object') return '';
      if (event.type !== 'message_update') return '';
      const update = event.assistantMessageEvent;
      if (!update || typeof update !== 'object') return '';
      if (update.type === 'text_delta' && typeof update.delta === 'string' && update.delta) {
        return update.delta;
      }
      return '';
    },
  });
}

/**
 * One-shot ask via MiMo Code (`mimo run --format json`).
 *
 * MiMo Code is an OpenCode fork, so the headless event stream matches
 * upstream OpenCode 1.x and the parser mirrors askOpenCode.
 */
async function askMimo(prompt, { model, cwd, onDelta } = {}) {
  const bin = resolveMimoCliPath();
  const args = ['run', '--format', 'json'];
  const modelFlag = resolveModelFlag(model);
  if (modelFlag) args.push('--model', modelFlag);
  args.push(safePromptArg(prompt));

  let structuredError = '';
  try {
    return await collectFromStreamingCli({
      bin,
      args,
      cwd: buildWorkCwd(cwd),
      label: 'MiMo',
      onDelta,
      onLine: (line) => {
        if (!line || !line.trim()) return '';
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return '';
        }
        if (!event || typeof event !== 'object') return '';
        const type = typeof event.type === 'string' ? event.type : '';
        const lower = type.toLowerCase();
        if (lower === 'error' || lower.endsWith('.error')) {
          const message = extractCliEventErrorMessage(event);
          if (message) structuredError = message;
          return '';
        }
        if (
          lower === 'reasoning_delta'
          || lower.includes('reasoning')
          || lower.includes('think')
        ) {
          return '';
        }
        if (
          lower === 'text'
          || lower === 'content_delta'
          || lower === 'text_delta'
          || lower === 'output_text_delta'
          || lower === 'assistant_message_delta'
          || lower === 'message_delta'
          || lower === 'assistant_message'
          || lower === 'message'
          || ((lower.includes('delta') || lower.includes('message') || lower.includes('text'))
            && extractOpenCodeTextDelta(event))
        ) {
          return extractOpenCodeTextDelta(event) || '';
        }
        return '';
      },
    });
  } catch (error) {
    if (structuredError) {
      throw new Error(structuredError);
    }
    throw error;
  }
}

async function askOmp(prompt, { model, cwd, onDelta } = {}) {
  const bin = resolveOmpCliPath();
  const args = ['--print', '--mode', 'json'];
  const modelFlag = resolveModelFlag(model);
  if (modelFlag) args.push('--model', modelFlag);
  args.push(safePromptArg(prompt));

  return collectFromStreamingCli({
    bin,
    args,
    cwd: buildWorkCwd(cwd),
    label: 'OMP',
    onDelta,
    onLine: (line) => {
      if (!line || !line.trim()) return '';
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return '';
      }
      if (!event || typeof event !== 'object') return '';
      if (event.type !== 'message_update') return '';
      const update = event.assistantMessageEvent;
      if (!update || typeof update !== 'object') return '';
      if (update.type === 'text_delta' && typeof update.delta === 'string' && update.delta) {
        return update.delta;
      }
      return '';
    },
  });
}

/**
 * One-shot text generation for a CLI provider.
 *
 * @param {object} options
 * @param {'grok'|'kimi'|'opencode'|'pi'|'omp'|'mimo'} options.provider
 * @param {string} options.prompt
 * @param {string} [options.model]
 * @param {string} [options.cwd]
 * @param {(delta: string) => void} [options.onDelta]
 * @returns {Promise<string>}
 */
export async function askCliProvider({
  provider,
  prompt,
  model,
  cwd,
  onDelta,
} = {}) {
  if (!provider || !CLI_ASK_PROVIDERS.includes(provider)) {
    throw new Error(`Unsupported CLI ask provider: ${provider || '(none)'}`);
  }
  if (!prompt || !String(prompt).trim()) {
    return '';
  }

  const resolvedModel = model || DEFAULT_MODELS[provider] || '';
  const opts = { model: resolvedModel, cwd, onDelta };

  switch (provider) {
    case 'grok':
      return askGrok(prompt, opts);
    case 'kimi':
      return askKimi(prompt, opts);
    case 'opencode':
      return askOpenCode(prompt, opts);
    case 'pi':
      return askPi(prompt, opts);
    case 'omp':
      return askOmp(prompt, opts);
    case 'mimo':
      return askMimo(prompt, opts);
    default:
      throw new Error(`Unsupported CLI ask provider: ${provider}`);
  }
}

export function isCliAskProvider(provider) {
  return typeof provider === 'string' && CLI_ASK_PROVIDERS.includes(provider);
}
