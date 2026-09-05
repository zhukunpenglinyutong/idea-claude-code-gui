import type { ClaudeMessage } from '../types';

/**
 * Per-message structural fingerprint, cached by object identity.
 *
 * Streaming text/thinking deltas replace the tail assistant message object on
 * every rendered frame (~60fps while streaming). The O(conversation) derived
 * state in useChatComputations (subagents, todos, rewindables, session title)
 * depends only on tool structure — tool_use / tool_result blocks — never on
 * that text. This fingerprint captures exactly that structure, so a delta
 * frame yields the same fingerprint for every carried-over message and the
 * gated derivations can skip their scan entirely.
 *
 * The WeakMap cache makes the per-frame cost O(new objects) — typically just
 * the streaming tail — instead of O(conversation).
 */
const structureFingerprintCache = new WeakMap<object, string>();

export function getMessageStructureFingerprint(message: ClaudeMessage): string {
  const cached = structureFingerprintCache.get(message);
  if (cached !== undefined) {
    return cached;
  }

  let fingerprint = message.type;
  const raw = message.raw;
  if (raw && typeof raw === 'object') {
    const content = raw.content ?? raw.message?.content;
    if (Array.isArray(content)) {
      fingerprint += `:${content.length}`;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as Record<string, unknown>;
        if (b.type === 'tool_use') {
          fingerprint += `|u:${String(b.name ?? '')}:${String(b.id ?? '')}`;
        } else if (b.type === 'tool_result') {
          fingerprint += `|r:${String(b.tool_use_id ?? '')}:${b.is_error === true ? 'e' : 'o'}`;
        }
      }
    } else {
      fingerprint += ':s';
    }
  }

  structureFingerprintCache.set(message, fingerprint);
  return fingerprint;
}

/**
 * Returns a version number that only increments when the conversation's tool
 * structure changes. Text-only streaming frames keep the version stable, so
 * callers can gate expensive structure-only derivations on it.
 */
export function computeStructureVersion(
  messages: ClaudeMessage[],
  prevState: { fingerprints: string[]; version: number },
): { fingerprints: string[]; version: number } {
  const fingerprints = new Array<string>(messages.length);
  for (let i = 0; i < messages.length; i++) {
    fingerprints[i] = getMessageStructureFingerprint(messages[i]);
  }
  const prev = prevState;
  if (prev.fingerprints.length === fingerprints.length
      && fingerprints.every((f, i) => f === prev.fingerprints[i])) {
    return prev;
  }
  return { fingerprints, version: prev.version + 1 };
}
