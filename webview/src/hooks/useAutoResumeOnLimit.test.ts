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
});
