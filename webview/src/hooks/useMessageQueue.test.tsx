import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMessageQueue } from './useMessageQueue.js';
import {
  MESSAGE_QUEUE_STREAM_COMPLETED_EVENT,
  MESSAGE_QUEUE_STREAM_STARTED_EVENT,
} from '../constants/messageQueueEvents.js';

function dispatchStreamStarted(turnId: number) {
  act(() => {
    window.dispatchEvent(new CustomEvent(MESSAGE_QUEUE_STREAM_STARTED_EVENT, {
      detail: { turnId },
    }));
  });
}

function dispatchStreamCompleted(
  completionId: string,
  turnId: number | null,
  sequence: number | null,
) {
  act(() => {
    window.dispatchEvent(new CustomEvent(MESSAGE_QUEUE_STREAM_COMPLETED_EVENT, {
      detail: { completionId, turnId, sequence },
    }));
  });
}

function createQueue(isLoading = true) {
  const onExecute = vi.fn();
  const onInterrupt = vi.fn();
  const hook = renderHook(({ loading }) => useMessageQueue({
    isLoading: loading,
    onExecute,
    onInterrupt,
  }), { initialProps: { loading: isLoading } });

  return { ...hook, onExecute, onInterrupt };
}

function enqueueMessages(result: ReturnType<typeof createQueue>['result'], ...contents: string[]) {
  act(() => {
    contents.forEach(content => result.current.enqueue(content));
  });
}

describe('useMessageQueue', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('updates only the message content and keeps metadata and position', () => {
    const { result } = createQueue();
    const attachments = [{ id: 'a1', fileName: 'a.txt', mediaType: 'text/plain', data: 'YQ==' }];

    act(() => {
      result.current.enqueue('first', attachments);
      result.current.enqueue('second');
    });
    const before = result.current.queue[0];

    act(() => result.current.update(before.id, 'updated'));

    expect(result.current.queue.map(item => item.content)).toEqual(['updated', 'second']);
    expect(result.current.queue[0]).toMatchObject({
      id: before.id,
      attachments,
      queuedAt: before.queuedAt,
    });
  });

  it('moves messages one position in logical execution order and ignores boundaries or unknown ids', () => {
    const { result } = createQueue();
    enqueueMessages(result, 'first', 'second', 'third');

    const [first, , third] = result.current.queue;
    act(() => result.current.moveUp(third.id));
    expect(result.current.queue.map(item => item.content)).toEqual(['first', 'third', 'second']);

    act(() => result.current.moveDown(first.id));
    expect(result.current.queue.map(item => item.content)).toEqual(['third', 'first', 'second']);

    const beforeBoundaryMove = result.current.queue;
    act(() => result.current.moveUp(third.id));
    expect(result.current.queue).toBe(beforeBoundaryMove);

    const beforeUnknownMove = result.current.queue;
    act(() => result.current.moveDown('unknown'));
    expect(result.current.queue).toBe(beforeUnknownMove);
  });

  it('moves messages to either queue boundary and treats insert as moveToFront', () => {
    const { result } = createQueue();
    enqueueMessages(result, 'first', 'second', 'third');
    const [, second, third] = result.current.queue;

    act(() => result.current.moveToFront(third.id));
    expect(result.current.queue.map(item => item.content)).toEqual(['third', 'first', 'second']);

    act(() => result.current.moveToBack(third.id));
    expect(result.current.queue.map(item => item.content)).toEqual(['first', 'second', 'third']);

    act(() => result.current.insert(second.id));
    expect(result.current.queue.map(item => item.content)).toEqual(['second', 'first', 'third']);

    const beforeBoundaryMove = result.current.queue;
    act(() => result.current.moveToFront(second.id));
    expect(result.current.queue).toBe(beforeBoundaryMove);

    const beforeUnknownMove = result.current.queue;
    act(() => result.current.moveToBack('unknown'));
    expect(result.current.queue).toBe(beforeUnknownMove);

  });

  it('keeps the original behavior and consumes one queue head when loading finishes', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute } = createQueue();
    enqueueMessages(result, 'first', 'second');

    rerender({ loading: false });
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('first', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['second']);

    act(() => {
      vi.runAllTimers();
    });
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it('waits for the interrupted turn end, ignores its duplicate, then consumes the remaining head only after the target ends', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute, onInterrupt } = createQueue();
    enqueueMessages(result, 'first', 'second');

    const targetId = result.current.queue[1].id;
    act(() => {
      result.current.interruptAndSendNow(targetId);
      result.current.interruptAndSendNow(targetId);
    });

    expect(result.current.queue.map(item => item.content)).toEqual(['second', 'first']);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onExecute).not.toHaveBeenCalled();

    rerender({ loading: false });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(onExecute).not.toHaveBeenCalled();

    dispatchStreamCompleted('sequence:10', 1, 10);
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('second', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);

    // 同一旧任务的完成信号再次到达，不能把 first 当作普通队首发送。
    dispatchStreamCompleted('sequence:10', 1, 10);
    dispatchStreamCompleted('sequence:11', null, 11);
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);

    dispatchStreamStarted(2);
    rerender({ loading: true });
    dispatchStreamCompleted('sequence:20', 2, 20);
    rerender({ loading: false });
    act(() => {
      vi.advanceTimersByTime(50);
    });

    expect(onExecute).toHaveBeenCalledTimes(2);
    expect(onExecute).toHaveBeenNthCalledWith(2, 'first', undefined);
    expect(result.current.queue).toEqual([]);
  });

  it('sends the interrupted target even if queue reordering has not committed yet', () => {
    vi.useFakeTimers();
    const { result, onExecute } = createQueue();
    enqueueMessages(result, 'first', 'second');
    const targetId = result.current.queue[1].id;

    act(() => result.current.interruptAndSendNow(targetId));
    // 模拟队列重排尚未提交时旧任务已经结束。
    dispatchStreamCompleted('sequence:30', 3, 30);
    act(() => vi.advanceTimersByTime(50));

    expect(onExecute).toHaveBeenCalledWith('second', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['first']);
  });

  it('does not react to loading=false before the interrupted turn really ends', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute } = createQueue();
    enqueueMessages(result, 'first', 'second');
    const targetId = result.current.queue[1].id;

    act(() => result.current.interruptAndSendNow(targetId));
    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));

    expect(onExecute).not.toHaveBeenCalled();
    expect(result.current.queue.map(item => item.content)).toEqual(['second', 'first']);
  });

  it('removes and executes a queued message immediately when idle', () => {
    const { result, onExecute, onInterrupt } = createQueue(false);
    enqueueMessages(result, 'first', 'second');

    act(() => result.current.interruptAndSendNow(result.current.queue[1].id));

    expect(result.current.queue.map(item => item.content)).toEqual(['first']);
    expect(onExecute).toHaveBeenCalledWith('second', undefined);
    expect(onInterrupt).not.toHaveBeenCalled();
  });

  it('preserves attachments when executing the interrupted target', () => {
    vi.useFakeTimers();
    const { result, onExecute } = createQueue();
    const attachments = [{ id: 'a1', fileName: 'a.txt', mediaType: 'text/plain', data: 'YQ==' }];

    act(() => {
      result.current.enqueue('first');
      result.current.enqueue('second', attachments);
    });

    act(() => result.current.interruptAndSendNow(result.current.queue[1].id));
    dispatchStreamCompleted('sequence:40', 4, 40);
    act(() => vi.advanceTimersByTime(50));

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('second', attachments);
  });

  it('keeps normal stop/completion scheduling on loading and ignores completion events while idle', () => {
    vi.useFakeTimers();
    const { result, rerender, onExecute } = createQueue();
    enqueueMessages(result, 'first', 'second');

    dispatchStreamCompleted('sequence:50', 5, 50);
    expect(onExecute).not.toHaveBeenCalled();

    rerender({ loading: false });
    act(() => vi.advanceTimersByTime(50));

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onExecute).toHaveBeenCalledWith('first', undefined);
    expect(result.current.queue.map(item => item.content)).toEqual(['second']);

    dispatchStreamCompleted('sequence:50', 5, 50);
    dispatchStreamCompleted('sequence:51', null, 51);
    act(() => vi.advanceTimersByTime(50));

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(result.current.queue.map(item => item.content)).toEqual(['second']);
  });
});
