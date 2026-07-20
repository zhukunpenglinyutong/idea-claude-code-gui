import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeMessage } from '../types';
import {
  MAX_AUTO_RESUME_ATTEMPTS,
  useAutoResumeOnLimit,
  type UseAutoResumeOnLimitOptions,
} from './useAutoResumeOnLimit';

const getMessageText = (m: ClaudeMessage) => (typeof m.content === 'string' ? m.content : '');

function limitError(resetInMs: number, ageMs = 0): ClaudeMessage {
  const resetSec = Math.floor((Date.now() + resetInMs) / 1000);
  return {
    type: 'error',
    content: `Claude AI usage limit reached|${resetSec}`,
    timestamp: Date.now() - ageMs,
  } as unknown as ClaudeMessage;
}

/**
 * CLI-synthesized assistant notice, as produced by background/workflow turns
 * that exhaust the limit (model "<synthetic>", plain text content, never an
 * error-type message). Mirrors a real transcript record.
 */
function syntheticLimitNotice(ageMs = 0, rawAgeMs: number | null = null): ClaudeMessage {
  const now = Date.now();
  return {
    type: 'assistant',
    content: "You've hit your session limit · resets 3:10pm (Europe/Warsaw)",
    timestamp: now - ageMs,
    raw: {
      type: 'assistant',
      ...(rawAgeMs !== null ? { timestamp: new Date(now - rawAgeMs).toISOString() } : {}),
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: "You've hit your session limit · resets 3:10pm (Europe/Warsaw)" }],
      },
    },
  } as unknown as ClaudeMessage;
}

function taskNotificationRecord(): ClaudeMessage {
  return {
    type: 'user',
    content: '<task-notification>\n<task-id>w49e3jjl6</task-id>\n<status>failed</status>\n</task-notification>',
    timestamp: Date.now(),
    raw: { type: 'user' },
  } as unknown as ClaudeMessage;
}

function queueOperationRecord(): ClaudeMessage {
  return {
    type: 'user',
    content: '',
    timestamp: Date.now(),
    raw: { type: 'queue-operation' },
  } as unknown as ClaudeMessage;
}

function baseOptions(overrides: Partial<UseAutoResumeOnLimitOptions> = {}): UseAutoResumeOnLimitOptions {
  return {
    enabled: true,
    currentProvider: 'claude',
    loading: false,
    messages: [],
    currentSessionId: 'session-1',
    getMessageText,
    onResume: vi.fn(),
    ...overrides,
  };
}

describe('useAutoResumeOnLimit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 16, 10, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules nothing when disabled', () => {
    const options = baseOptions({ enabled: false, messages: [limitError(60_000)] });
    const { result } = renderHook(() => useAutoResumeOnLimit(options));
    expect(result.current.pending).toBeNull();
  });

  it('schedules nothing for non-claude providers', () => {
    const options = baseOptions({ currentProvider: 'codex', messages: [limitError(60_000)] });
    const { result } = renderHook(() => useAutoResumeOnLimit(options));
    expect(result.current.pending).toBeNull();
  });

  it('schedules nothing for non-limit errors', () => {
    const options = baseOptions({
      messages: [{ type: 'error', content: 'fetch failed', timestamp: Date.now() } as unknown as ClaudeMessage],
    });
    const { result } = renderHook(() => useAutoResumeOnLimit(options));
    expect(result.current.pending).toBeNull();
  });

  it('schedules a resume after the reset time and fires onResume', () => {
    const onResume = vi.fn();
    const options = baseOptions({ messages: [limitError(30 * 60_000)], onResume });
    const { result } = renderHook(() => useAutoResumeOnLimit(options));

    expect(result.current.pending).not.toBeNull();
    expect(result.current.pending?.attempt).toBe(1);
    // Fires at reset + 60s buffer.
    expect(result.current.pending!.fireAtMs).toBeGreaterThan(Date.now() + 30 * 60_000);

    act(() => {
      vi.advanceTimersByTime(31 * 60_000 + 1000);
    });
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBeNull();
  });

  it('uses the fallback delay when the error carries no reset time', () => {
    const onResume = vi.fn();
    const options = baseOptions({
      messages: [{
        type: 'error',
        content: "You've reached your usage limit.",
        timestamp: Date.now(),
      } as unknown as ClaudeMessage],
      onResume,
    });
    const { result } = renderHook(() => useAutoResumeOnLimit(options));
    expect(result.current.pending).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(15 * 60_000 + 1000);
    });
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('does not schedule for stale errors (history load)', () => {
    const options = baseOptions({ messages: [limitError(60 * 60_000, /* ageMs */ 60 * 60_000)] });
    const { result } = renderHook(() => useAutoResumeOnLimit(options));
    expect(result.current.pending).toBeNull();
  });

  it('cancel() clears the schedule and does not reschedule the same error', () => {
    const onResume = vi.fn();
    const options = baseOptions({ messages: [limitError(60_000)], onResume });
    const { result, rerender } = renderHook(
      (props: UseAutoResumeOnLimitOptions) => useAutoResumeOnLimit(props),
      { initialProps: options },
    );
    expect(result.current.pending).not.toBeNull();

    act(() => result.current.cancel());
    expect(result.current.pending).toBeNull();

    // Re-render with identical messages: must stay cancelled.
    rerender({ ...options });
    expect(result.current.pending).toBeNull();

    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(onResume).not.toHaveBeenCalled();
  });

  it('clears the schedule when the user sends a message (loading flips true)', () => {
    const onResume = vi.fn();
    const options = baseOptions({ messages: [limitError(60_000)], onResume });
    const { result, rerender } = renderHook(
      (props: UseAutoResumeOnLimitOptions) => useAutoResumeOnLimit(props),
      { initialProps: options },
    );
    expect(result.current.pending).not.toBeNull();

    rerender({ ...options, loading: true });
    expect(result.current.pending).toBeNull();

    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(onResume).not.toHaveBeenCalled();
  });

  it('clears the schedule when the toggle is turned off', () => {
    const options = baseOptions({ messages: [limitError(60_000)] });
    const { result, rerender } = renderHook(
      (props: UseAutoResumeOnLimitOptions) => useAutoResumeOnLimit(props),
      { initialProps: options },
    );
    expect(result.current.pending).not.toBeNull();

    rerender({ ...options, enabled: false });
    expect(result.current.pending).toBeNull();
  });

  it('clears the schedule when the session changes', () => {
    const options = baseOptions({ messages: [limitError(60_000)] });
    const { result, rerender } = renderHook(
      (props: UseAutoResumeOnLimitOptions) => useAutoResumeOnLimit(props),
      { initialProps: options },
    );
    expect(result.current.pending).not.toBeNull();

    rerender({ ...options, currentSessionId: 'session-2', messages: [] });
    expect(result.current.pending).toBeNull();
  });

  it('stops after MAX_AUTO_RESUME_ATTEMPTS consecutive failures and reports exhaustion', () => {
    const onResume = vi.fn();
    const onExhausted = vi.fn();
    let messages = [limitError(10_000)];
    const options = baseOptions({ messages, onResume, onExhausted });
    const { result, rerender } = renderHook(
      (props: UseAutoResumeOnLimitOptions) => useAutoResumeOnLimit(props),
      { initialProps: options },
    );

    for (let i = 0; i < MAX_AUTO_RESUME_ATTEMPTS; i++) {
      expect(result.current.pending).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(2 * 60_000);
      });
      // Each attempt fails with a fresh limit error appended to the transcript.
      messages = [
        ...messages,
        { type: 'user', content: 'continue', timestamp: Date.now() } as unknown as ClaudeMessage,
        limitError(10_000),
      ];
      rerender({ ...options, messages });
    }

    expect(onResume).toHaveBeenCalledTimes(MAX_AUTO_RESUME_ATTEMPTS);
    expect(result.current.pending).toBeNull();
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted).toHaveBeenCalledWith(MAX_AUTO_RESUME_ATTEMPTS);
  });

  // ── Assistant-variant notices (background/workflow turns) ────────────────

  it('schedules for a synthetic assistant limit notice', () => {
    // NOW is 10:00, notice resets 3:10pm → fires at 15:11 local.
    const options = baseOptions({ messages: [syntheticLimitNotice()] });
    const { result } = renderHook(() => useAutoResumeOnLimit(options));
    expect(result.current.pending).not.toBeNull();
    expect(result.current.pending!.fireAtMs).toBe(new Date(2026, 6, 16, 15, 11, 0).getTime());
  });

  it('finds the notice behind trailing task-notification/queue records', () => {
    const options = baseOptions({
      messages: [
        syntheticLimitNotice(),
        queueOperationRecord(),
        taskNotificationRecord(),
      ],
    });
    const { result } = renderHook(() => useAutoResumeOnLimit(options));
    expect(result.current.pending).not.toBeNull();
  });

  it('does not schedule for assistant prose that merely mentions the limit', () => {
    const options = baseOptions({
      messages: [{
        type: 'assistant',
        content: "When the limit trips the CLI prints You've hit your session limit · resets 3:10pm.\nWe handle that case now.",
        timestamp: Date.now(),
      } as unknown as ClaudeMessage],
    });
    const { result } = renderHook(() => useAutoResumeOnLimit(options));
    expect(result.current.pending).toBeNull();
  });

  it('does not schedule when a normal assistant reply follows the notice', () => {
    const options = baseOptions({
      messages: [
        syntheticLimitNotice(),
        { type: 'assistant', content: 'All done, limit reset in the meantime.', timestamp: Date.now() } as unknown as ClaudeMessage,
      ],
    });
    const { result } = renderHook(() => useAutoResumeOnLimit(options));
    expect(result.current.pending).toBeNull();
  });

  it('treats a stale raw.timestamp as stale even when the parse-time timestamp is fresh', () => {
    // Session reloads re-parse JSONL and stamp Message.timestamp with the
    // parse time — only raw.timestamp carries the original transcript time.
    const options = baseOptions({
      messages: [syntheticLimitNotice(/* ageMs */ 0, /* rawAgeMs */ 60 * 60_000)],
    });
    const { result } = renderHook(() => useAutoResumeOnLimit(options));
    expect(result.current.pending).toBeNull();
  });

  it('resets the attempt counter after a successful assistant turn', () => {
    const onResume = vi.fn();
    let messages = [limitError(10_000)];
    const options = baseOptions({ messages, onResume });
    const { result, rerender } = renderHook(
      (props: UseAutoResumeOnLimitOptions) => useAutoResumeOnLimit(props),
      { initialProps: options },
    );

    act(() => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(onResume).toHaveBeenCalledTimes(1);

    // The resumed turn succeeds.
    messages = [
      ...messages,
      { type: 'user', content: 'continue', timestamp: Date.now() } as unknown as ClaudeMessage,
      { type: 'assistant', content: 'done', timestamp: Date.now() } as unknown as ClaudeMessage,
    ];
    rerender({ ...options, messages });

    // A later limit error starts a fresh episode at attempt 1.
    messages = [...messages, limitError(10_000)];
    rerender({ ...options, messages });
    expect(result.current.pending?.attempt).toBe(1);
  });

  // ── Explicit toggle-on arming ─────────────────────────────────────────────

  it('arms on an explicit toggle-on even when the trailing notice is stale', () => {
    const onResume = vi.fn();
    // The state after the user comes back long after the limit hit: the notice
    // is an hour old and its reset time already passed. Passive paths must not
    // arm this — but flipping the toggle ON is explicit consent.
    const options = baseOptions({
      enabled: false,
      messages: [limitError(/* resetInMs */ -50 * 60_000, /* ageMs */ 60 * 60_000)],
      onResume,
    });
    const { result, rerender } = renderHook(
      (props: UseAutoResumeOnLimitOptions) => useAutoResumeOnLimit(props),
      { initialProps: options },
    );
    expect(result.current.pending).toBeNull();

    rerender({ ...options, enabled: true });
    expect(result.current.pending).not.toBeNull();

    // Reset time is in the past → fires after the minimum delay, not in a day.
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('explicit toggle-on overrides a prior cancel of the same notice', () => {
    const onResume = vi.fn();
    const options = baseOptions({ messages: [limitError(60_000)], onResume });
    const { result, rerender } = renderHook(
      (props: UseAutoResumeOnLimitOptions) => useAutoResumeOnLimit(props),
      { initialProps: options },
    );
    expect(result.current.pending).not.toBeNull();

    act(() => result.current.cancel());
    expect(result.current.pending).toBeNull();

    // Off/on cycle on the SAME notice: the explicit re-enable wins over the
    // remembered cancel.
    rerender({ ...options, enabled: false });
    rerender({ ...options, enabled: true });
    expect(result.current.pending).not.toBeNull();
  });

  it('explicit toggle-on grants a fresh attempt budget after exhaustion', () => {
    const onResume = vi.fn();
    const onExhausted = vi.fn();
    let messages = [limitError(10_000)];
    const options = baseOptions({ messages, onResume, onExhausted });
    const { result, rerender } = renderHook(
      (props: UseAutoResumeOnLimitOptions) => useAutoResumeOnLimit(props),
      { initialProps: options },
    );

    for (let i = 0; i < MAX_AUTO_RESUME_ATTEMPTS; i++) {
      act(() => {
        vi.advanceTimersByTime(2 * 60_000);
      });
      messages = [
        ...messages,
        { type: 'user', content: 'continue', timestamp: Date.now() } as unknown as ClaudeMessage,
        limitError(10_000),
      ];
      rerender({ ...options, messages });
    }
    expect(result.current.pending).toBeNull();
    expect(onExhausted).toHaveBeenCalledTimes(1);

    rerender({ ...options, messages, enabled: false });
    rerender({ ...options, messages, enabled: true });
    expect(result.current.pending).not.toBeNull();
    expect(result.current.pending?.attempt).toBe(1);
  });
});
