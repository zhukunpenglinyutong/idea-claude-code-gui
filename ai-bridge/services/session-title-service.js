/**
 * Session title generation service.
 * Generates AI titles for sessions using Haiku API.
 * Follows CLI's generate_session_title flow but runs independently in ai-bridge.
 */

import { appendFile, mkdir, access, open as fsOpen, stat as fsStat, readFile } from 'fs/promises';
import { join } from 'path';
import { setupApiKey, loadClaudeSettings, getCliUserAgent } from '../config/api-config.js';
import { ensureAnthropicSdk, ensureBedrockSdk } from './claude/message-utils.js';
import { resolveModelFromSettings } from '../utils/model-utils.js';
import { getClaudeProjectSessionFilePath, getCodemossDir } from '../utils/path-utils.js';

const DEFAULT_HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const MAX_CONVERSATION_TEXT = 1000;
// Aligns with Java HistoryDeleteService.SESSION_ID_PATTERN — alphanumeric,
// dot, dash, underscore. Defeats path-traversal payloads in upstream payloads.
const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
// Safety net for Haiku calls — avoids hung requests holding daemon resources.
const HAIKU_API_TIMEOUT_MS = 15000;

function isValidSessionId(sessionId) {
  return typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId);
}

const SESSION_TITLE_PROMPT = `Generate a concise title (3-7 words) for this coding session. The title must be in the SAME LANGUAGE as the user's message.

Return JSON: {"title": "..."}

English examples:
{"title": "Fix login button on mobile"}
{"title": "Refactor API error handling"}

Chinese examples:
{"title": "修复登录按钮移动端问题"}
{"title": "重构API错误处理逻辑"}

Bad: {"title": "Code changes"} (too vague)
Bad: {"title": "修复登录按钮在移动设备上不响应的问题"} (too long)`;

// --- Logging ---
// Title generation runs fire-and-forget after the daemon request completes,
// so activeRequestId is null. Output structured JSON via process.stdout.write
// which the daemon passes through for lines starting with '{'.
// DaemonBridge.java handles "title_log" events with appropriate log levels.

function logTitleEvent(level, message) {
  const line = JSON.stringify({
    type: 'daemon',
    event: 'title_log',
    level,
    message
  }) + '\n';
  process.stdout.write(line);
}

/**
 * Emit a title_generated daemon event so the Java layer can forward the
 * AI title to the frontend for immediate display in the chat header.
 */
function emitTitleGenerated(sessionId, title) {
  const line = JSON.stringify({
    type: 'daemon',
    event: 'title_generated',
    sessionId,
    title
  }) + '\n';
  process.stdout.write(line);
}

/**
 * Check whether the JSONL session file already contains an ai-title entry.
 * Reads the tail of the file to avoid loading the entire session history.
 * @param {string} sessionFile - Path to the JSONL session file
 * @returns {Promise<boolean>} True if an ai-title entry already exists
 */
async function hasExistingAiTitle(sessionFile) {
  try {
    await access(sessionFile);
    const stat = await fsStat(sessionFile);
    if (stat.size === 0) {
      return false;
    }
    const tailSize = Math.min(stat.size, 4096);
    const fd = await fsOpen(sessionFile, 'r');
    try {
      const buf = Buffer.alloc(tailSize);
      await fd.read(buf, 0, tailSize, stat.size - tailSize);
      const text = buf.toString('utf8');
      // Drop the first segment because it may be a partial line if the read
      // window started mid-line (only safe to parse complete JSONL records).
      const lines = text.split('\n');
      if (stat.size > tailSize) {
        lines.shift();
      }
      for (const line of lines) {
        if (!line) continue;
        try {
          if (JSON.parse(line).type === 'ai-title') {
            return true;
          }
        } catch {
          // Skip non-JSON / partial lines.
        }
      }
      return false;
    } finally {
      await fd.close();
    }
  } catch {
    return false;
  }
}

/**
 * Read the AI title generation toggle from ~/.codemoss/config.json.
 * Defaults to true (enabled) when the config is missing, malformed, or the
 * field is not set, matching the Java CodemossSettingsService default.
 * @returns {Promise<boolean>}
 */
async function isTitleGenerationEnabled() {
  try {
    const configPath = join(getCodemossDir(), 'config.json');
    const text = await readFile(configPath, 'utf8');
    const config = JSON.parse(text);
    if (config && typeof config === 'object' && 'aiTitleGenerationEnabled' in config) {
      return config.aiTitleGenerationEnabled !== false;
    }
    return true;
  } catch {
    return true;
  }
}

function getSessionFilePath(sessionId, cwd) {
  return getClaudeProjectSessionFilePath(sessionId, cwd);
}

// --- API ---

/**
 * Resolve the Haiku model ID from settings.json, matching CLI behavior.
 * Uses resolveModelFromSettings which reads settings.env directly,
 * checking ANTHROPIC_DEFAULT_HAIKU_MODEL before falling back to the default.
 * @returns {string} Model ID
 */
function resolveHaikuModel() {
  const settings = loadClaudeSettings();
  return resolveModelFromSettings(DEFAULT_HAIKU_MODEL, settings?.env) || DEFAULT_HAIKU_MODEL;
}

/**
 * Create an Anthropic client based on the auth configuration.
 * @param {object} config - API config from setupApiKey()
 * @returns {Promise<object>} Anthropic client instance
 */
async function createAnthropicClient(config) {
  const cliHeaders = {
    'x-app': 'cli',
    'User-Agent': getCliUserAgent()
  };

  if (config.authType === 'aws_bedrock') {
    const bedrockModule = await ensureBedrockSdk();
    const AnthropicBedrock = bedrockModule.AnthropicBedrock || bedrockModule.default || bedrockModule;
    return new AnthropicBedrock({ defaultHeaders: cliHeaders });
  }

  const anthropicModule = await ensureAnthropicSdk();
  const Anthropic = anthropicModule.default || anthropicModule.Anthropic || anthropicModule;

  if (config.authType === 'auth_token') {
    return new Anthropic({
      authToken: config.apiKey,
      apiKey: null,
      baseURL: config.baseUrl || undefined,
      defaultHeaders: cliHeaders
    });
  }

  return new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseUrl || undefined,
    defaultHeaders: cliHeaders
  });
}

/**
 * Call Haiku API to generate a title.
 * @param {string} userMessage - The user's first message text
 * @returns {Promise<string|null>} Generated title or null
 */
async function callHaikuApi(userMessage) {
  const config = setupApiKey();

  // CLI login uses SDK-native OAuth which the direct Anthropic SDK doesn't support.
  if (config.authType === 'cli_login') {
    logTitleEvent('info', 'Skipping title generation: CLI login mode not supported for direct API calls');
    return null;
  }

  if (!config.apiKey && config.authType !== 'api_key_helper') {
    logTitleEvent('info', 'Skipping title generation: no API key available (authType: ' + config.authType + ')');
    return null;
  }

  const client = await createAnthropicClient(config);
  const model = resolveHaikuModel();
  logTitleEvent('info', 'Calling Haiku API, model: ' + model);

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), HAIKU_API_TIMEOUT_MS);

  let response;
  try {
    response = await client.messages.create(
      {
        model,
        max_tokens: 128,
        messages: [{ role: 'user', content: userMessage }],
        system: SESSION_TITLE_PROMPT,
      },
      { signal: controller.signal }
    );
  } catch (err) {
    if (controller.signal.aborted) {
      logTitleEvent('warn', 'Haiku API call aborted after ' + HAIKU_API_TIMEOUT_MS + 'ms timeout');
      return null;
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
  }

  const text = (response.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();

  if (!text) {
    logTitleEvent('warn', 'Haiku API returned empty response');
    return null;
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed.title && typeof parsed.title === 'string') {
      return parsed.title.trim() || null;
    }
    logTitleEvent('warn', 'Haiku API response missing "title" field: ' + text.substring(0, 200));
    return null;
  } catch {
    const jsonMatch = text.match(/\{[^}]*"title"\s*:\s*"[^"]*"[^}]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.title && typeof parsed.title === 'string') {
          return parsed.title.trim() || null;
        }
      } catch {
        // fall through
      }
    }
    logTitleEvent('warn', 'Failed to parse Haiku API response as JSON: ' + text.substring(0, 200));
    return null;
  }
}

/**
 * Save AI title to the JSONL session file.
 * @param {string} sessionId
 * @param {string} title
 * @param {string|null} cwd
 */
async function saveAiTitle(sessionId, title, cwd) {
  try {
    const sessionFile = getSessionFilePath(sessionId, cwd);
    const dir = join(sessionFile, '..');

    await mkdir(dir, { recursive: true });

    const entry = {
      type: 'ai-title',
      aiTitle: title,
      sessionId
    };

    await appendFile(sessionFile, JSON.stringify(entry) + '\n', 'utf8');
    logTitleEvent('info', 'Saved AI title: "' + title + '" for session ' + sessionId);

    // Notify the Java layer so it can forward to the frontend for display
    emitTitleGenerated(sessionId, title);
    return true;
  } catch (e) {
    logTitleEvent('error', 'Failed to save AI title: ' + e.message);
    return false;
  }
}

/**
 * Generate and save an AI title for the session.
 * Called when a session turn ends successfully.
 * Fire-and-forget: errors are logged to IDEA via structured daemon events.
 *
 * @param {string} userMessage - The user's first message text (already extracted)
 * @param {string} sessionId - Session ID
 * @param {string|null} cwd - Working directory
 */
export async function generateSessionTitle(userMessage, sessionId, cwd) {
  if (!userMessage || !userMessage.trim() || !sessionId) {
    logTitleEvent('info', 'Skipping title generation: missing userMessage or sessionId');
    // Treat invalid input as "do not retry" — return true so callers don't
    // un-flag titleGenerationAttempted and re-trigger on the next turn.
    return true;
  }

  if (!isValidSessionId(sessionId)) {
    logTitleEvent('warn', 'Skipping title generation: invalid sessionId rejected');
    return true;
  }

  if (!(await isTitleGenerationEnabled())) {
    logTitleEvent('info', 'Skipping title generation: disabled in user settings');
    return true;
  }

  // Defensive: skip if the session already has an AI title (prevents overwrite).
  // The caller guards (!resumeSessionId / !requestedSessionId) normally prevent
  // duplicate calls, but this check protects against edge cases where the guard
  // fails or the session file already has a title from another source.
  try {
    const sessionFile = getSessionFilePath(sessionId, cwd);
    if (await hasExistingAiTitle(sessionFile)) {
      logTitleEvent('info', 'Skipping title generation: session already has an AI title');
      return true;
    }
  } catch (e) {
    logTitleEvent('warn', 'Failed to check existing AI title, proceeding: ' + e.message);
  }

  try {
    // Iterate by Unicode code point so we never split a surrogate pair
    // (e.g. CJK extension characters or emoji) when truncating.
    let input = userMessage;
    if (userMessage.length > MAX_CONVERSATION_TEXT) {
      const codePoints = Array.from(userMessage);
      if (codePoints.length > MAX_CONVERSATION_TEXT) {
        input = codePoints.slice(-MAX_CONVERSATION_TEXT).join('');
      }
    }

    const title = await callHaikuApi(input);
    if (title) {
      // saveAiTitle returning false signals an FS error; don't retry — disk
      // problems are usually persistent and a retry storm helps no one.
      await saveAiTitle(sessionId, title, cwd);
      return true;
    }
    // callHaikuApi returns null for permanent skips (cli_login, missing key,
    // unparseable response). Treat as "already attempted" so the caller does
    // not reset its guard and re-call on the next turn.
    logTitleEvent('info', 'Title generation returned no result for session ' + sessionId);
    return true;
  } catch (e) {
    // Thrown errors come from the SDK / network layer and are typically
    // transient — return false so callers may reset their guard and retry.
    logTitleEvent('error', 'Title generation failed: ' + e.message);
    return false;
  }
}
