import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ClaudeMessage } from '../types';
import {
  AUTO_RESUME_ON_LIMIT_EVENT,
  getAutoResumeOnLimit,
} from '../utils/autoResumeOnLimit';
import {
  parseStandaloneUsageLimitNotice,
  parseUsageLimitError,
  type UsageLimitInfo,
} from '../utils/usageLimitError';

/** Grace period added after the reported reset time before resuming. */
const RESET_BUFFER_MS = 60_000;
/** Retry delay when the limit error carried no parsable reset time. */
const FALLBACK_DELAY_MS = 15 * 60_000;
/** Minimum scheduling delay (also applies when the reset time is already past). */
const MIN_DELAY_MS = 5_000;
/**
 * Only errors younger than this are auto-resumed. Live limit errors are
 * observed the moment they arrive (age ≈ 0); anything older is a stale error
 * re-surfaced by a history load or webview reload, and silently self-resuming
 * a session the user just opened would be surprising.
 */
const FRESH_ERROR_WINDOW_MS = 10 * 60_000;
/** Consecutive automatic attempts before giving up on the current limit error. */
export const MAX_AUTO_RESUME_ATTEMPTS = 5;

export interface AutoResumePending {
  /** Epoch ms when the automatic "continue" will be sent. */
  fireAtMs: number;
  /** 1-based number of the attempt that will fire. */
  attempt: number;
}

export interface UseAutoResumeOnLimitOptions {
  /** The persisted toggle (see useAutoResumeEnabled). */
  enabled: boolean;
  currentProvider: string;
  loading: boolean;
  messages: ClaudeMessage[];
  currentSessionId: string | null;
  getMessageText: (message: ClaudeMessage) => string;
  /** Sends the automatic "continue" message (wired to executeMessage). */
  onResume: () => void;
  /** Called once per limit error when the attempt cap is reached. */
  onExhausted?: (attempts: number) => void;
}

export interface UseAutoResumeOnLimitReturn {
  /** Non-null while an automatic resume is scheduled. Drives the countdown bar. */
  pending: AutoResumePending | null;
  /** User-initiated cancel: clears the schedule for the current limit error. */
  cancel: () => void;
}

function subscribeToSetting(onChange: () => void): () => void {
  window.addEventListener(AUTO_RESUME_ON_LIMIT_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(AUTO_RESUME_ON_LIMIT_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** Live view of the persisted auto-resume toggle (same-tab and cross-tab writes). */
export function useAutoResumeEnabled(): boolean {
  return useSyncExternalStore(subscribeToSetting, getAutoResumeOnLimit);
}

/**
 * Age of a message in ms, or null when it has no parsable timestamp.
 *
 * Prefers `raw.timestamp` (the original transcript time, forwarded by the
 * Java transport) over `message.timestamp`: session reloads re-parse the
 * JSONL and stamp Message.timestamp with the PARSE time, which would make an
 * hours-old limit notice look fresh after any background refresh. Falls back
 * to message.timestamp (live messages carry epoch-ms numbers; optimistic and
 * history messages may carry ISO strings).
 */
function messageAgeMs(message: ClaudeMessage, nowMs: number): number | null {
  const raw = message.raw;
  const rawTs = raw && typeof raw === 'object'
    ? (raw as { timestamp?: string | number }).timestamp
    : undefined;
  for (const ts of [rawTs, message.timestamp as string | number | undefined]) {
    if (ts === undefined || ts === null) continue;
    const parsed = typeof ts === 'number' ? ts : Date.parse(ts);
    if (Number.isFinite(parsed)) return nowMs - parsed;
  }
  return null;
}

/** Stable identity for a notice message across reload-refreshed timestamps. */
function noticeSignature(message: ClaudeMessage, index: number): string {
  const raw = message.raw;
  const rawTs = raw && typeof raw === 'object'
    ? (raw as { timestamp?: string | number }).timestamp
    : undefined;
  return `${index}|${rawTs ?? message.timestamp ?? ''}`;
}

/**
 * Records that ride the transcript tail without being conversation content:
 * background-task bookkeeping (queue-operation/attachment) and
 * task-notification user records. A limit notice is frequently followed by a
 * burst of these (each finished workflow child appends one), so the detector
 * must look through them instead of only at the literal last message.
 */
function isTransparentTailRecord(message: ClaudeMessage): boolean {
  const raw = message.raw;
  const rawType = raw && typeof raw === 'object'
    ? (raw as { type?: string }).type
    : undefined;
  if (rawType === 'queue-operation' || rawType === 'attachment') return true;
  if (message.type === 'user' || message.type === 'task_notification' || message.type === 'notification') {
    const text = typeof message.content === 'string' ? message.content : '';
    if (text.includes('<task-notification>')) return true;
  }
  return false;
}

interface TrailingLimitNotice {
  message: ClaudeMessage;
  info: UsageLimitInfo;
  index: number;
}

const MAX_TAIL_SCAN = 10;

/**
 * Finds the usage-limit notice governing the transcript tail, if any.
 *
 * Two shapes exist:
 *  - error-type messages (GUI-owned turn failed via [SEND_ERROR]) — substring
 *    match, the error path is unambiguous;
 *  - CLI-synthesized ASSISTANT notices (background/workflow turns; model
 *    "<synthetic>") — anchored standalone match only, so ordinary replies
 *    quoting the notice never trigger.
 *
 * The first substantive (non-transparent) message decides: if it is not a
 * limit notice, there is nothing to resume.
 */
function findTrailingLimitNotice(
  messages: ClaudeMessage[],
  getMessageText: (message: ClaudeMessage) => string,
  nowMs: number,
): TrailingLimitNotice | null {
  for (let i = messages.length - 1, steps = 0; i >= 0 && steps < MAX_TAIL_SCAN; i--, steps++) {
    const message = messages[i];
    if (isTransparentTailRecord(message)) continue;
    if (message.type === 'error') {
      const info = parseUsageLimitError(getMessageText(message), nowMs);
      return info ? { message, info, index: i } : null;
    }
    if (message.type === 'assistant') {
      const info = parseStandaloneUsageLimitNotice(getMessageText(message), nowMs);
      return info ? { message, info, index: i } : null;
    }
    return null;
  }
  return null;
}

/**
 * Watches the conversation for a Claude usage-limit error and, when the
 * feature is enabled, schedules an automatic "continue" for just after the
 * limit resets. The send goes through the normal message path, so the resumed
 * turn continues the current session via the existing resume plumbing and the
 * automatic "continue" is visible in the transcript like any user message.
 *
 * The schedule is cancelled when the user sends something themselves (loading
 * flips true), turns the toggle off, switches sessions, or presses Cancel on
 * the countdown bar. If the resumed turn hits the limit again, the next error
 * is rescheduled — up to MAX_AUTO_RESUME_ATTEMPTS consecutive attempts.
 *
 * Flipping the toggle ON while a limit notice trails the conversation arms a
 * resume right away, regardless of the notice's age: the explicit click is the
 * consent the freshness gate otherwise protects. A reset time already in the
 * past fires after the minimum delay instead of waiting a day.
 */
export function useAutoResumeOnLimit({
  enabled,
  currentProvider,
  loading,
  messages,
  currentSessionId,
  getMessageText,
  onResume,
  onExhausted,
}: UseAutoResumeOnLimitOptions): UseAutoResumeOnLimitReturn {
  const [pending, setPending] = useState<AutoResumePending | null>(null);

  const timerRef = useRef<number | null>(null);
  const fireAtRef = useRef<number | null>(null);
  /** Consecutive automatic attempts already fired for the current limit episode. */
  const attemptsRef = useRef(0);
  /** Signature of the error message a timer is currently scheduled for. */
  const scheduledSigRef = useRef<string | null>(null);
  /** Signature the user explicitly cancelled — never reschedule it. */
  const cancelledSigRef = useRef<string | null>(null);
  /** Signature onExhausted was already reported for. */
  const exhaustedSigRef = useRef<string | null>(null);
  /**
   * `enabled` as seen by the previous scheduling pass. A false→true flip while
   * mounted is an explicit user action (the header toggle), not a passive
   * state load — see the effect below for what that unlocks.
   */
  const prevEnabledRef = useRef(enabled);

  // Latest-value mirrors so the timer callback never acts on stale props.
  const enabledRef = useRef(enabled);
  const loadingRef = useRef(loading);
  const onResumeRef = useRef(onResume);
  const onExhaustedRef = useRef(onExhausted);
  enabledRef.current = enabled;
  loadingRef.current = loading;
  onResumeRef.current = onResume;
  onExhaustedRef.current = onExhausted;

  const clearSchedule = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    fireAtRef.current = null;
    setPending(null);
  }, []);

  // Self-referencing via ref so the "fired too early, re-arm" path can
  // reschedule itself without a useCallback dependency cycle.
  const fireRef = useRef<() => void>(() => {});
  fireRef.current = () => {
    timerRef.current = null;
    const fireAt = fireAtRef.current;
    if (fireAt === null) return;

    // Guard against early wake-ups (system sleep, clock adjustments).
    const remaining = fireAt - Date.now();
    if (remaining > 1000) {
      timerRef.current = window.setTimeout(() => fireRef.current(), remaining);
      return;
    }

    fireAtRef.current = null;
    setPending(null);
    if (!enabledRef.current || loadingRef.current) return;
    attemptsRef.current += 1;
    onResumeRef.current();
  };

  // Switching (or resetting) the session ends the current limit episode.
  useEffect(() => {
    attemptsRef.current = 0;
    cancelledSigRef.current = null;
    exhaustedSigRef.current = null;
    scheduledSigRef.current = null;
    clearSchedule();
  }, [currentSessionId, clearSchedule]);

  useEffect(() => {
    // An explicit toggle-on (false→true while mounted) is a direct "resume this
    // session" request: it may arm from a trailing notice of ANY age, forgets a
    // prior Cancel, and grants a fresh attempt budget. Passive arming (a fresh
    // notice arriving, a webview reload with the toggle already on) keeps the
    // freshness gate below, so an old session never silently self-resumes.
    const explicitArm = enabled && !prevEnabledRef.current;
    prevEnabledRef.current = enabled;
    if (explicitArm) {
      cancelledSigRef.current = null;
      exhaustedSigRef.current = null;
      attemptsRef.current = 0;
    }

    const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
    const now = Date.now();
    const notice = enabled && currentProvider === 'claude' && !loading
      ? findTrailingLimitNotice(messages, getMessageText, now)
      : null;

    if (!notice) {
      // A completed assistant turn (that is not itself a limit notice) means
      // the limit is behind us. (Checking specifically for 'assistant' avoids
      // resetting on the transient state where our own optimistic "continue"
      // is last while the turn runs.)
      if (!loading && last?.type === 'assistant') {
        attemptsRef.current = 0;
      }
      clearSchedule();
      return;
    }

    // Stale notices (history load, webview reload) must not self-resume —
    // except when the user just flipped the toggle on, which IS the consent.
    const age = messageAgeMs(notice.message, now);
    if (!explicitArm && (age === null || age > FRESH_ERROR_WINDOW_MS)) {
      clearSchedule();
      return;
    }

    const info = notice.info;
    const sig = noticeSignature(notice.message, notice.index);
    if (cancelledSigRef.current === sig) return;
    if (scheduledSigRef.current === sig && timerRef.current !== null) return;

    if (attemptsRef.current >= MAX_AUTO_RESUME_ATTEMPTS) {
      if (exhaustedSigRef.current !== sig) {
        exhaustedSigRef.current = sig;
        onExhaustedRef.current?.(attemptsRef.current);
      }
      return;
    }

    const fireAtMs = info.resetAtMs !== null
      ? Math.max(info.resetAtMs + RESET_BUFFER_MS, now + MIN_DELAY_MS)
      : now + FALLBACK_DELAY_MS;

    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
    }
    scheduledSigRef.current = sig;
    fireAtRef.current = fireAtMs;
    setPending({ fireAtMs, attempt: attemptsRef.current + 1 });
    timerRef.current = window.setTimeout(() => fireRef.current(), fireAtMs - now);
  }, [enabled, currentProvider, loading, messages, getMessageText, clearSchedule]);

  // Drop any live timer on unmount.
  useEffect(() => clearSchedule, [clearSchedule]);

  const cancel = useCallback(() => {
    cancelledSigRef.current = scheduledSigRef.current;
    clearSchedule();
  }, [clearSchedule]);

  return { pending, cancel };
}
