/**
 * MiniMax Code CLI message service.
 *
 * Spawns local `minimax` (mcode) headless mode and maps its stream-json NDJSON
 * onto the shared bridge marker protocol (same markers as Grok/Kimi/OpenCode).
 *
 * CLI:
 *   minimax exec --output-format stream-json --cwd <dir> --permission <policy>
 *        [--model <provider/model>] [--session <id>] "<prompt>"
 *
 * Verified stream event types (mcode >= 0.2.x):
 *   {"type":"heartbeat","turnId":...}
 *   {"type":"message","message":{"role":"user"|"assistant","content",...,"usage":{...}}}
 *   {"type":"generic","eventType":...}                       (UI noise)
 *   {"type":"session-status","status":"started"|"finished"}
 *   {"type":"delta","role":"assistant","thinking":"..."|"content":"...",...}
 *   {"type":"delta","role":"assistant","toolCalls":[{"id","name","status","input","output"}]}
 *   {"type":"done","turnId":...}
 *   {"type":"exec.result","sessionId":"mvs_...","answer":...,"status":"succeeded"}
 *
 * toolCalls status: 1 = call started, 2 = finished (with output.content[]).
 * The CLI keeps running after exec.result — the child tree is killed once the
 * result line is seen (shouldTerminate in runCliStreaming).
 *
 * Auth/config comes from the MiniMax CLI native home (~/.minimax).
 */

import { homedir } from 'os';
import { resolveMiniMaxCliPath, enrichPathWithBinDirs, commonCliBinDirs } from '../../utils/cli-path.js';
import { runCliStreaming } from '../../utils/cli-spawn.js';
import {
  beginStream,
  emitJsonStringMarker,
  emitSendError,
  emitSessionId,
  emitUsage,
  emitToolResultMessage,
  emitToolUseMessage,
  isNonEmptySessionId,
  safePromptArg,
} from '../../utils/marker-protocol.js';
import {
  buildKimiPromptWithImages,
  cleanupMaterializedImagePaths,
  materializeImageAttachments,
} from '../../utils/cli-image-input.js';

function logDebug(...args) {
  console.error('[DEBUG][MiniMax]', ...args);
}

/**
 * Map CCGUI permission modes onto mcode --permission policies
 * (ask | smart | full | off). "ask" is never used: headless exec cannot
 * answer an interactive permission prompt.
 */
function resolvePermissionPolicy(permissionMode) {
  const value = String(permissionMode || '').trim().toLowerCase();
  if (
    value === 'bypasspermissions'
    || value === 'bypass'
    || value === 'dangerouslyskippedpermissions'
    || value === 'yolo'
    || value === 'off'
  ) {
    return 'off';
  }
  if (value === 'acceptedits' || value === 'acceptall' || value === 'full') {
    return 'full';
  }
  return 'smart';
}

function resolveModelFlag(model) {
  if (model == null) return null;
  const trimmed = String(model).trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (
    lower === '__config_default__'
    || lower === 'auto'
    || lower === 'default'
    || lower === '(default)'
    || lower === 'config-default'
    || lower === 'config_default'
  ) {
    return null;
  }
  return trimmed;
}

function extractToolOutputText(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  const content = output.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

function parseToolArguments(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return { value: String(raw) };
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
  } catch {
    return { raw: trimmed };
  }
}

/**
 * Map one mcode stream-json line onto a small event descriptor.
 */
export function parseMiniMaxStreamLine(line) {
  if (!line || !line.trim()) return { kind: 'other' };
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return { kind: 'other' };
  }
  if (!value || typeof value !== 'object') return { kind: 'other' };

  const type = typeof value.type === 'string' ? value.type : '';
  switch (type) {
    case 'delta': {
      const events = [];
      const messageId = typeof value.messageId === 'string' ? value.messageId : '';
      if (typeof value.thinking === 'string' && value.thinking) {
        events.push({ kind: 'thinking', data: value.thinking, messageId });
      }
      if (typeof value.content === 'string' && value.content) {
        events.push({ kind: 'text', data: value.content, messageId });
      }
      if (Array.isArray(value.toolCalls) && value.toolCalls.length > 0) {
        for (const call of value.toolCalls) {
          if (!call || typeof call !== 'object') continue;
          const id = typeof call.id === 'string' ? call.id : '';
          const name = typeof call.name === 'string' && call.name ? call.name : 'tool';
          const toolCall = { id: id || `minimax-tool-${name}`, name, input: parseToolArguments(call.input) };
          if (call.status === 2) {
            events.push({ kind: 'tool_done', call: toolCall, output: extractToolOutputText(call.output) });
          } else if (call.status === 1) {
            events.push({ kind: 'tool_start', call: toolCall });
          }
        }
      }
      if (events.length === 0) return { kind: 'other' };
      if (events.length === 1) return events[0];
      return { kind: 'multi', events };
    }
    case 'message': {
      const message = value.message;
      if (!message || typeof message !== 'object') return { kind: 'other' };
      if (message.role === 'assistant' && message.usage && typeof message.usage === 'object') {
        return { kind: 'usage', usage: message.usage, message };
      }
      return { kind: 'other' };
    }
    case 'exec.result': {
      const sessionId = typeof value.sessionId === 'string' ? value.sessionId.trim() : '';
      const status = typeof value.status === 'string' ? value.status : '';
      const errorMessage = typeof value.error === 'string' && value.error.trim()
        ? value.error.trim()
        : (typeof value.message === 'string' ? value.message.trim() : '');
      // Anything other than an explicit success counts as failure: the stream
      // is terminated on this line, so a failed run must not end in silence.
      const failed = status !== '' && status.toLowerCase() !== 'succeeded';
      return { kind: 'result', sessionId, status, failed, errorMessage };
    }
    default:
      return { kind: 'other' };
  }
}

function buildMiniMaxArgs({ message, sessionId, model, permissionMode, cwd }) {
  const args = [
    'exec',
    '--output-format', 'stream-json',
    '--permission', resolvePermissionPolicy(permissionMode),
  ];
  const modelFlag = resolveModelFlag(model);
  if (modelFlag) {
    args.push('--model', modelFlag);
  }
  if (isNonEmptySessionId(sessionId)) {
    args.push('--session', sessionId.trim());
  }
  if (cwd && cwd !== 'undefined' && cwd !== 'null') {
    args.push('--cwd', cwd);
  }
  args.push(safePromptArg(message));
  return args;
}

/**
 * @param {string} message
 * @param {string} sessionId
 * @param {string} cwd
 * @param {string} model
 * @param {string} [_reasoningEffort] unused (mcode reasoning is model-driven)
 * @param {Array} [attachments] image attachments (fileName/mediaType/data)
 * @param {string} [permissionMode] CCGUI permission mode
 */
export async function sendMessage(
  message,
  sessionId = '',
  cwd = '',
  model = '',
  _reasoningEffort = '',
  attachments = [],
  permissionMode = ''
) {
  beginStream();

  // Headless exec has no multimodal prompt payload; materialize images to
  // temp files and append path instructions (same approach as Kimi bridge).
  let promptText = message || '';
  let imagePaths = [];
  try {
    imagePaths = await materializeImageAttachments(attachments);
    if (imagePaths.length > 0) {
      promptText = buildKimiPromptWithImages(promptText, imagePaths);
      logDebug('image attachments', imagePaths.length, imagePaths);
    }
  } catch (err) {
    console.error('[MiniMax] failed to materialize image attachments:', err?.message || err);
  }

  const bin = resolveMiniMaxCliPath();
  const args = buildMiniMaxArgs({
    message: promptText,
    sessionId,
    model,
    permissionMode,
    cwd,
  });
  const resolvedSessionId = isNonEmptySessionId(sessionId) ? sessionId.trim() : null;
  if (resolvedSessionId) {
    emitSessionId(resolvedSessionId);
  }

  logDebug('spawn', bin, args.filter((arg) => arg !== promptText).join(' '),
    `promptLen=${String(promptText || '').length}`, `permission=${resolvePermissionPolicy(permissionMode)}`);

  const env = { ...process.env };
  const home = process.env.HOME || process.env.USERPROFILE || homedir();
  enrichPathWithBinDirs(env, commonCliBinDirs(home));

  const workCwd = cwd && cwd !== 'undefined' && cwd !== 'null' ? cwd : process.cwd();
  const seenToolUseIds = new Set();
  const seenToolResultIds = new Set();
  const streamedContentMessageIds = new Set();
  const streamedThinkingMessageIds = new Set();

  const handleEvent = (event) => {
    if (!event || typeof event !== 'object') return;
    if (event.kind === 'multi') {
      for (const sub of event.events) handleEvent(sub);
      return;
    }
    switch (event.kind) {
      case 'text':
        emitJsonStringMarker('[CONTENT_DELTA]', event.data);
        break;
      case 'thinking':
        emitJsonStringMarker('[THINKING_DELTA]', event.data);
        break;
      case 'tool_start':
        if (!seenToolUseIds.has(event.call.id)) {
          seenToolUseIds.add(event.call.id);
          emitToolUseMessage(event.call);
        }
        break;
      case 'tool_done': {
        if (!seenToolUseIds.has(event.call.id)) {
          seenToolUseIds.add(event.call.id);
          emitToolUseMessage(event.call);
        }
        if (!seenToolResultIds.has(event.call.id)) {
          seenToolResultIds.add(event.call.id);
          emitToolResultMessage({ toolUseId: event.call.id, content: event.output });
        }
        break;
      }
      case 'usage':
        emitUsage(event.usage);
        // Safety net: if a finished assistant message never produced deltas
        // (e.g. non-streaming fallback), emit its full text/thinking once.
        if (event.message && typeof event.message === 'object' && event.message.id) {
          const msgId = String(event.message.id);
          const content = typeof event.message.content === 'string' ? event.message.content : '';
          if (content && !streamedContentMessageIds.has(msgId)) {
            streamedContentMessageIds.add(msgId);
            emitJsonStringMarker('[CONTENT_DELTA]', content);
          }
          const thinking = typeof event.message.thinking === 'string' ? event.message.thinking : '';
          if (thinking && !streamedThinkingMessageIds.has(msgId)) {
            streamedThinkingMessageIds.add(msgId);
            emitJsonStringMarker('[THINKING_DELTA]', thinking);
          }
        }
        break;
      case 'result': {
        if (event.sessionId && isNonEmptySessionId(event.sessionId)) {
          emitSessionId(event.sessionId);
        }
        // shouldTerminate kills the CLI on this line and suppresses the
        // non-zero exit code, so a failed run with no streamed output would
        // otherwise end the stream in silence — surface it explicitly.
        const nothingStreamed = streamedContentMessageIds.size === 0
          && streamedThinkingMessageIds.size === 0
          && seenToolUseIds.size === 0;
        if (event.failed && nothingStreamed) {
          emitSendError(
            event.errorMessage || `MiniMax CLI run failed (status: ${event.status})`,
            'MiniMax'
          );
        }
        break;
      }
      default:
        break;
    }
  };

  try {
    await runCliStreaming({
      bin,
      args,
      cwd: workCwd,
      env,
      label: 'MiniMax',
      onLine: (line) => {
        const event = parseMiniMaxStreamLine(line);
        // Track which messages already streamed deltas so the message-event
        // fallback in handleEvent does not duplicate their text.
        const events = event.kind === 'multi' ? event.events : [event];
        for (const ev of events) {
          if (!ev || typeof ev !== 'object' || !ev.messageId) continue;
          if (ev.kind === 'text') streamedContentMessageIds.add(ev.messageId);
          if (ev.kind === 'thinking') streamedThinkingMessageIds.add(ev.messageId);
        }
        handleEvent(event);
      },
      // mcode exec keeps running after the final result line — stop there.
      shouldTerminate: (line) => line.includes('"type":"exec.result"'),
    });
  } finally {
    await cleanupMaterializedImagePaths(imagePaths);
  }
}
