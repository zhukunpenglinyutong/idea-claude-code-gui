import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ClaudeMessage } from '../types';
import {
  AUTO_RESUME_ON_LIMIT_EVENT,
  getAutoResumeOnLimit,
} from '../utils/autoResumeOnLimit';
import { parseUsageLimitError } from '../utils/usageLimitError';

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
 * Live messages carry epoch-ms numbers (Java bridge); optimistic and
 * history messages may carry ISO strings.
 */
function messageAgeMs(message: ClaudeMessage, nowMs: number): number | null {
  const ts = message.timestamp as string | number | undefined;
  if (ts === undefined || ts === null) return null;
  const parsed = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(parsed)) return null;
  return nowMs - parsed;
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
    const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
    const isCandidate =
      enabled && currentProvider === 'claude' && !loading && last?.type === 'error';

    if (!isCandidate) {
      // A completed assistant turn means the limit is behind us. (Checking
      // specifically for 'assistant' avoids resetting on the transient state
      // where our own optimistic "continue" is last while the turn runs.)
      if (!loading && last?.type === 'assistant') {
        attemptsRef.current = 0;
      }
      clearSchedule();
      return;
    }

    const info = parseUsageLimitError(getMessageText(last!));
    if (!info) {
      clearSchedule();
      return;
    }

    // Stale errors (history load, webview reload) must not self-resume.
    const now = Date.now();
    const age = messageAgeMs(last!, now);
    if (age === null || age > FRESH_ERROR_WINDOW_MS) {
      clearSchedule();
      return;
    }

    const sig = `${messages.length}|${last!.timestamp ?? ''}`;
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
