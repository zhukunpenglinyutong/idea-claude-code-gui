import type { ClaudeMessage, ClaudeRawMessage } from '../types';
import { isToolResultOnlyUserMessage } from './turnScope';
import { hasTaskNotificationTag } from './contentBlockNormalize';

/**
 * Reconstructs the per-turn footer metadata (durationMs + raw.turnUsage) that is
 * only stamped live: durationMs is a frontend-only field written at stream end,
 * and turnUsage is stamped by the backend from the SDK result message. Neither
 * is persisted in transcripts, so after a session reload the "Total duration ·
 * tokens" footer vanished for every historical turn.
 *
 * This pure helper post-processes a full message snapshot: it groups
 * conversation turns (real user prompt → following assistant messages) and, for
 * the LAST assistant message of each settled turn, stamps
 * - durationMs: last assistant raw timestamp minus the prompt's raw timestamp
 * - raw.turnUsage: message.usage summed across the turn's assistant messages
 *   (deduped by message.id — one API response can span several transcript lines
 *   that share the same id and usage), in the exact shape extractTokenUsage
 *   (MessageItem.tsx) expects.
 *
 * Existing durationMs/turnUsage values are never overwritten, and missing
 * timestamps/usage are skipped silently (the current Java transport strips raw
 * timestamps and message.usage, so this lights up only when they are present).
 */

interface ReconstructedTurnUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

export interface ReconstructTurnMetadataOptions {
  /**
   * Leave the trailing (possibly still in-flight) turn untouched. Pass true
   * while streaming so the live stamping path stays the single writer for the
   * current turn.
   */
  skipTrailingTurn?: boolean;
}

function asRawObject(message: ClaudeMessage): ClaudeRawMessage | null {
  return message.raw && typeof message.raw === 'object' ? message.raw : null;
}

/** Parse the transcript timestamp off a message's raw JSONL line. */
function getRawTimestamp(message: ClaudeMessage): number | null {
  const raw = asRawObject(message);
  const ts = raw?.timestamp;
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  if (typeof ts === 'string' && ts) {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function extractRawTexts(message: ClaudeMessage): string[] {
  const raw = asRawObject(message);
  const texts: string[] = [];
  const collect = (content: unknown) => {
    if (typeof content === 'string') {
      texts.push(content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
          const text = (block as { text?: unknown }).text;
          if (typeof text === 'string') texts.push(text);
        }
      }
    }
  };
  collect(raw?.content);
  collect(raw?.message?.content);
  if (typeof message.content === 'string') texts.push(message.content);
  return texts;
}

/**
 * A turn starts at a REAL user prompt: not a tool_result carrier, not a meta
 * caveat, not a synthetic (non-human origin) message, not a task notification.
 */
function isRealUserPrompt(message: ClaudeMessage): boolean {
  if (message.type !== 'user') return false;
  if (isToolResultOnlyUserMessage(message)) return false;
  const raw = asRawObject(message);
  if (raw?.isMeta === true) return false;
  if (raw?.origin && typeof raw.origin === 'object' && raw.origin.kind !== 'human') return false;
  return !extractRawTexts(message).some(hasTaskNotificationTag);
}

function positiveNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Sum message.usage across the turn's assistant messages. Transcript lines that
 * belong to the same API response share message.id and carry identical usage,
 * so usage is counted once per unique id.
 */
function sumTurnUsage(assistantMessages: ClaudeMessage[]): ReconstructedTurnUsage | null {
  const usage: ReconstructedTurnUsage = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
  const seenIds = new Set<string>();
  let found = false;

  for (const message of assistantMessages) {
    const raw = asRawObject(message);
    const rawMessage = raw?.message as Record<string, unknown> | undefined;
    const callUsage = rawMessage?.usage as Record<string, unknown> | undefined;
    if (!callUsage || typeof callUsage !== 'object') continue;

    const id = typeof rawMessage?.id === 'string' ? rawMessage.id : null;
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }

    usage.input_tokens += positiveNumber(callUsage.input_tokens);
    usage.cache_creation_input_tokens += positiveNumber(callUsage.cache_creation_input_tokens);
    usage.cache_read_input_tokens += positiveNumber(callUsage.cache_read_input_tokens);
    usage.output_tokens += positiveNumber(callUsage.output_tokens);
    found = true;
  }

  if (!found) return null;
  const total = usage.input_tokens + usage.cache_creation_input_tokens
    + usage.cache_read_input_tokens + usage.output_tokens;
  return total > 0 ? usage : null;
}

export function reconstructTurnMetadata(
  messages: ClaudeMessage[],
  options: ReconstructTurnMetadataOptions = {},
): ClaudeMessage[] {
  if (messages.length === 0) return messages;

  const turnStarts: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    if (isRealUserPrompt(messages[i])) turnStarts.push(i);
  }
  if (turnStarts.length === 0) return messages;

  let result: ClaudeMessage[] | null = null;

  for (let turn = 0; turn < turnStarts.length; turn += 1) {
    const startIndex = turnStarts[turn];
    const endIndex = turn + 1 < turnStarts.length ? turnStarts[turn + 1] : messages.length;
    const isTrailingTurn = turn === turnStarts.length - 1;
    if (isTrailingTurn && options.skipTrailingTurn) continue;

    const assistantMessages: ClaudeMessage[] = [];
    let lastAssistantIndex = -1;
    for (let i = startIndex + 1; i < endIndex; i += 1) {
      if (messages[i].type === 'assistant') {
        assistantMessages.push(messages[i]);
        lastAssistantIndex = i;
      }
    }
    if (lastAssistantIndex < 0) continue;

    const lastAssistant = messages[lastAssistantIndex];
    let updated = lastAssistant;

    // Duration: last assistant raw timestamp minus prompt raw timestamp.
    if (typeof lastAssistant.durationMs !== 'number') {
      const promptTs = getRawTimestamp(messages[startIndex]);
      const assistantTs = getRawTimestamp(lastAssistant);
      if (promptTs != null && assistantTs != null && assistantTs >= promptTs) {
        updated = { ...updated, durationMs: assistantTs - promptTs };
      }
    }

    // Token usage: only when the raw is an object without an existing turnUsage.
    const raw = asRawObject(lastAssistant);
    if (raw && raw.turnUsage == null) {
      const turnUsage = sumTurnUsage(assistantMessages);
      if (turnUsage) {
        updated = { ...updated, raw: { ...raw, turnUsage } };
      }
    }

    if (updated !== lastAssistant) {
      if (!result) result = [...messages];
      result[lastAssistantIndex] = updated;
    }
  }

  return result ?? messages;
}
