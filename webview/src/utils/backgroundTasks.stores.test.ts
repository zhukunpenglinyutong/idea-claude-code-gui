// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  setBackgroundTaskUsage,
  setFinishedBackgroundTasks,
  useBackgroundTaskUsageMap,
  useFinishedBackgroundTasks,
} from './backgroundTasks';

/**
 * The finished-task and usage stores now own separate listener sets. That split
 * is a clarity refactor with no observable behavior change — both snapshots are
 * stable references, so a cross-notified subscriber re-read an unchanged value
 * and React bailed out of the render. (Verified: these tests pass either way, so
 * they deliberately do NOT assert render counts, which would only look like
 * coverage.) What is worth pinning is the snapshot stability the bail-out relies
 * on: if an equal update ever swapped the reference, every consumer would
 * re-render on every message that reparses the transcript.
 */
describe('background-task store snapshots', () => {
  beforeEach(() => {
    // Module-level state: reset so ordering between tests cannot leak.
    setFinishedBackgroundTasks(new Map());
    setBackgroundTaskUsage(new Map());
  });

  it('keeps the finished-task snapshot reference stable for an equal update', () => {
    const { result, unmount } = renderHook(() => useFinishedBackgroundTasks());
    act(() => setFinishedBackgroundTasks(new Map([['t3', 'completed']])));
    const first = result.current;
    expect(first.get('t3')).toBe('completed');

    act(() => setFinishedBackgroundTasks(new Map([['t3', 'completed']])));
    expect(result.current).toBe(first);

    // A real change must still publish a new snapshot.
    act(() => setFinishedBackgroundTasks(new Map([['t3', 'failed']])));
    expect(result.current).not.toBe(first);
    expect(result.current.get('t3')).toBe('failed');
    unmount();
  });

  it('keeps the usage snapshot reference stable for an equal update', () => {
    const { result, unmount } = renderHook(() => useBackgroundTaskUsageMap());
    act(() => setBackgroundTaskUsage(new Map([['t4', { totalTokens: 10, totalToolUseCount: 2 }]])));
    const first = result.current;
    expect(first.get('t4')).toEqual({ totalTokens: 10, totalToolUseCount: 2 });

    act(() => setBackgroundTaskUsage(new Map([['t4', { totalTokens: 10, totalToolUseCount: 2 }]])));
    expect(result.current).toBe(first);

    act(() => setBackgroundTaskUsage(new Map([['t4', { totalTokens: 99, totalToolUseCount: 2 }]])));
    expect(result.current).not.toBe(first);
    expect(result.current.get('t4')?.totalTokens).toBe(99);
    unmount();
  });

  it('publishes each store independently', () => {
    const finished = renderHook(() => useFinishedBackgroundTasks());
    const usage = renderHook(() => useBackgroundTaskUsageMap());

    act(() => setFinishedBackgroundTasks(new Map([['t5', 'completed']])));
    expect(finished.result.current.get('t5')).toBe('completed');
    expect(usage.result.current.size).toBe(0);

    act(() => setBackgroundTaskUsage(new Map([['t5', { totalTokens: 7 }]])));
    expect(usage.result.current.get('t5')).toEqual({ totalTokens: 7 });
    expect(finished.result.current.get('t5')).toBe('completed');

    finished.unmount();
    usage.unmount();
  });
});
