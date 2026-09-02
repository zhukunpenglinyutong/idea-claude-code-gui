/**
 * streamingCallbacks.test.ts
 *
 * onStreamStart bubble routing:
 * - a still-streaming assistant from an OLDER turn (dropped onStreamEnd) is
 *   finalized and new deltas land on a fresh bubble;
 * - a replay start REUSES the last assistant bubble — the stale-bubble
 *   finalize must not hijack that path (it would strand the replayed turn's
 *   earlier content in a duplicate bubble);
 * - the normal path appends a fresh streaming bubble.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { registerStreamingCallbacks } from './streamingCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { ClaudeMessage } from '../../../types';
import {
  MESSAGE_QUEUE_STREAM_COMPLETED_EVENT,
  type MessageQueueStreamCompletedDetail,
} from '../../../constants/messageQueueEvents';

type Ref<T> = { current: T };
const ref = <T,>(value: T): Ref<T> => ({ current: value });

function createHarness(initialMessages: ClaudeMessage[], turnIdCounter: number) {
  let messages = [...initialMessages];

  const refs = {
    streamingContentRef: ref(''),
    streamingThinkingRef: ref(''),
    isStreamingRef: ref(false),
    useBackendStreamingRenderRef: ref(false),
    autoExpandedThinkingKeysRef: ref(new Set<string>()),
    streamingMessageIndexRef: ref(-1),
    streamingTurnIdRef: ref(-1),
    turnIdCounterRef: ref(turnIdCounter),
    lastContentUpdateRef: ref(0),
    contentUpdateTimeoutRef: ref<number | null>(null),
    lastThinkingUpdateRef: ref(0),
    thinkingUpdateTimeoutRef: ref<number | null>(null),
    currentProviderRef: ref('claude'),
  };

  const options = {
    ...refs,
    setMessages: (updater: ClaudeMessage[] | ((prev: ClaudeMessage[]) => ClaudeMessage[])) => {
      messages = typeof updater === 'function' ? updater(messages) : updater;
    },
    setStreamingActive: () => {},
    setLoading: () => {},
    setLoadingStartTime: () => {},
    setIsThinking: () => {},
    setExpandedThinking: () => {},
    getOrCreateStreamingAssistantIndex: () => -1,
    patchAssistantForStreaming: (message: ClaudeMessage) => message,
  } as unknown as UseWindowCallbacksOptions;

  registerStreamingCallbacks(options);
  return { refs, getMessages: () => messages };
}

describe('onStreamStart bubble routing', () => {
  beforeEach(() => {
    window.__sessionTransitioning = false;
  });

  afterEach(() => {
    // registerStreamingCallbacks starts a stall watchdog on stream start.
    if (window.__stallWatchdogInterval != null) {
      clearInterval(window.__stallWatchdogInterval);
      window.__stallWatchdogInterval = null;
    }
  });

  const olderTurnStreamingAssistant: ClaudeMessage = {
    type: 'assistant',
    content: 'partial answer from turn 1',
    isStreaming: true,
    __turnId: 1,
  };

  it('finalizes a still-streaming assistant from an older turn and opens a fresh bubble', () => {
    const { refs, getMessages } = createHarness(
      [{ type: 'user', content: 'q1' }, { ...olderTurnStreamingAssistant }],
      1,
    );

    window.onStreamStart!();

    const messages = getMessages();
    expect(messages).toHaveLength(3);
    // The orphaned bubble is closed with its content intact...
    expect(messages[1].isStreaming).toBe(false);
    expect(messages[1].content).toBe('partial answer from turn 1');
    // ...and the new turn streams into a fresh bubble.
    expect(messages[2].type).toBe('assistant');
    expect(messages[2].isStreaming).toBe(true);
    expect(messages[2].content).toBe('');
    expect(messages[2].__turnId).toBe(2);
    expect(refs.streamingMessageIndexRef.current).toBe(2);
  });

  it('replay start reuses the last assistant bubble even when it is a stale streaming one', () => {
    // Regression: the stale-bubble finalize must not run before the replay
    // branch. A replay re-delivers the last turn into the LAST bubble; adding
    // a fresh bubble here would duplicate the partial content on screen.
    const { refs, getMessages } = createHarness(
      [{ type: 'user', content: 'q1' }, { ...olderTurnStreamingAssistant }],
      1,
    );

    window.onStreamStart!('replay');

    const messages = getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1].isStreaming).toBe(true);
    expect(messages[1].content).toBe('partial answer from turn 1');
    expect(messages[1].__turnId).toBe(2);
    expect(refs.streamingMessageIndexRef.current).toBe(1);
  });

  it('appends a fresh streaming bubble on the normal path (last assistant already finalized)', () => {
    const { refs, getMessages } = createHarness(
      [
        { type: 'user', content: 'q1' },
        { type: 'assistant', content: 'finished answer', isStreaming: false, __turnId: 1 },
      ],
      1,
    );

    window.onStreamStart!();

    const messages = getMessages();
    expect(messages).toHaveLength(3);
    expect(messages[1].isStreaming).toBe(false);
    expect(messages[1].content).toBe('finished answer');
    expect(messages[2].isStreaming).toBe(true);
    expect(messages[2].__turnId).toBe(2);
    expect(refs.streamingMessageIndexRef.current).toBe(2);
  });

  it('does not finalize history assistants without a __turnId', () => {
    // History messages loaded from JSONL have no __turnId; they are never
    // "streaming leftovers" of this webview instance and must be left as-is.
    const { getMessages } = createHarness(
      [{ type: 'assistant', content: 'history entry', isStreaming: true }],
      1,
    );

    window.onStreamStart!();

    const messages = getMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0].isStreaming).toBe(true);
    expect(messages[1].isStreaming).toBe(true);
    expect(messages[1].__turnId).toBe(2);
  });

  it('reuses an EMPTY older streaming bubble instead of leaving a blank ghost', () => {
    // Regression for duplicated/ghost bubbles: an empty streaming bubble from an
    // older turn (a redundant STREAM_START, or one with no deltas yet) must be
    // reused for the new turn — not finalized as a blank message with a fresh
    // bubble appended after it.
    const { refs, getMessages } = createHarness(
      [
        { type: 'user', content: 'q1' },
        { type: 'assistant', content: '', isStreaming: true, __turnId: 1 },
      ],
      1,
    );

    window.onStreamStart!();

    const messages = getMessages();
    // No extra bubble: the empty placeholder is reused for turn 2.
    expect(messages).toHaveLength(2);
    expect(messages[1].type).toBe('assistant');
    expect(messages[1].isStreaming).toBe(true);
    expect(messages[1].content).toBe('');
    expect(messages[1].__turnId).toBe(2);
    expect(refs.streamingMessageIndexRef.current).toBe(1);
  });

  it('does not create a ghost bubble when onStreamStart fires twice with no deltas', () => {
    // Duplicate STREAM_START delivery: two starts back-to-back before any delta.
    // Must end with exactly one streaming bubble, not two.
    const { refs, getMessages } = createHarness(
      [{ type: 'user', content: 'q1' }],
      0,
    );

    window.onStreamStart!(); // turn 1 bubble (empty)
    window.onStreamStart!(); // duplicate — must reuse, not append

    const messages = getMessages();
    const assistantBubbles = messages.filter((m) => m.type === 'assistant');
    expect(assistantBubbles).toHaveLength(1);
    expect(assistantBubbles[0].isStreaming).toBe(true);
    expect(assistantBubbles[0].__turnId).toBe(2);
    expect(refs.streamingMessageIndexRef.current).toBe(1);
  });
});

describe('onStreamEnd finalizes dangling tool_use when the turn never streamed', () => {
  beforeEach(() => {
    window.__sessionTransitioning = false;
    window.__deniedToolIds = undefined;
  });

  afterEach(() => {
    if (window.__stallWatchdogInterval != null) {
      clearInterval(window.__stallWatchdogInterval);
      window.__stallWatchdogInterval = null;
    }
    window.__deniedToolIds = undefined;
  });

  const assistantWithToolUse = (id: string): ClaudeMessage => ({
    type: 'assistant',
    content: '',
    raw: { message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } },
  });

  it('marks an unresolved tool_use as denied on a non-streaming/error turn (skip mode)', () => {
    // Reproduces "API request failed but the last tool just spins": the turn
    // never streamed (isStreaming=false, turnId=-1 → skip mode), an assistant
    // emitted a tool_use, and the error arrives before any tool_result. The
    // tool must be marked denied so it stops spinning.
    const { getMessages } = createHarness(
      [{ type: 'user', content: 'run ls' }, assistantWithToolUse('tool-1')],
      0,
    );

    // No onStreamStart happened; streaming refs are at their idle defaults.
    window.onStreamEnd!();

    expect(window.__deniedToolIds).toBeDefined();
    expect(window.__deniedToolIds!.has('tool-1')).toBe(true);
    // The list gets a new reference so the denied tool card re-renders.
    expect(getMessages()).toHaveLength(2);
  });

  it('is a no-op when the tool_use already has a matching tool_result', () => {
    const { getMessages } = createHarness(
      [
        { type: 'user', content: 'run ls' },
        assistantWithToolUse('tool-2'),
        {
          type: 'user',
          content: '[tool_result]',
          raw: { message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2', content: 'ok' }] } },
        },
      ],
      0,
    );
    const before = getMessages();

    window.onStreamEnd!();

    // Nothing dangling → no id denied, and the list reference is unchanged.
    expect(window.__deniedToolIds?.has('tool-2') ?? false).toBe(false);
    expect(getMessages()).toBe(before);
  });
});

describe('onStreamEnd queue scheduling signal', () => {
  beforeEach(() => {
    window.__sessionTransitioning = false;
    window.__streamEndProcessedTurnId = undefined;
    window.__streamEndProcessedSequence = undefined;
  });

  afterEach(() => {
    if (window.__stallWatchdogInterval != null) {
      clearInterval(window.__stallWatchdogInterval);
      window.__stallWatchdogInterval = null;
    }
  });

  it('dispatches only one completion event when the same stream end is delivered twice', () => {
    const received: MessageQueueStreamCompletedDetail[] = [];
    const listener = (event: Event) => {
      received.push((event as CustomEvent<MessageQueueStreamCompletedDetail>).detail);
    };
    window.addEventListener(MESSAGE_QUEUE_STREAM_COMPLETED_EVENT, listener);

    try {
      const { refs } = createHarness([{ type: 'user', content: 'question' }], 0);
      window.onStreamStart!();
      const turnId = refs.streamingTurnIdRef.current;

      window.onStreamEnd!('100');
      window.onStreamEnd!('100');

      expect(received).toEqual([{
        completionId: 'sequence:100',
        turnId,
        sequence: 100,
      }]);
    } finally {
      window.removeEventListener(MESSAGE_QUEUE_STREAM_COMPLETED_EVENT, listener);
    }
  });
});
