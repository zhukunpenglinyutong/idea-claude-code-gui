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
 * Build the getSessionMessages response payload by reading a JSONL session
 * file. Exported (not just inlined) so the parse + carrier-rewrite logic is
 * unit-testable without going through process.stdout: the test only needs a
 * temp file, not an stdout spy. Returns { success, messages } - empty messages
 * when the file is missing.
 */
export function buildSessionMessagesPayload(sessionFile) {
  if (!existsSync(sessionFile)) {
    return { success: true, messages: [] };
  }
  const content = readFileSync(sessionFile, 'utf8');
  const messages = selectConversationChain(parseJsonlContent(content))
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
  if (!sessionId || /[\\/\\\\]/.test(sessionId)) {
    throw new Error('Invalid session ID');
  }
  return getClaudeProjectSessionFilePath(sessionId, cwd);
}

/**
 * A Claude "turn" is a contiguous block of messages starting with a user
 * message (the prompt) followed by any assistant/tool messages until the
 * next user message. Pagination is turn-based so a page boundary never
 * splits an assistant reply from its tool calls or a tool result from its
 * originating call.
 */
function isTurnStart(message) {
  return Boolean(
    message &&
    message.type === 'user' &&
    typeof message.uuid === 'string' &&
    !isInterruptionMarker(message)
  );
}

/**
 * Build a paginated getSessionMessages response.
 *
 * Returns the most recent `limit` turns when `beforeTurn` is omitted, or
 * the `limit` turns ending just before `beforeTurn` when provided. Turn
 * indices are 0-based over the *filtered* message list (interruption
 * markers removed).
 *
 * Response shape:
 *   { success, messages, fromTurn, toTurn, totalTurns, hasMore, cursorReset }
 *
 * cursorReset=true means the requested beforeTurn exceeds the current
 * history length (e.g. new messages arrived since the client computed its
 * cursor); the client should discard its cached history and reload from
 * scratch.
 *
 * On any unexpected error the caller falls back to buildSessionMessagesPayload
 * (full history) so the user never sees an empty chat.
 */
export function buildSessionMessagesPagePayload(sessionFile, beforeTurn = null, limit = 30) {
  if (!existsSync(sessionFile)) {
    return {
      success: true,
      messages: [],
      fromTurn: 0,
      toTurn: 0,
      totalTurns: 0,
      hasMore: false,
      cursorReset: false,
    };
  }

  const content = readFileSync(sessionFile, 'utf8');
  const messages = selectConversationChain(parseJsonlContent(content))
    .filter(msg => !(msg.type === 'user' && isInterruptionMarker(msg)))
    .flatMap(msg => {
      if (msg.type === 'attachment' && extractTaskNotificationXml(msg) !== null) {
        return [{
          type: 'user',
          message: { role: 'user', content: extractTaskNotificationXml(msg) },
        }];
      }
      return [msg];
    });

  // Group messages into turns. A turn starts at a user message and includes
  // all following assistant/tool messages until the next user message.
  const turns = [];
  let currentTurn = null;
  for (const msg of messages) {
    if (isTurnStart(msg)) {
      if (currentTurn !== null) {
        turns.push(currentTurn);
      }
      currentTurn = [msg];
    } else if (currentTurn !== null) {
      currentTurn.push(msg);
    } else {
      // Messages before the first user message (e.g. system records) form
      // their own implicit turn so they are not lost.
      currentTurn = [msg];
    }
  }
  if (currentTurn !== null) {
    turns.push(currentTurn);
  }

  const totalTurns = turns.length;

  // Validate cursor
  let effectiveBeforeTurn = beforeTurn;
  let cursorReset = false;
  if (effectiveBeforeTurn !== null && (effectiveBeforeTurn < 0 || effectiveBeforeTurn > totalTurns)) {
    cursorReset = true;
    effectiveBeforeTurn = null; // fall back to latest page
  }

  let fromTurn;
  let toTurn;
  if (effectiveBeforeTurn === null) {
    // Latest page
    toTurn = totalTurns;
    fromTurn = Math.max(0, toTurn - limit);
  } else {
    // Earlier page
    toTurn = effectiveBeforeTurn;
    fromTurn = Math.max(0, toTurn - limit);
  }

  const pageTurns = turns.slice(fromTurn, toTurn);
  const pageMessages = pageTurns.flat();

  return {
    success: true,
    messages: pageMessages,
    fromTurn,
    toTurn,
    totalTurns,
    hasMore: fromTurn > 0,
    cursorReset,
  };
}

/**
 * Get a paginated slice of session history messages.
 * Writes the result as a single NDJSON line to stdout.
 */
export async function getSessionMessagesPage(sessionId, cwd = null, beforeTurn = null, limit = 30) {
  try {
    const sessionFile = resolveSessionFile(sessionId, cwd);
    await writeJsonResponse(buildSessionMessagesPagePayload(sessionFile, beforeTurn, limit));
  } catch (error) {
    console.error('[GET_SESSION_PAGE_ERROR]', error.message);
    await writeJsonResponse({
      success: false,
      error: error.message
    });
  }
}
