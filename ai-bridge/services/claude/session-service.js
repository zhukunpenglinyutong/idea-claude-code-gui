/**
 * Session management service module.
 * Responsible for session persistence and history message management.
 */

import { existsSync, createReadStream, mkdirSync, readFileSync, appendFileSync, statSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { createInterface } from 'readline';
import { getClaudeProjectSessionFilePath } from '../../utils/path-utils.js';
import { selectConversationChain } from './conversation-chain.js';
import { extractTaskNotificationXml } from './task-notification-parser.js';

/**
 * Write a JSON payload as a single stdout line and await the flush.
 *
 * `console.log` is fire-and-forget: for a piped stdout the underlying
 * `process.stdout.write` is asynchronous, and a large payload (the full
 * session history returned by getSession easily exceeds the libuv
 * high-water mark) gets queued in an internal buffer. Once the handler
 * returns, channel-manager.js sets `process.exitCode` and lets the process
 * exit naturally -- which can race ahead of the buffer draining and
 * truncate the JSON mid-stream, surfacing as `MalformedJsonException` on
 * the Java side. Awaiting the write callback guarantees the bytes reach
 * the OS pipe before the process is allowed to exit.
 */
function writeJsonResponse(payload) {
  return new Promise((resolve) => {
    process.stdout.write(JSON.stringify(payload) + '\n', 'utf8', resolve);
  });
}

/**
 * Append a message to the JSONL history file.
 * Adds necessary metadata fields to ensure compatibility with the history reader.
 */
export function persistJsonlMessage(sessionId, cwd, obj) {
  try {
    const sessionFile = getClaudeProjectSessionFilePath(sessionId, cwd);
    const projectHistoryDir = dirname(sessionFile);
    mkdirSync(projectHistoryDir, { recursive: true });

    // Add necessary metadata fields to ensure compatibility with ClaudeHistoryReader
    const enrichedObj = {
      ...obj,
      uuid: randomUUID(),
      sessionId: sessionId,
      timestamp: new Date().toISOString()
    };

    appendFileSync(sessionFile, JSON.stringify(enrichedObj) + '\n', 'utf8');
    console.log('[PERSIST] Message saved to:', sessionFile);
  } catch (e) {
    console.error('[PERSIST_ERROR]', e.message);
  }
}

/**
 * Parse raw JSONL file content into entries, skipping blank and malformed
 * lines. Shared by every reader that consumes a session transcript.
 */
function parseJsonlContent(content) {
  return content
    .split('\n')
    .filter(line => line.trim())
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(msg => msg !== null);
}

/**
 * Load session history messages (used to maintain context when resuming a session).
 * Returns an array of messages in the Anthropic Messages API format.
 */
export function loadSessionHistory(sessionId, cwd) {
  try {
    const sessionFile = getClaudeProjectSessionFilePath(sessionId, cwd);

    if (!existsSync(sessionFile)) {
      return [];
    }

    // Rewind keeps dead branches on disk; only the parentUuid chain from the
    // newest leaf is the live conversation the API should see.
    // Keep the model context compact: the UI reader intentionally restores the
    // pre-compact transcript, but the API must rely on Claude's summary instead.
    const messages = selectConversationChain(
      parseJsonlContent(readFileSync(sessionFile, 'utf8')),
      { includePreCompactHistory: false }
    )
      .filter(msg =>
        (msg.type === 'user' || msg.type === 'assistant') &&
        msg.message && msg.message.content)
      .map(msg => ({
        role: msg.type,
        content: msg.message.content
      }));

    // Exclude the last user message (since we already persisted the current user message before calling this function)
    if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
      messages.pop();
    }

    return messages;
  } catch (e) {
    console.error('[LOAD_HISTORY_ERROR]', e.message);
    return [];
  }
}

/**
 * Maximum number of messages to return when loading a session's history.
 * Long sessions (500+ messages) consume excessive memory in the Java plugin
 * (each message is parsed into a JVM object, serialized to JSON for JCEF,
 * and held in React state). The frontend already collapses older turns for
 * rendering, so there is no need to hydrate the full transcript into memory.
 *
 * The limit is generous enough to cover the visible window plus several
 * pages of scroll-back, while keeping memory usage bounded. (#610)
 *
 * Default: 0 = unlimited (no truncation). Set CCGUI_MAX_HISTORY_MESSAGES
 * to a positive integer to enable the cap. This opt-in approach avoids
 * breaking the "load earlier" UX until a proper Claude-side pagination
 * protocol (similar to load_codex_history_page) is implemented.
 */
function getMaxHistoryMessages() {
  return parseInt(process.env.CCGUI_MAX_HISTORY_MESSAGES || '0', 10);
}

/**
 * Build the getSessionMessages response payload by reading a JSONL session
 * file. Exported (not just inlined) so the parse + carrier-rewrite logic is
 * unit-testable without going through process.stdout: the test only needs a
 * temp file, not an stdout spy. Returns { success, messages } - empty messages
 * when the file is missing.
 *
 * For long sessions, only the most recent MAX_HISTORY_MESSAGES messages are
 * returned. This prevents the Java plugin from parsing and holding hundreds
 * of message objects in memory when the frontend only renders a subset.
 * In a typical alternating user/assistant conversation the tail window always
 * contains assistant messages, so token-usage restore is unaffected.
 */
export function buildSessionMessagesPayload(sessionFile) {
  if (!existsSync(sessionFile)) {
    return { success: true, messages: [] };
  }
  const content = readFileSync(sessionFile, 'utf8');
  let messages = selectConversationChain(parseJsonlContent(content))
    // Drop the CLI's synthetic "[Request interrupted by user]" user rows.
    // They are turn-abort bookkeeping the CLI persists into the transcript,
    // not real user input: rendered in the chat they read as a phantom
    // message, and their uuid makes getLatestUserMessage return them as the
    // "latest user message", starving the rewind uuid-sync for the user's
    // real last message. The live stream never carries them (the daemon
    // consumes them inter-turn), so dropping them here keeps reloaded
    // history consistent with the live view.
    .filter(msg => !(msg.type === 'user' && isInterruptionMarker(msg)))
    // A background Agent's terminal report can land as a queued_command
    // attachment (type:"attachment") rather than a user message. Java's
    // MessageParser only forwards user/assistant rows, so the attachment row
    // would be dropped on history reload and the subagent card would stay
    // stuck on the launch ack text. Re-shape it into a user message whose
    // content is the task-notification XML - the same shape the user-message
    // carrier already has - so MessageParser forwards it and the frontend's
    // collectTaskEventsFromMessages recovers the report. User-message and
    // non-task-notification attachments pass through unchanged.
    .flatMap(msg => {
      if (msg.type === 'attachment' && extractTaskNotificationXml(msg) !== null) {
        return [{
          type: 'user',
          message: { role: 'user', content: extractTaskNotificationXml(msg) },
        }];
      }
      return [msg];
    });

  // Trim to the most recent messages to bound memory usage on long sessions.
  // The frontend already paginates rendering (INITIAL_VISIBLE_TURNS), so
  // hydrating the full transcript serves no purpose and wastes memory.
  // NOTE: This is opt-in via CCGUI_MAX_HISTORY_MESSAGES. A proper pagination
  // protocol (load_claude_history_page, similar to Codex) is planned.
  if (getMaxHistoryMessages() > 0 && messages.length > getMaxHistoryMessages()) {
    messages = messages.slice(-getMaxHistoryMessages());
  }

  return { success: true, messages };
}

/**
 * Get session history messages.
 * Reads from the ~/.claude/projects/ directory.
 * Writes the result as a single NDJSON line to stdout.
 */
export async function getSessionMessages(sessionId, cwd = null) {
  try {
    const sessionFile = resolveSessionFile(sessionId, cwd);
    await writeJsonResponse(buildSessionMessagesPayload(sessionFile));
  } catch (error) {
    console.error('[GET_SESSION_ERROR]', error.message);
    await writeJsonResponse({
      success: false,
      error: error.message
    });
  }
}

export async function getLatestUserMessage(sessionId, cwd = null) {
  try {
    const sessionFile = resolveSessionFile(sessionId, cwd);

    if (!existsSync(sessionFile)) {
      await writeJsonResponse({
        success: true,
        message: null
      });
      return;
    }

    // Read only the tail of the file for performance on large sessions
    const TAIL_BYTES = 32 * 1024;
    const stat = statSync(sessionFile);
    const startByte = Math.max(0, stat.size - TAIL_BYTES);

    let latestUserMessage = null;
    const rl = createInterface({
      input: createReadStream(sessionFile, { encoding: 'utf8', start: startByte }),
      crlfDelay: Infinity
    });

    let firstLine = startByte > 0;
    for await (const line of rl) {
      // Skip potentially partial first line when reading from mid-file
      if (firstLine) { firstLine = false; continue; }
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (isUserTextMessage(message)) {
          latestUserMessage = message;
        }
      } catch {
        // Ignore malformed JSONL entries
      }
    }

    await writeJsonResponse({
      success: true,
      message: latestUserMessage
    });
  } catch (error) {
    console.error('[GET_LATEST_USER_ERROR]', error.message);
    await writeJsonResponse({
      success: false,
      error: error.message
    });
  }
}

export function isUserTextMessage(message) {
  return Boolean(
    message &&
    message.type === 'user' &&
    typeof message.uuid === 'string' &&
    !isInterruptionMarker(message) &&
    extractTextContent(message)?.trim()
  );
}

/**
 * Detect the CLI's synthetic user rows for an aborted turn, matching the
 * transcript markers it persists: "[Request interrupted by user]" (stream
 * abort) and "[Request interrupted by user for tool use]" (tool-use abort).
 * Mirrors the filter Java's SessionLiteReader already applies.
 */
export function isInterruptionMarker(message) {
  if (!message || message.type !== 'user') {
    return false;
  }
  const text = extractTextContent(message);
  return typeof text === 'string' && text.startsWith('[Request interrupted');
}

function extractTextContent(message) {
  const content = message?.message?.content;
  if (!content) {
    return '';
  }

  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function resolveSessionFile(sessionId, cwd = null) {
  if (!sessionId || /[\/\\]/.test(sessionId)) {
    throw new Error('Invalid session ID');
  }
  return getClaudeProjectSessionFilePath(sessionId, cwd);
}
