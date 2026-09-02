import { useState, useCallback, useRef, useEffect } from 'react';
import type { Attachment } from '../components/ChatInputBox/types';
import {
  MESSAGE_QUEUE_STREAM_COMPLETED_EVENT,
  MESSAGE_QUEUE_STREAM_STARTED_EVENT,
  type MessageQueueStreamCompletedDetail,
  type MessageQueueStreamStartedDetail,
} from '../constants/messageQueueEvents';

export interface QueuedMessage {
  id: string;
  content: string;
  attachments?: Attachment[];
  queuedAt: number;
}

export interface UseMessageQueueOptions {
  /** Whether AI is currently processing */
  isLoading: boolean;
  /** Callback to execute a message */
  onExecute: (content: string, attachments?: Attachment[]) => void;
  /** 打断当前任务的回调 */
  onInterrupt?: () => void;
}

export interface UseMessageQueueReturn {
  /** Current queue */
  queue: QueuedMessage[];
  /** Add message to queue */
  enqueue: (content: string, attachments?: Attachment[]) => void;
  /** Remove message from queue by id */
  dequeue: (id: string) => void;
  /** Clear entire queue */
  clearQueue: () => void;
  /** Update the content of a queued message */
  update: (id: string, content: string) => void;
  /** Move a queued message one position earlier */
  moveUp: (id: string) => void;
  /** Move a queued message one position later */
  moveDown: (id: string) => void;
  /** Move a queued message to the next execution position */
  moveToFront: (id: string) => void;
  /** Move a queued message to the last execution position */
  moveToBack: (id: string) => void;
  /** Move a queued message to the next execution position without interruption */
  insert: (id: string) => void;
  /** 打断当前任务并优先调度指定消息 */
  interruptAndSendNow: (id: string) => void;
  /** Whether queue has items */
  hasQueuedMessages: boolean;
}

type QueueSchedulerState =
  | { phase: 'idle' }
  | {
      phase: 'waiting-for-interrupted-turn-end';
      generation: number;
      target: QueuedMessage;
    }
  | {
      phase: 'waiting-for-queued-turn-start';
      generation: number;
      itemId: string;
      releasedByCompletionId: string | null;
    }
  | {
      phase: 'waiting-for-queued-turn-end';
      generation: number;
      itemId: string;
      releasedByCompletionId: string | null;
      turnId: number;
    };

/**
 * Hook for managing message queue
 * 普通队列保持 loading 结束后自动消费；仅“打断并优先执行”使用严格流状态机。
 */
export function useMessageQueue({
  isLoading,
  onExecute,
  onInterrupt,
}: UseMessageQueueOptions): UseMessageQueueReturn {
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const onExecuteRef = useRef(onExecute);
  onExecuteRef.current = onExecute;
  const prevLoadingRef = useRef(isLoading);
  const isExecutingFromQueueRef = useRef(false);
  const schedulerStateRef = useRef<QueueSchedulerState>({ phase: 'idle' });
  const schedulerGenerationRef = useRef(0);
  const executeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleQueueItem = useCallback((nextMessage: QueuedMessage) => {
    if (isExecutingFromQueueRef.current) return;

    isExecutingFromQueueRef.current = true;
    setQueue(prev => prev.some(item => item.id === nextMessage.id)
      ? prev.filter(item => item.id !== nextMessage.id)
      : prev);
    executeTimerRef.current = setTimeout(() => {
      executeTimerRef.current = null;
      onExecuteRef.current(nextMessage.content, nextMessage.attachments);
      isExecutingFromQueueRef.current = false;
    }, 50);
  }, []);

  const releaseInterruptedTarget = useCallback((
    nextMessage: QueuedMessage,
    generation: number,
    releasedByCompletionId: string,
  ) => {
    schedulerStateRef.current = {
      phase: 'waiting-for-queued-turn-start',
      generation,
      itemId: nextMessage.id,
      releasedByCompletionId,
    };
    setQueue(prev => prev.some(item => item.id === nextMessage.id)
      ? prev.filter(item => item.id !== nextMessage.id)
      : prev);

    const execute = () => {
      executeTimerRef.current = null;
      const schedulerState = schedulerStateRef.current;
      if (
        schedulerState.phase !== 'waiting-for-queued-turn-start'
        || schedulerState.generation !== generation
        || schedulerState.itemId !== nextMessage.id
      ) {
        return;
      }
      onExecuteRef.current(nextMessage.content, nextMessage.attachments);
    };

    // 保留现有延迟，确保目标项先从队列移除，再发送消息。
    executeTimerRef.current = setTimeout(execute, 50);
  }, []);

  // Generate unique ID
  const generateId = useCallback(() => {
    return `queue-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }, []);

  // Add message to queue
  const enqueue = useCallback((content: string, attachments?: Attachment[]) => {
    const newItem: QueuedMessage = {
      id: generateId(),
      content,
      attachments,
      queuedAt: Date.now(),
    };
    setQueue(prev => [...prev, newItem]);
  }, [generateId]);

  // Remove message from queue
  const dequeue = useCallback((id: string) => {
    setQueue(prev => prev.filter(item => item.id !== id));
  }, []);

  // Clear entire queue
  const clearQueue = useCallback(() => {
    setQueue([]);
  }, []);

  // Update a queued message while preserving its metadata and position.
  const update = useCallback((id: string, content: string) => {
    setQueue(prev => {
      const index = prev.findIndex(item => item.id === id);
      if (index === -1) return prev;

      const next = [...prev];
      next[index] = { ...next[index], content };
      return next;
    });
  }, []);

  // Move a queued message one position earlier in logical execution order.
  const moveUp = useCallback((id: string) => {
    setQueue(prev => {
      const index = prev.findIndex(item => item.id === id);
      if (index <= 0) return prev;

      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }, []);

  // Move a queued message one position later in logical execution order.
  const moveDown = useCallback((id: string) => {
    setQueue(prev => {
      const index = prev.findIndex(item => item.id === id);
      if (index === -1 || index === prev.length - 1) return prev;

      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  }, []);

  // Move a queued message to the next execution position.
  const moveToFront = useCallback((id: string) => {
    setQueue(prev => {
      const index = prev.findIndex(item => item.id === id);
      if (index <= 0) return prev;

      return [prev[index], ...prev.slice(0, index), ...prev.slice(index + 1)];
    });
  }, []);

  // Move a queued message to the last execution position.
  const moveToBack = useCallback((id: string) => {
    setQueue(prev => {
      const index = prev.findIndex(item => item.id === id);
      if (index === -1 || index === prev.length - 1) return prev;

      return [...prev.slice(0, index), ...prev.slice(index + 1), prev[index]];
    });
  }, []);

  // Insert is a semantic alias for becoming the next queued execution.
  const insert = useCallback((id: string) => {
    setQueue(prev => {
      const index = prev.findIndex(item => item.id === id);
      if (index <= 0) return prev;

      return [prev[index], ...prev.slice(0, index), ...prev.slice(index + 1)];
    });
  }, []);

  const interruptAndSendNow = useCallback((id: string) => {
    const item = queueRef.current.find(message => message.id === id);
    if (!item) return;

    const schedulerState = schedulerStateRef.current;
    if (
      schedulerState.phase === 'waiting-for-interrupted-turn-end'
      || schedulerState.phase === 'waiting-for-queued-turn-start'
    ) {
      return;
    }

    if (isLoading) {
      const generation = ++schedulerGenerationRef.current;
      schedulerStateRef.current = {
        phase: 'waiting-for-interrupted-turn-end',
        generation,
        target: item,
      };
      moveToFront(id);
      onInterrupt?.();
      return;
    }

    if (schedulerState.phase !== 'idle') return;

    setQueue(prev => prev.filter(message => message.id !== id));
    onExecuteRef.current(item.content, item.attachments);
  }, [isLoading, moveToFront, onInterrupt]);

  // 保持原有行为：普通完成和右下角停止都在 loading true -> false 时消费一条队首。
  useEffect(() => {
    const wasLoading = prevLoadingRef.current;
    prevLoadingRef.current = isLoading;

    if (
      wasLoading
      && !isLoading
      && schedulerStateRef.current.phase === 'idle'
      && !isExecutingFromQueueRef.current
    ) {
      const nextMessage = queueRef.current[0];
      if (nextMessage) scheduleQueueItem(nextMessage);
    }
  }, [isLoading, queue, scheduleQueueItem]);

  useEffect(() => {
    const handleStreamStarted = (event: Event) => {
      const detail = (event as CustomEvent<MessageQueueStreamStartedDetail>).detail;
      if (!detail || !Number.isFinite(detail.turnId) || detail.turnId <= 0) return;

      const schedulerState = schedulerStateRef.current;
      if (schedulerState.phase === 'waiting-for-queued-turn-start') {
        schedulerStateRef.current = {
          phase: 'waiting-for-queued-turn-end',
          generation: schedulerState.generation,
          itemId: schedulerState.itemId,
          releasedByCompletionId: schedulerState.releasedByCompletionId,
          turnId: detail.turnId,
        };
        return;
      }

      // 重复 STREAM_START 会生成新的前端 turnId，以最新一次为准。
      if (schedulerState.phase === 'waiting-for-queued-turn-end') {
        schedulerStateRef.current = {
          ...schedulerState,
          turnId: detail.turnId,
        };
      }
    };

    const handleStreamCompleted = (event: Event) => {
      const detail = (event as CustomEvent<MessageQueueStreamCompletedDetail>).detail;
      if (!detail || typeof detail.completionId !== 'string' || !detail.completionId) return;

      const schedulerState = schedulerStateRef.current;
      if (schedulerState.phase === 'idle') return;

      if (schedulerState.phase === 'waiting-for-interrupted-turn-end') {
        releaseInterruptedTarget(
          schedulerState.target,
          schedulerState.generation,
          detail.completionId,
        );
        return;
      }

      if (schedulerState.phase === 'waiting-for-queued-turn-start') {
        // 目标项尚未收到新的 STREAM_START；此时到达的结束信号都属于旧轮次或其重复通知。
        return;
      }

      if (schedulerState.phase === 'waiting-for-queued-turn-end') {
        if (detail.completionId === schedulerState.releasedByCompletionId) return;
        if (detail.turnId !== schedulerState.turnId) return;

        schedulerStateRef.current = { phase: 'idle' };
        const nextMessage = queueRef.current[0];
        if (nextMessage) scheduleQueueItem(nextMessage);
        return;
      }
    };

    window.addEventListener(MESSAGE_QUEUE_STREAM_STARTED_EVENT, handleStreamStarted);
    window.addEventListener(MESSAGE_QUEUE_STREAM_COMPLETED_EVENT, handleStreamCompleted);
    return () => {
      window.removeEventListener(MESSAGE_QUEUE_STREAM_STARTED_EVENT, handleStreamStarted);
      window.removeEventListener(MESSAGE_QUEUE_STREAM_COMPLETED_EVENT, handleStreamCompleted);
      if (executeTimerRef.current != null) {
        clearTimeout(executeTimerRef.current);
        executeTimerRef.current = null;
      }
    };
  }, [releaseInterruptedTarget, scheduleQueueItem]);

  return {
    queue,
    enqueue,
    dequeue,
    clearQueue,
    update,
    moveUp,
    moveDown,
    moveToFront,
    moveToBack,
    insert,
    interruptAndSendNow,
    hasQueuedMessages: queue.length > 0,
  };
}
