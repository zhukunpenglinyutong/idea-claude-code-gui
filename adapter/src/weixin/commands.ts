import type { PendingInteraction } from './interactions.js';

export type UserCommand =
  | { readonly type: 'stop' }
  | { readonly type: 'permission'; readonly decision: 'ALLOW' | 'ALLOW_ALWAYS' | 'DENY' }
  | { readonly type: 'plan'; readonly approved: boolean }
  | { readonly type: 'question'; readonly text: string }
  | { readonly type: 'chat'; readonly text: string };

const STOP_WORDS = new Set(['stop', '停止', '停', 'abort', '终止']);

const ALLOW_WORDS = new Set(['allow', '允许', '同意', '好的', 'ok']);
const ALLOW_ALWAYS_WORDS = new Set(['allow_always', 'always', '始终允许']);
const DENY_WORDS = new Set(['deny', '拒绝', '取消', 'no']);
const PLAN_APPROVE_WORDS = new Set(['同意', '批准', 'yes', 'approve', '好']);
const PLAN_REJECT_WORDS = new Set(['拒绝', '取消', 'no', 'reject', '不同意']);

/**
 * Parses a WeChat text into an adapter command.
 *
 * Interaction replies only apply when a matching pending interaction exists;
 * otherwise the text is treated as a normal chat message. Stop is exact-match
 * only, so "停止" in the middle of a sentence never aborts a turn.
 */
export function parseUserCommand(text: string, pending?: PendingInteraction): UserCommand {
  const trimmed = text.trim();
  const normalized = trimmed.toLowerCase();
  if (STOP_WORDS.has(normalized)) {
    return { type: 'stop' };
  }
  if (pending?.kind === 'permission') {
    if (ALLOW_WORDS.has(normalized)) {
      return { type: 'permission', decision: 'ALLOW' };
    }
    if (ALLOW_ALWAYS_WORDS.has(normalized)) {
      return { type: 'permission', decision: 'ALLOW_ALWAYS' };
    }
    if (DENY_WORDS.has(normalized)) {
      return { type: 'permission', decision: 'DENY' };
    }
    return { type: 'chat', text: trimmed };
  }
  if (pending?.kind === 'plan') {
    if (PLAN_APPROVE_WORDS.has(normalized)) {
      return { type: 'plan', approved: true };
    }
    if (PLAN_REJECT_WORDS.has(normalized)) {
      return { type: 'plan', approved: false };
    }
    return { type: 'chat', text: trimmed };
  }
  if (pending?.kind === 'question') {
    return { type: 'question', text: trimmed };
  }
  return { type: 'chat', text: trimmed };
}

/**
 * True when the text is one of the exact command words used for
 * permission/plan/stop replies. Used to reject stale replies after a rebind.
 */
export function looksLikeCommandReply(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    STOP_WORDS.has(normalized) ||
    ALLOW_WORDS.has(normalized) ||
    ALLOW_ALWAYS_WORDS.has(normalized) ||
    DENY_WORDS.has(normalized) ||
    PLAN_APPROVE_WORDS.has(normalized) ||
    PLAN_REJECT_WORDS.has(normalized)
  );
}
