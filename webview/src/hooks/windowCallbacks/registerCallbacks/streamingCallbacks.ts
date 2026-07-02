/**
 * streamingCallbacks.ts
 *
 * Registers window bridge callbacks for streaming:
 * onStreamStart, onContentDelta, onThinkingDelta, onStreamEnd, onPermissionDenied.
 */

import { startTransition } from 'react';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { ClaudeMessage, ClaudeRawMessage } from '../../../types';
import { sendBridgeEvent } from '../../../utils/bridge';
import { THROTTLE_INTERVAL } from '../../useStreamingMessages';
import { parseSequence } from '../parseSequence';
import { getStreamEndHandlingMode } from '../messageSync';

/**
 * Pour every tool_use_id carried by tool_result blocks inside one message's raw
 * into the supplied accumulator.
 *
 * Writing into a caller-provided Set (instead of returning a fresh one) lets
 * {@link collectUnresolvedToolUseIds} fold every message into a single pass
 * without per-message intermediate allocations. A no-op when the message has
 * no usable raw or no tool_result blocks.
 */
const harvestToolResultIdsInto = (
  message: ClaudeMessage | undefined,
  target: Set<string>,
): void => {
  if (!message?.raw) return;
  const rawObj = typeof message.raw === 'string' ? JSON.parse(message.raw) : message.raw;
  const content = rawObj?.content ?? rawObj?.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content as Array<{ type?: string; tool_use_id?: string }>) {
    if (block?.type === 'tool_result' && block.tool_use_id) {
      target.add(block.tool_use_id);
    }
  }
};

/**
 * Scans assistant messages containing tool_use blocks and returns IDs that have
 * no matching tool_result anywhere in the conversation.
 *
 * scope: 'lastTurn'  — only inspect the most recent assistant tool_use group and
 *                       every consecutive user message trailing it (default;
 *                       used by onPermissionDenied + onStreamEnd, where only the
 *                       active turn can have stragglers). The trailing sweep
 *                       stops at the first non-user message so results from a
 *                       later turn never leak into this turn's resolution set.
 * scope: 'all'       — collect every tool_use ID across the whole message list
 *                       and check against every tool_result block anywhere.
 *                       Required by historyLoadComplete because a replayed
 *                       Codex session may contain multiple aborted turns whose
 *                       missing results would otherwise be invisible to the
 *                       lastTurn heuristic.
 *
 * Without this, tool blocks like BashToolGroupBlock keep rendering pending
 * spinners forever because parseBashItem treats `result == null` as "still
 * running".
 */
export function collectUnresolvedToolUseIds(
  messages: ClaudeMessage[],
  scope: 'lastTurn' | 'all' = 'lastTurn',
): string[] {
  const idsToAdd: string[] = [];
  try {
    if (scope === 'all') {
      // Pass 1: gather every tool_result id present anywhere in the conversation.
      const resolvedIds = new Set<string>();
      for (const msg of messages) {
        harvestToolResultIdsInto(msg, resolvedIds);
      }
      // Pass 2: flag every assistant tool_use without a matching result.
      for (const msg of messages) {
        if (msg.type !== 'assistant' || !msg.raw) continue;
        const rawObj = typeof msg.raw === 'string' ? JSON.parse(msg.raw) : msg.raw;
        const content = rawObj?.content ?? rawObj?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content as Array<{ type?: string; id?: string }>) {
          if (block?.type === 'tool_use' && block.id
              && !resolvedIds.has(block.id)
              && !window.__deniedToolIds?.has(block.id)) {
            idsToAdd.push(block.id);
          }
        }
      }
      return idsToAdd;
    }

    // scope === 'lastTurn'
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type !== 'assistant' || !msg.raw) continue;
      const rawObj = typeof msg.raw === 'string' ? JSON.parse(msg.raw) : msg.raw;
      const content = rawObj.content || rawObj.message?.content;
      if (!Array.isArray(content)) continue;

      const toolUses = content.filter(
        (block: { type?: string; id?: string }) =>
          block.type === 'tool_use' && block.id,
      ) as Array<{ type: string; id: string; name?: string }>;
      if (toolUses.length === 0) continue;

      // Collect tool_result ids from EVERY user message trailing this assistant,
      // not just messages[i + 1]. The backend (ClaudeMessageHandler.handleToolResult)
      // emits one user message per tool_result, so N parallel tool_use fan out into
      // N consecutive user messages. Stopping at the first result message would
      // strand the remaining tool_use ids and mark them as interrupted (red badge)
      // even though their results are present further down the list. The sweep
      // halts at the first non-user message (e.g. the next assistant) so results
      // belonging to a later turn never leak into this turn's resolution set.
      const existingResultIds = new Set<string>();
      for (let j = i + 1; j < messages.length; j++) {
        const follower = messages[j];
        if (follower?.type !== 'user') break;
        harvestToolResultIdsInto(follower, existingResultIds);
      }

      for (const tu of toolUses) {
        if (!existingResultIds.has(tu.id) && !window.__deniedToolIds?.has(tu.id)) {
          idsToAdd.push(tu.id);
        }
      }
      break;
    }
  } catch (e) {
    console.error('[Frontend] Error in collectUnresolvedToolUseIds:', e);
  }
  return idsToAdd;
}

/**
 * Timeout (ms) for detecting a stalled stream.  If no content/thinking delta
 * arrives for this duration while isStreamingRef is still true, the frontend
 * auto-recovers by forcing the stream-end cleanup.  This guards against the
 * backend onStreamEnd signal being silently dropped by JCEF.
 *
 * Set to 60s to avoid false positives during long tool execution phases
 * (e.g., command execution, file operations) where no content deltas arrive
 * but the backend is still actively processing.  The backend heartbeat
 * mechanism in StreamMessageCoalescer keeps __lastStreamActivityAt bumped
 * via periodic updateMessages re-pushes.
 */
const STREAM_STALL_TIMEOUT_MS = 60_000;
const STREAM_STALL_CHECK_INTERVAL_MS = 5_000;

// Helper to measure total text length from raw blocks (for comparing completeness).
// Handles both object and JSON string formats of raw.
type TextBlock = { type: 'text'; text: string };
const hasTextBlocks = (value: unknown): value is { message: { content: TextBlock[] } } => {
  if (!value || typeof value !== 'object') return false;
  const msg = (value as { message?: unknown }).message;
  if (!msg || typeof msg !== 'object') return false;
  const content = (msg as { content?: unknown }).content;
  return Array.isArray(content);
};
const getTextLenFromRaw = (raw: unknown): number => {
  let parsedRaw: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsedRaw = JSON.parse(raw);
    } catch (error) {
      console.warn('[Frontend] Failed to parse raw JSON for length comparison:', error);
      return 0;
    }
  }
  if (!hasTextBlocks(parsedRaw)) return 0;
  return parsedRaw.message.content
    .filter((b): b is TextBlock => b?.type === 'text' && typeof b.text === 'string')
    .reduce((sum, b) => sum + b.text.length, 0);
};

export function registerStreamingCallbacks(options: UseWindowCallbacksOptions): void {
  const {
    setMessages,
    setStreamingActive,
    setLoading,
    setLoadingStartTime,
    setIsThinking,
    setExpandedThinking,
    streamingContentRef,
    streamingThinkingRef,
    isStreamingRef,
    useBackendStreamingRenderRef,
    autoExpandedThinkingKeysRef,
    streamingMessageIndexRef,
    streamingTurnIdRef,
    turnIdCounterRef,
    lastContentUpdateRef,
    contentUpdateTimeoutRef,
    lastThinkingUpdateRef,
    thinkingUpdateTimeoutRef,
    getOrCreateStreamingAssistantIndex,
    patchAssistantForStreaming,
  } = options;

  // ── Stream stall watchdog ──
  // Tracks the last time we received any streaming activity (delta or
  // updateMessages during streaming).  A periodic check auto-recovers
  // if the backend's onStreamEnd signal was silently lost.
  // Exposed on window so messageCallbacks can also bump this on updateMessages.
  //
  // The interval handle is stored on `window` so that if registerStreamingCallbacks
  // is called again (e.g., HMR, parent re-render), the previous interval is
  // cleared first — preventing multiple watchdogs from running simultaneously.
  if (window.__stallWatchdogInterval != null) {
    clearInterval(window.__stallWatchdogInterval);
    window.__stallWatchdogInterval = null;
  }
  window.__lastStreamActivityAt = 0;

  const clearStallWatchdog = () => {
    if (window.__stallWatchdogInterval != null) {
      clearInterval(window.__stallWatchdogInterval);
      window.__stallWatchdogInterval = null;
    }
  };

  const startStallWatchdog = () => {
    clearStallWatchdog();
    window.__lastStreamActivityAt = Date.now();
    window.__stallWatchdogInterval = setInterval(() => {
      if (!isStreamingRef.current) {
        clearStallWatchdog();
        return;
      }
      const elapsed = Date.now() - (window.__lastStreamActivityAt ?? 0);
      if (elapsed >= STREAM_STALL_TIMEOUT_MS) {
        console.warn(
          `[StreamWatchdog] Stream stalled for ${elapsed}ms — forcing stream-end recovery`,
        );
        clearStallWatchdog();
        // Trigger the same cleanup as onStreamEnd
        if (typeof window.onStreamEnd === 'function') {
          window.onStreamEnd();
        }
      }
    }, STREAM_STALL_CHECK_INTERVAL_MS);
  };

  window.onStreamStart = (mode?: string | boolean) => {
    if (window.__sessionTransitioning) return;
    const isReplayStart = mode === 'replay' || mode === true;
    // Clear any stale pending updateMessages from previous turn.
    // This prevents onStreamEnd from using outdated snapshot data.
    if (typeof window.__cancelPendingUpdateMessages === 'function') {
      window.__cancelPendingUpdateMessages();
    }
    // Explicit null in case the rAF already executed (clearing pendingUpdateRaf)
    // but __pendingUpdateJson was not yet cleared by the rAF callback.
    window.__pendingUpdateJson = null;
    // Clear the previous stream-ended marker when a new turn starts
    window.__lastStreamEndedTurnId = undefined;
    window.__lastStreamEndedAt = undefined;
    // Clear idempotency guard for the new turn
    window.__streamEndProcessedTurnId = undefined;
    // Record turn start time for duration calculation in onStreamEnd
    window.__turnStartedAt = Date.now();
    streamingContentRef.current = '';
    streamingThinkingRef.current = '';
    isStreamingRef.current = true;
    startStallWatchdog();
    useBackendStreamingRenderRef.current = false;
    autoExpandedThinkingKeysRef.current.clear();
    setStreamingActive(true);

    // FIX: Always reset streamingMessageIndexRef regardless of backend streaming mode
    streamingMessageIndexRef.current = -1;
    turnIdCounterRef.current += 1;
    streamingTurnIdRef.current = turnIdCounterRef.current;
    setMessages((prev) => {
      const last = prev[prev.length - 1];
      if (isReplayStart && last?.type === 'assistant') {
        streamingMessageIndexRef.current = prev.length - 1;
        const updated = [...prev];
        updated[prev.length - 1] = {
          ...updated[prev.length - 1],
          isStreaming: true,
          __turnId: streamingTurnIdRef.current,
        };
        return updated;
      }
      streamingMessageIndexRef.current = prev.length;
      return [
        ...prev,
        {
          type: 'assistant',
          content: '',
          isStreaming: true,
          timestamp: new Date().toISOString(),
          __turnId: streamingTurnIdRef.current,
        },
      ];
    });
  };

  // rAF-scheduled streaming update: frame-aligned, avoids setTimeout jank.
  // Factory that creates a throttled scheduler bound to a specific timeoutRef +
  // lastUpdateRef pair.  patchAssistantForStreaming reads streamingContentRef /
  // streamingThinkingRef from the hook closure, so the factory only needs to
  // know which ref pair to guard against double-scheduling.
  const createStreamingRafScheduler = (
    timeoutRef: React.MutableRefObject<number | null>,
    lastUpdateRef: React.MutableRefObject<number>,
  ) => {
    const scheduleRaf = (): void => {
      if (timeoutRef.current != null) return;
      timeoutRef.current = requestAnimationFrame(() => {
        timeoutRef.current = null;
        const now = Date.now();
        const elapsed = now - lastUpdateRef.current;
        if (elapsed < THROTTLE_INTERVAL) {
          scheduleRaf(); // too soon — wait for next frame
          return;
        }
        lastUpdateRef.current = now;
        startTransition(() => {
          setMessages((prev) => {
            const newMessages = [...prev];
            let idx: number;
            if (useBackendStreamingRenderRef.current) {
              idx = streamingMessageIndexRef.current;
              if (idx < 0) return prev;
            } else {
              idx = getOrCreateStreamingAssistantIndex(newMessages);
            }
            if (idx >= 0 && newMessages[idx]?.type === 'assistant') {
              newMessages[idx] = patchAssistantForStreaming({
                ...newMessages[idx],
                isStreaming: true,
              });
            }
            return newMessages;
          });
        });
      });
    };
    return scheduleRaf;
  };

  const scheduleContentRaf = createStreamingRafScheduler(contentUpdateTimeoutRef, lastContentUpdateRef);
  const scheduleThinkingRaf = createStreamingRafScheduler(thinkingUpdateTimeoutRef, lastThinkingUpdateRef);

  window.onContentDelta = (delta: string) => {
    if (window.__sessionTransitioning) return;
    if (!isStreamingRef.current) return;
    window.__lastStreamActivityAt = Date.now();
    streamingContentRef.current += delta;
    scheduleContentRaf();
  };

  window.onThinkingDelta = (delta: string) => {
    if (window.__sessionTransitioning) return;
    if (!isStreamingRef.current) return;
    window.__lastStreamActivityAt = Date.now();
    streamingThinkingRef.current += delta;
    scheduleThinkingRaf();
  };

  window.onStreamEnd = (sequence?: string | number) => {
    if (window.__sessionTransitioning) return;

    // Idempotency guard: dual-path delivery (primary via flush callback +
    // fallback via Alarm) may send onStreamEnd twice for the same turn.
    // Only the first arrival takes effect; the second is a no-op.
    //
    // After the first onStreamEnd processes, streamingTurnIdRef is cleared to -1
    // and isStreamingRef is set to false. The second arrival sees these cleared
    // refs and should bail out. We check both conditions:
    // 1. If the current turn ID was already processed (before refs were cleared)
    // 2. If streaming is already inactive (refs were already cleared by first call)
    const currentTurnId = streamingTurnIdRef.current;
    const handlingMode = getStreamEndHandlingMode(
      options.currentProviderRef.current,
      isStreamingRef.current,
      currentTurnId,
    );
    if (currentTurnId > 0 && window.__streamEndProcessedTurnId === currentTurnId) {
      return;
    }
    if (handlingMode === 'skip') {
      // Streaming refs already cleared by a previous onStreamEnd — nothing to do
      return;
    }

    clearStallWatchdog();
    const parsedSequence = parseSequence(sequence);
    // Only update minAcceptedUpdateSequence for valid positive sequences.
    // The fallback path sends sequence=-1 which means "no sequence info" —
    // it should not participate in sequence tracking.
    if (parsedSequence != null && parsedSequence >= 0) {
      window.__minAcceptedUpdateSequence = Math.max(window.__minAcceptedUpdateSequence ?? 0, parsedSequence);
    }
    // Notify backend about stream completion for tab status indicator
    sendBridgeEvent('tab_status_changed', JSON.stringify({ status: 'completed' }));

    if (handlingMode === 'minimal') {
      if (typeof window.__cancelPendingUpdateMessages === 'function') {
        window.__cancelPendingUpdateMessages();
      }
      setStreamingActive(false);
      setLoading(false);
      setLoadingStartTime(null);
      setIsThinking(false);
      window.__streamEndProcessedTurnId = currentTurnId > 0 ? currentTurnId : undefined;
      return;
    }

    // FIX: Extract backend final snapshot from pending updateMessages BEFORE cancelling rAF.
    // The backend's final flush contains the authoritative message state (complete raw blocks).
    // If onStreamEnd cancels the rAF without processing this snapshot, the final message may
    // show incomplete content (e.g., last delta missing) or duplicated content in raw blocks.
    //
    // FIX: Also preserve tool_result user messages from the pending snapshot.
    // Previously only the assistant message was extracted; tool_result user messages were
    // silently dropped when the pending rAF was cancelled.  This caused tool cards to
    // remain stuck in "pending" state (spinner) even though the tool had completed.
    let backendSnapshotContent: string | undefined;
    let backendSnapshotRaw: ClaudeRawMessage | string | undefined = undefined;
    const pendingToolResultMsgs: Array<{ content: string; raw: Record<string, unknown> }> = [];
    if (typeof window.__pendingUpdateJson === 'string' && window.__pendingUpdateJson.length > 0) {
      try {
        const parsed = JSON.parse(window.__pendingUpdateJson) as Array<Record<string, unknown>>;
        for (let i = parsed.length - 1; i >= 0; i--) {
          if (parsed[i]?.type === 'assistant') {
            const rawContent = parsed[i].content;
            const content = typeof rawContent === 'string' ? rawContent : '';
            if (content) {
              backendSnapshotContent = content;
              const rawVal = parsed[i].raw;
              if (rawVal != null && (typeof rawVal === 'object' || typeof rawVal === 'string')) {
                backendSnapshotRaw = rawVal as ClaudeRawMessage | string;
              }
            }
            break;
          }
        }
        // Collect tool_result user messages from the pending snapshot so that
        // completed tool calls are not lost when the rAF is cancelled below.
        for (let i = 0; i < parsed.length; i++) {
          const msg = parsed[i];
          if (msg?.type === 'user' && typeof msg.content === 'string' && msg.content.trim() === '[tool_result]') {
            const raw = msg.raw as Record<string, unknown> | undefined;
            if (raw != null && typeof raw === 'object') {
              pendingToolResultMsgs.push({ content: '[tool_result]', raw });
            }
          }
        }
      } catch (error) {
        // __pendingUpdateJson is produced internally by the bridge; a parse failure
        // indicates an upstream contract violation worth surfacing for diagnosis.
        console.warn('[Frontend] Failed to parse __pendingUpdateJson on stream end:', error);
      }
    }

    if (typeof window.__cancelPendingUpdateMessages === 'function') {
      window.__cancelPendingUpdateMessages();
    }

    // Clear pending rAF callbacks — their content is already in streamingContentRef
    if (contentUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(contentUpdateTimeoutRef.current);
      contentUpdateTimeoutRef.current = null;
    }
    if (thinkingUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(thinkingUpdateTimeoutRef.current);
      thinkingUpdateTimeoutRef.current = null;
    }

    // Snapshot keys that need collapsing BEFORE they are cleared inside the updater.
    const keysToCollapse = new Set(autoExpandedThinkingKeysRef.current);

    // Snapshot turn start time BEFORE entering the updater
    const turnStartedAt = window.__turnStartedAt;
    window.__turnStartedAt = undefined;
    // Snapshot stream-end time and derived values BEFORE the updater to keep it pure.
    // Date.now() / new Date() inside an updater are impure: React StrictMode double-invokes
    // updaters and would produce two different timestamps for the same stream end.
    const streamEndedAt = Date.now();
    const durationMs = (typeof turnStartedAt === 'number' && turnStartedAt > 0)
      ? streamEndedAt - turnStartedAt
      : undefined;
    const toolResultTimestamp = new Date(streamEndedAt).toISOString();

    // Snapshot streaming state BEFORE clearing refs - used for post-stream merge guard
    const endedStreamingTurnId = streamingTurnIdRef.current;
    const endedStreamingMessageIndex = streamingMessageIndexRef.current;

    // Initialize denied tool ids set if not exists
    if (!window.__deniedToolIds) {
      window.__deniedToolIds = new Set<string>();
    }
    // FIX: Prioritize streaming content over backend snapshot to prevent digit loss
    // Streaming content has all the latest deltas (including the final one just flushed).
    // Backend snapshot might be from an earlier coalescer push and may be incomplete.
    const endedStreamingContent = streamingContentRef.current || backendSnapshotContent || '';
    const endedBackendRaw = backendSnapshotRaw;

    // FIX: Clear streaming refs BEFORE setMessages updater to prevent race conditions.
    //
    // Trade-off analysis:
    // - Original approach: refs cleared inside updater, leverages React batching to ensure
    //   clearing and state update happen together. But this caused timing issues when
    //   deferred operations (rAF, timeout) executed after the updater but before refs were
    //   actually cleared, allowing them to modify the streaming message incorrectly.
    // - New approach: refs cleared outside updater, uses snapshot values inside updater.
    //   This prevents race conditions where deferred updateMessages sees isStreamingRef=false
    //   but streamingMessageIndexRef still points to the old message.
    // - Benefit: More robust handling of async callback ordering, especially important
    //   when JCEF async chains can reorder callbacks unpredictably.
    // - Risk: Minimal, since snapshot values are used inside updater and refs are cleared
    //   synchronously before the updater is scheduled.
    //
    // Streaming state refs (isStreaming flag)
    isStreamingRef.current = false;
    useBackendStreamingRenderRef.current = false;

    // Index refs (message position tracking)
    streamingMessageIndexRef.current = -1;
    streamingTurnIdRef.current = -1;

    // Content buffer refs
    streamingContentRef.current = '';
    streamingThinkingRef.current = '';
    autoExpandedThinkingKeysRef.current.clear();

    // Mark that streaming just ended - used by mergeConsecutiveAssistantMessages to
    // distinguish recently-ended streaming messages from true history messages.
    window.__lastStreamEndedTurnId = endedStreamingTurnId;
    window.__lastStreamEndedAt = Date.now();

    // Flush final content and finalize the streaming message.
    // FIX (Issue #1315): Merge interrupted tool detection AND the denied-tool side
    // effect into this single setMessages call.
    //
    // Context: React 18 batches multiple setState calls within the same event handler.
    // Each updater receives the SAME previous state, and React uses only the LAST
    // return value for the final state. Previously a second setMessages() that
    // scanned for interrupted tool_use IDs received stale state and overwrote the
    // updates made here.
    //
    // CRITICAL: the __deniedToolIds mutation MUST also happen inside the updater,
    // not after setMessages() returns. React 18 does NOT run updaters synchronously
    // during the setState call — they run later during the render phase. Any value
    // captured in a closure variable after setMessages() would be empty.
    setMessages((prev) => {
      let newMessages = prev;
      // FIX (Issue #1315 investigation, residual risk A): Prefer the snapshot
      // index, but fall back to a __turnId scan when an interleaved
      // updateMessages reordered/shrank the list so prev[idx] is no longer the
      // streaming assistant. Without this, the final content flush is silently
      // dropped. The re-scan only runs when the primary index is invalid, so the
      // hot path (index still valid) pays no cost.
      let idx = endedStreamingMessageIndex;
      if (!(idx >= 0 && idx < prev.length && prev[idx]?.type === 'assistant')
          && endedStreamingTurnId > 0) {
        for (let i = prev.length - 1; i >= 0; i--) {
          const msg = prev[i];
          if (msg?.type === 'assistant' && msg.__turnId === endedStreamingTurnId) {
            idx = i;
            break;
          }
        }
      }
      if (idx >= 0 && idx < prev.length && prev[idx]?.type === 'assistant') {
        newMessages = [...prev];
        // FIX: Keep __turnId on the message for a short period to prevent
        // incorrect merging with history messages. The __turnId will be
        // removed later when history is loaded or a new turn starts.
        const finalContent = endedStreamingContent || newMessages[idx].content || '';
        // Use backend raw blocks only if they are more complete than the existing raw.
        // The backend snapshot may be from an earlier coalescer flush, so the existing
        // raw (updated by subsequent deltas) could actually be more up-to-date.
        let finalRaw = newMessages[idx].raw;
        if (endedBackendRaw != null) {
          if (getTextLenFromRaw(endedBackendRaw) >= getTextLenFromRaw(finalRaw)) {
            finalRaw = endedBackendRaw;
          }
        }
        newMessages[idx] = {
          ...newMessages[idx],
          content: finalContent,
          raw: finalRaw,
          isStreaming: false,
          __turnId: endedStreamingTurnId, // Keep __turnId for merge guard
          ...(durationMs != null ? { durationMs } : {}),
        };
      }

      // FIX: Merge tool_result user messages that were in the pending snapshot
      // but would otherwise be lost when the rAF is cancelled.  Without this,
      // tool cards remain stuck in "pending" spinner state.
      //
      // Runs INDEPENDENTLY of the assistant-patch branch above: a completed
      // tool_result can land in the pending snapshot even when there is no active
      // streaming assistant message to finalize (endedStreamingMessageIndex < 0,
      // e.g. backend-streaming-render paths or a message list mutated between the
      // last delta and stream end).  Coupling it to the assistant branch would
      // silently drop those completed results in exactly the stuck-spinner case
      // this fix targets.
      if (pendingToolResultMsgs.length > 0) {
        // Preserve immutability: lazily clone prev once before the first push so
        // the updater never mutates the previous state array in place (the
        // assistant branch above may have left newMessages === prev).
        if (newMessages === prev) {
          newMessages = [...prev];
        }
        // Build a set of existing tool_use_ids from the current message list
        // to avoid adding duplicate tool_result messages.
        const existingToolResultIds = new Set<string>();
        for (const m of newMessages) {
          const raw = m?.raw as Record<string, unknown> | undefined;
          if (!raw || typeof raw !== 'object') continue;
          const msg = raw.message as Record<string, unknown> | undefined;
          const content = (raw.content ?? msg?.content) as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
              existingToolResultIds.add(block.tool_use_id);
            }
          }
        }
        // Append only tool_result messages that aren't already present
        for (const trMsg of pendingToolResultMsgs) {
          const raw = trMsg.raw;
          const msg = raw.message as Record<string, unknown> | undefined;
          const content = (raw.content ?? msg?.content) as Array<Record<string, unknown>> | undefined;
          if (!Array.isArray(content)) continue;
          const hasNewToolResult = content.some(
            (block) => block?.type === 'tool_result' && typeof block.tool_use_id === 'string' && !existingToolResultIds.has(block.tool_use_id),
          );
          if (hasNewToolResult) {
            newMessages.push({ ...trMsg, type: 'user' as const, timestamp: toolResultTimestamp });
            // Register the freshly-pushed ids so a duplicate tool_result carrying the same
            // tool_use_id later in this snapshot isn't appended a second time.
            for (const block of content) {
              if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
                existingToolResultIds.add(block.tool_use_id);
              }
            }
          }
        }
      }

      // FIX (Issue #1315): Collect interrupted tool_use IDs and mark them as denied
      // INSIDE this updater. This runs against the fully-merged newMessages (finalized
      // assistant + recovered tool_results), which is the authoritative state — a
      // second setMessages call would only see stale state under React 18 batching.
      //
      // The scan cost matches the pre-fix behavior (collectUnresolvedToolUseIds was
      // always called on stream end); we did NOT add a second pass. On the common
      // fully-resolved turn it returns [] and the for-loop below is a no-op.
      try {
        const interruptedIds = collectUnresolvedToolUseIds(newMessages);
        // __deniedToolIds is initialized at the top of onStreamEnd (alongside the
        // streaming-ref snapshots), so the non-null assertion is safe. Cache the
        // reference to avoid re-reading the window property on each iteration.
        //
        // NOTE: mutating a window global inside an updater is intentionally impure.
        // React StrictMode double-invokes updaters in development, but Set.add() is
        // idempotent — adding the same id twice leaves the Set in the correct state.
        // Moving this mutation outside setMessages() is not feasible: React 18 does
        // not run updaters synchronously, so any closure variable captured after
        // setMessages() returns would still be empty when the for-loop executes.
        const deniedToolIds = window.__deniedToolIds!;
        for (const id of interruptedIds) {
          deniedToolIds.add(id);
        }
      } catch (error) {
        console.error('[Frontend] Failed to collect interrupted tool ids:', error);
      }

      return newMessages;
    });

    // Collapse auto-expanded thinking blocks using the pre-clear snapshot
    if (setExpandedThinking && keysToCollapse.size > 0) {
      setExpandedThinking((prev) => {
        const next = { ...prev };
        keysToCollapse.forEach((key) => {
          next[key] = false;
        });
        return next;
      });
    }

    // React state (not ref) — React batches this with setMessages automatically
    setStreamingActive(false);

    // FIX: onStreamEnd is the authoritative signal that streaming has ended.
    // Reset loading state here to prevent race conditions where showLoading("false")
    // arrives before onStreamEnd and gets ignored by the isStreamingRef guard,
    // while the flush callback's showLoading("false") may be delayed or lost
    // (e.g., due to slow message serialization or multi-hop async chains).
    setLoading(false);
    setLoadingStartTime(null);
    setIsThinking(false);

    // Mark this turn as processed — idempotency guard for dual-path delivery
    window.__streamEndProcessedTurnId = endedStreamingTurnId;
  };

  // Streaming heartbeat — lightweight signal from backend during tool execution
  // phases where no content deltas arrive.  Keeps the stall watchdog alive.
  window.onStreamingHeartbeat = () => {
    if (isStreamingRef.current && window.__lastStreamActivityAt !== undefined) {
      window.__lastStreamActivityAt = Date.now();
    }
  };

  // Permission denied callback — kept as a no-op for backward compatibility.
  //
  // The backend (ClaudeChatWindow.interruptDueToPermissionDenial) always calls
  // onStreamEnd() immediately after this in the same EDT invokeLater block.
  // The merged onStreamEnd updater performs the interrupted-tool scan against
  // the authoritative finalized state, which supersedes anything this handler
  // could do against pre-finalize state. Running a second setMessages here
  // would only produce a wasted re-render (React 18 batches the two calls, and
  // onStreamEnd is the last writer). See Issue #1315 investigation for details.
  window.onPermissionDenied = () => {};

  // Block reset callback — clears streaming content refs when a new assistant
  // message starts within an ongoing stream (e.g., after tool_use loop iteration).
  // This prevents cross-turn content merging where new thinking/text deltas
  // would append to previous turn's buffered content.
  window.onBlockReset = () => {
    if (!isStreamingRef.current) {
      // Stream not active, ignore (could be stale signal after stream ended)
      return;
    }
    // NOTE: content/thinking buffers are intentionally NOT cleared here.
    // The Java layer keeps ONE assistant message for the whole turn (including
    // every tool_use loop iteration), appending each turn's text/thinking as
    // additional raw blocks. Clearing the buffers on BLOCK_RESET would discard
    // the prefix carried by earlier turns and break sync*BlocksWithContent's
    // prefix reconciliation: a multi-block turn would drop new deltas (prefix
    // no longer matches) and a single-block turn would overwrite the prior
    // turn's block with the new turn's content. Keep the cumulative buffer; the
    // sync functions' trailing-block guard routes each turn's content into its
    // own block once the backend snapshot delivers it.
    // Intentionally NOT resetting streamingMessageIndexRef either: the assistant
    // message is shared across turns, so the index already points at it.
    // Reset throttle timeouts to ensure clean state for new deltas
    if (contentUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(contentUpdateTimeoutRef.current);
      contentUpdateTimeoutRef.current = null;
    }
    if (thinkingUpdateTimeoutRef.current != null) {
      cancelAnimationFrame(thinkingUpdateTimeoutRef.current);
      thinkingUpdateTimeoutRef.current = null;
    }
    // Reset last update timestamps to prevent throttle delays
    lastContentUpdateRef.current = 0;
    lastThinkingUpdateRef.current = 0;
    // Clear auto-expanded thinking keys for the new turn
    autoExpandedThinkingKeysRef.current.clear();
  };
}
