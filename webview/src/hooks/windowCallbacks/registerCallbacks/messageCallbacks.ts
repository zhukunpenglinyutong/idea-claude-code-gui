/**
 * messageCallbacks.ts
 *
 * Registers window bridge callbacks for message management:
 * updateMessages, updateStatus, showLoading, showThinkingStatus,
 * setHistoryData, clearMessages, addErrorMessage, addHistoryMessage,
 * historyLoadComplete, addUserMessage.
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import type { ClaudeMessage } from '../../../types';
import type { ContextUsageData } from '../../../components/ContextUsageDialog';
import { sendBridgeEvent } from '../../../utils/bridge';
import { debugError } from '../../../utils/debug';
import {
  appendOptimisticMessageIfMissing,
  ensureStreamingAssistantInList,
  getRawUuid,
  preserveLastAssistantIdentity,
  preserveLatestMessagesOnShrink,
  preserveStreamingAssistantContent,
  stripDuplicateTrailingToolMessages,
} from '../messageSync';
import { releaseSessionTransition } from '../sessionTransition';
import { parseSequence } from '../parseSequence';
import { reconstructTurnMetadata } from '../../../utils/turnMetadataReconstruction';
import { collectUnresolvedToolUseIds } from './streamingCallbacks';

const isTruthy = (v: unknown) => v === true || v === 'true';

/**
 * Build a lightweight string signature from non-text raw blocks so we can
 * cheaply detect structural changes (new tool_use/tool_result blocks) without
 * a full JSON.stringify of arbitrary objects.
 */
function getStructuralRawBlockSignature(
  message: ClaudeMessage,
  extractRawBlocks: (raw: ClaudeMessage['raw']) => Record<string, unknown>[],
): string {
  const blocks = extractRawBlocks(message.raw);
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return '';
  }

  const parts: string[] = [];
  for (const raw of blocks) {
    if (!raw || typeof raw !== 'object') continue;
    const block = raw as Record<string, unknown>;
    const type = typeof block.type === 'string' ? block.type : '';
    if (type === 'text' || type === 'thinking') continue;

    if (type === 'tool_use') {
      parts.push(`tu:${block.id ?? ''}:${block.name ?? ''}`);
    } else if (type === 'tool_result') {
      parts.push(`tr:${block.tool_use_id ?? ''}:${block.is_error === true ? '1' : '0'}`);
    } else if (type === 'attachment') {
      parts.push(`at:${block.fileName ?? ''}:${block.mediaType ?? ''}`);
    } else if (type === 'image') {
      parts.push(`im:${block.src ?? ''}:${block.mediaType ?? ''}`);
    } else {
      parts.push(type);
    }
  }

  return parts.join('|');
}

export function registerMessageCallbacks(
  options: UseWindowCallbacksOptions,
  resetTransientUiState: () => void,
): void {
  const {
    addToast,
    setMessages,
    setStatus,
    setLoading,
    setLoadingStartTime,
    setIsThinking,
    setHistoryData,
    userPausedRef,
    isUserAtBottomRef,
    messagesContainerRef,
    suppressNextStatusToastRef,
    streamingContentRef,
    isStreamingRef,
    useBackendStreamingRenderRef,
    streamingMessageIndexRef,
    streamingTurnIdRef,
    findLastAssistantIndex,
    extractRawBlocks,
    patchAssistantForStreaming,
    updateContextUsageData,
    closeContextUsageDialog,
  } = options;

  const ensureStreamingAssistantPreserved = (prevList: ClaudeMessage[], resultList: ClaudeMessage[]): ClaudeMessage[] => {
    const { list, streamingIndex } = ensureStreamingAssistantInList(
      prevList,
      resultList,
      isStreamingRef.current,
      streamingTurnIdRef.current,
    );
    if (streamingIndex >= 0) {
      streamingMessageIndexRef.current = streamingIndex;
    }
    return list;
  };

  const finalizeMessageList = (prevList: ClaudeMessage[], resultList: ClaudeMessage[]): ClaudeMessage[] => {
    const withoutDuplicateToolTail = stripDuplicateTrailingToolMessages(
      resultList,
      options.currentProviderRef.current,
    );
    return ensureStreamingAssistantPreserved(prevList, withoutDuplicateToolTail);
  };

  // During streaming, buffer updateMessages calls and process only the latest
  // one per animation frame. This prevents JSON.parse of large payloads from
  // blocking the main thread on every coalescer push (which can arrive every
  // 50ms), eliminating the "fake freeze" symptom.
  //
  // Stored on `window` so that if registerMessageCallbacks is called again
  // (e.g., HMR, parent re-render), the previous pending rAF is cancelled
  // first — preventing stale closures from executing.
  if (window.__pendingUpdateRaf != null) {
    clearTimeout(window.__pendingUpdateRaf);
    window.__pendingUpdateRaf = null;
    window.__pendingUpdateJson = null;
    window.__pendingUpdateSequence = null;
  }
  let pendingUpdateJson: string | null = null;
  let pendingUpdateRaf: number | null = null;
  let pendingUpdateSequence: number | null = null;

  // Expose a cancellation function so onStreamEnd can cancel stale rAF-deferred
  // updateMessages calls, preventing them from overwriting the final state after
  // streaming refs are cleared.
  const cancelPendingUpdateMessages = () => {
    if (pendingUpdateRaf !== null) {
      clearTimeout(pendingUpdateRaf);
    }
    pendingUpdateRaf = null;
    pendingUpdateJson = null;
    pendingUpdateSequence = null;
    window.__pendingUpdateRaf = null;
    window.__pendingUpdateJson = null;
    window.__pendingUpdateSequence = null;
  };
  window.__cancelPendingUpdateMessages = cancelPendingUpdateMessages;

  const processUpdateMessages = (json: string, sequence: number | null = null) => {
    // Re-check the session-transition guard inside processUpdateMessages so the
    // rAF-deferred path (window.updateMessages → setTimeout → processUpdateMessages)
    // cannot resurrect cleared messages when a transition starts between the
    // entry-point check and the deferred fire. This also catches synchronous
    // callers that bypass the entry point — addHistoryMessage / addUserMessage
    // already guard, but processUpdateMessages is the canonical setter and
    // should be self-defending.
    if (window.__sessionTransitioning) {
      return;
    }
    const minAcceptedSequence = window.__minAcceptedUpdateSequence ?? 0;
    if (sequence != null && sequence < minAcceptedSequence) {
      return;
    }

    try {
      // Reconstruct per-turn footer metadata (durationMs / turnUsage) for
      // settled turns in the snapshot — the persisted transcript carries
      // neither field, so reloaded sessions lost the duration/token footer.
      // The trailing turn is skipped while streaming: live stamping owns it.
      const parsed = reconstructTurnMetadata(
        JSON.parse(json) as ClaudeMessage[],
        { skipTrailingTurn: isStreamingRef.current },
      );
      if (sequence != null) {
        window.__minAcceptedUpdateSequence = Math.max(minAcceptedSequence, sequence);
      }

      setMessages((prev) => {
        // If streaming is active, delegate to the streaming logic
        if (isStreamingRef.current) {
          if (useBackendStreamingRenderRef.current) {
            let smartMerged = parsed.map((newMsg, i) => {
              if (i === parsed.length - 1) return newMsg;
              if (i < prev.length) {
                const oldMsg = prev[i];
                // Preserve frontend-only durationMs across backend updates
                if (typeof oldMsg.durationMs === 'number' && newMsg.type === 'assistant') {
                  newMsg = { ...newMsg, durationMs: oldMsg.durationMs };
                }
                if (
                  oldMsg.timestamp === newMsg.timestamp &&
                  oldMsg.type === newMsg.type &&
                  oldMsg.content === newMsg.content
                ) {
                  return oldMsg;
                }
              }
              return newMsg;
            });

            smartMerged = preserveLastAssistantIdentity(prev, smartMerged, findLastAssistantIndex);
            smartMerged = preserveStreamingAssistantContent(
              prev,
              smartMerged,
              isStreamingRef,
              streamingContentRef,
              findLastAssistantIndex,
              patchAssistantForStreaming,
            );
            const result = preserveLatestMessagesOnShrink(
              prev,
              appendOptimisticMessageIfMissing(prev, smartMerged),
              options.currentProviderRef.current,
            );

            // FIX: In Claude mode, update streamingMessageIndexRef so that
            // onContentDelta knows which assistant message to update.
            let lastAssistantIdx = findLastAssistantIndex(result);
            // Verify the found assistant belongs to the current streaming turn
            if (lastAssistantIdx >= 0 && streamingTurnIdRef.current > 0 &&
                result[lastAssistantIdx].__turnId !== streamingTurnIdRef.current) {
              // Scan for the correct turn ID match (from end, consistent with findLastAssistantIndex)
              for (let i = result.length - 1; i >= 0; i--) {
                if (result[i].type === 'assistant' && result[i].__turnId === streamingTurnIdRef.current) {
                  lastAssistantIdx = i;
                  break;
                }
              }
            }
            if (lastAssistantIdx >= 0) {
              streamingMessageIndexRef.current = lastAssistantIdx;

              // Always stamp __turnId so ensureStreamingAssistantPreserved can find it,
              // even before any content delta arrives (streamingContentRef may be empty).
              if (result[lastAssistantIdx]?.__turnId !== streamingTurnIdRef.current) {
                result[lastAssistantIdx] = {
                  ...result[lastAssistantIdx],
                  __turnId: streamingTurnIdRef.current,
                };
              }

              // FIX: If there is buffered streaming content (onContentDelta may
              // fire before updateMessages), apply it to the assistant message
              // immediately to prevent content loss.
              if (streamingContentRef.current && result[lastAssistantIdx]?.type === 'assistant') {
                const backendContent = result[lastAssistantIdx].content || '';
                if (streamingContentRef.current.length >= backendContent.length) {
                  result[lastAssistantIdx] = patchAssistantForStreaming({
                    ...result[lastAssistantIdx],
                    content: streamingContentRef.current,
                    isStreaming: true,
                  });
                } else {
                  // Backend has more complete content; sync buffer
                  streamingContentRef.current = backendContent;
                }
              }
            }

            return finalizeMessageList(prev, result);
          }

          const lastAssistantIdx = findLastAssistantIndex(parsed);
          if (lastAssistantIdx < 0) {
            return finalizeMessageList(
              prev,
              preserveLatestMessagesOnShrink(
                prev,
                appendOptimisticMessageIfMissing(prev, parsed),
                options.currentProviderRef.current,
              ),
            );
          }
        }

        // Non-streaming case (or streaming hasn't started yet)
        if (!isStreamingRef.current) {
          // Smart merge: reuse old message objects for performance
          let smartMerged = parsed.map((newMsg, i) => {
            if (i < prev.length) {
              const oldMsg = prev[i];
              // Preserve frontend-only durationMs across backend updates
              if (typeof oldMsg.durationMs === 'number' && newMsg.type === 'assistant') {
                newMsg = { ...newMsg, durationMs: oldMsg.durationMs };
              }
              if (i < parsed.length - 1) {
                if (
                  oldMsg.timestamp === newMsg.timestamp &&
                  oldMsg.type === newMsg.type &&
                  oldMsg.content === newMsg.content
                ) {
                  return oldMsg;
                }
              }
            }
            return newMsg;
          });

          smartMerged = preserveLastAssistantIdentity(prev, smartMerged, findLastAssistantIndex);
          smartMerged = preserveLatestMessagesOnShrink(prev, smartMerged, options.currentProviderRef.current);
          return finalizeMessageList(prev, appendOptimisticMessageIfMissing(prev, smartMerged));
        }

        // Streaming + !useBackendStreamingRender: always accept the backend snapshot
        // but preserve the streaming assistant's text content (which arrives via
        // onContentDelta and is more up-to-date than the coalesced snapshot).
        //
        // Previously this branch only accepted snapshots containing tool_use blocks,
        // which caused ALL updateMessages to be silently dropped during pure-text
        // streaming.  When onStreamEnd was subsequently lost (JCEF async chain),
        // the UI appeared permanently frozen.

        let patched = [...parsed];
        patched = appendOptimisticMessageIfMissing(prev, patched);
        patched = preserveLastAssistantIdentity(prev, patched, findLastAssistantIndex);
        patched = preserveStreamingAssistantContent(
          prev,
          patched,
          isStreamingRef,
          streamingContentRef,
          findLastAssistantIndex,
          patchAssistantForStreaming,
        );
        patched = preserveLatestMessagesOnShrink(prev, patched, options.currentProviderRef.current);

        const patchedAssistantIdx = findLastAssistantIndex(patched);
        if (patchedAssistantIdx >= 0 && patched[patchedAssistantIdx]?.type === 'assistant') {
          const patchedAssistant = patched[patchedAssistantIdx];
          const currentTurnId = streamingTurnIdRef.current;
          // Stale: backend snapshot hasn't caught up — findLastAssistantIndex returns prior turn's assistant
          const isStaleSnapshot = currentTurnId > 0 && patchedAssistant.__turnId !== undefined
            && patchedAssistant.__turnId !== currentTurnId;
          if (!isStaleSnapshot) {
            streamingMessageIndexRef.current = patchedAssistantIdx;
            patched[patchedAssistantIdx] = patchAssistantForStreaming({
              ...patchedAssistant,
              __turnId: currentTurnId,
            });
          }
        }

        // Only skip updates when neither message structure nor non-text raw blocks
        // changed. This keeps pure content_delta traffic cheap, while still
        // re-rendering when the backend injects tool_use/tool_result blocks into
        // an existing assistant message during streaming.
        // FIX: Also check thinking block content changes, as thinking blocks are
        // rendered in collapsible UI and need updates even when tool_use count is stable.
        const hasStructuralChange = patched.length !== prev.length ||
          patched.some((msg, i) => {
            if (i >= prev.length) return true;
            const prevMsg = prev[i];
            if (msg.type !== prevMsg.type || msg.timestamp !== prevMsg.timestamp) {
              return true;
            }
            // For assistant messages during streaming, also check thinking block changes
            if (msg.type === 'assistant' && prevMsg.type === 'assistant') {
              const prevBlocks = extractRawBlocks(prevMsg.raw);
              const newBlocks = extractRawBlocks(msg.raw);
              // Check if thinking block content changed
              const prevThinkingBlocks = prevBlocks.filter(
                (b): b is { type: 'thinking'; thinking?: string } => b?.type === 'thinking'
              );
              const newThinkingBlocks = newBlocks.filter(
                (b): b is { type: 'thinking'; thinking?: string } => b?.type === 'thinking'
              );
              if (prevThinkingBlocks.length !== newThinkingBlocks.length) return true;
              for (let j = 0; j < prevThinkingBlocks.length; j++) {
                const prevThinking = prevThinkingBlocks[j]?.thinking ?? '';
                const newThinking = newThinkingBlocks[j]?.thinking ?? '';
                if (prevThinking !== newThinking) return true;
              }
              // Check total block count change (new tool_use added)
              if (prevBlocks.length !== newBlocks.length) return true;
            }
            return getStructuralRawBlockSignature(msg, extractRawBlocks) !==
              getStructuralRawBlockSignature(prevMsg, extractRawBlocks);
          });
        if (!hasStructuralChange) {
          return prev;
        }

        return finalizeMessageList(prev, patched);
      });
    } catch (error) {
      console.error('[Frontend] Failed to parse messages:', error);
    }
  };

  window.updateMessages = (json, sequenceArg) => {
    // During session transition, ignore message updates from stale session
    // callbacks to prevent cleared messages from being restored
    if (window.__sessionTransitioning) return;
    const sequence = parseSequence(sequenceArg);
    const minAcceptedSequence = window.__minAcceptedUpdateSequence ?? 0;
    if (sequence != null && sequence < minAcceptedSequence) {
      return;
    }

    // FIX: Bump stream stall watchdog — receiving updateMessages proves the
    // backend→frontend bridge is alive even between content deltas (e.g.,
    // during tool execution phases where no text is produced).
    if (isStreamingRef.current && window.__lastStreamActivityAt !== undefined) {
      window.__lastStreamActivityAt = Date.now();
    }

    // During streaming, coalesce rapid updateMessages calls into one-per-frame.
    // The backend coalescer may push every 50ms; JSON.parse of large payloads
    // (100KB+ for long conversations) blocks the main thread and causes dropped
    // frames ("fake freeze"). Deferring to rAF ensures we only parse the latest
    // payload and yield to the browser between frames.
    if (isStreamingRef.current) {
      pendingUpdateJson = json;
      pendingUpdateSequence = sequence;
      window.__pendingUpdateJson = json;
      window.__pendingUpdateSequence = sequence;
      if (pendingUpdateRaf === null) {
        const timerId = setTimeout(() => {
          pendingUpdateRaf = null;
          window.__pendingUpdateRaf = null;
          const latestJson = pendingUpdateJson;
          const latestSequence = pendingUpdateSequence;
          pendingUpdateJson = null;
          pendingUpdateSequence = null;
          window.__pendingUpdateJson = null;
          window.__pendingUpdateSequence = null;
          // A session transition may have begun while this frame was buffered.
          // processUpdateMessages re-checks the transition guard itself now, so
          // this early return is defense-in-depth — without either check, a
          // stale snapshot deferred during the outgoing session's streaming
          // would run down the non-streaming path (isStreamingRef was cleared
          // by beginSessionTransition) and resurrect the cleared messages.
          if (window.__sessionTransitioning) return;
          if (latestJson) {
            processUpdateMessages(latestJson, latestSequence);
          }
        }, 16);
        pendingUpdateRaf = timerId as unknown as number;
        window.__pendingUpdateRaf = timerId as unknown as number;
      }
      return;
    }

    processUpdateMessages(json, sequence);
  };

  const pendingMessages = (window as unknown as Record<string, unknown>).__pendingUpdateMessages;
  if (typeof pendingMessages === 'string' && pendingMessages.length > 0) {
    delete (window as unknown as Record<string, unknown>).__pendingUpdateMessages;
    window.updateMessages(pendingMessages);
  } else if (
    pendingMessages &&
    typeof pendingMessages === 'object' &&
    typeof (pendingMessages as { json?: unknown }).json === 'string'
  ) {
    delete (window as unknown as Record<string, unknown>).__pendingUpdateMessages;
    const payload = pendingMessages as { json: string; sequence?: number | null };
    window.updateMessages(payload.json, payload.sequence ?? undefined);
  }

  window.updateStatus = (text) => {
    // Do not release the transition guard from generic status updates.
    setStatus(text);
    if (suppressNextStatusToastRef.current) {
      suppressNextStatusToastRef.current = false;
      return;
    }
    addToast(text);
  };

  window.showLoading = (value) => {
    const isLoading = isTruthy(value);

    // FIX: Ignore loading=false during streaming — onStreamEnd handles it uniformly.
    if (!isLoading && isStreamingRef.current) {
      return;
    }

    // Notify backend about loading state change for tab indicator
    sendBridgeEvent('tab_loading_changed', JSON.stringify({ loading: isLoading }));

    setLoading((prevLoading) => {
      if (isLoading) {
        if (!prevLoading) {
          setLoadingStartTime(Date.now());
        }
      } else {
        // Stamp durationMs on the last assistant message when loading ends.
        // Skip if onStreamEnd already stamped it (avoids double-write race).
        setLoadingStartTime((prevStartTime) => {
          if (prevStartTime != null) {
            const durationMs = Date.now() - prevStartTime;
            setMessages((prev) => {
              for (let i = prev.length - 1; i >= 0; i--) {
                if (prev[i].type === 'assistant') {
                  if (typeof prev[i].durationMs === 'number') return prev;
                  const next = [...prev];
                  next[i] = { ...next[i], durationMs };
                  return next;
                }
              }
              return prev;
            });
          }
          return null;
        });
      }
      return isLoading;
    });
  };

  window.showThinkingStatus = (value) => setIsThinking(isTruthy(value));
  window.showSummary = (summary) => {
    if (!summary || !summary.trim()) return;
    setStatus(summary);
  };
  window.setHistoryData = (data) => setHistoryData(data);

  const pendingStatus = (window as unknown as Record<string, unknown>).__pendingStatusText;
  if (typeof pendingStatus === 'string' && pendingStatus.length > 0) {
    delete (window as unknown as Record<string, unknown>).__pendingStatusText;
    window.updateStatus?.(pendingStatus);
  }

  const pendingLoading = window.__pendingLoadingState;
  if (typeof pendingLoading === 'boolean') {
    delete window.__pendingLoadingState;
    window.showLoading?.(pendingLoading);
  }

  const pendingUserMessage = window.__pendingUserMessage;
  if (typeof pendingUserMessage === 'string' && pendingUserMessage.length > 0) {
    delete window.__pendingUserMessage;
    window.addUserMessage?.(pendingUserMessage);
  }

  const pendingSummary = (window as unknown as Record<string, unknown>).__pendingSummaryText;
  if (typeof pendingSummary === 'string' && pendingSummary.length > 0) {
    delete (window as unknown as Record<string, unknown>).__pendingSummaryText;
    window.showSummary?.(pendingSummary);
  }

  window.patchMessageUuid = (content, uuid) => {
    if (window.__sessionTransitioning) return;
    if (!content || !uuid) return;

    setMessages((prev) => {
      for (let i = prev.length - 1; i >= 0; i -= 1) {
        const message = prev[i];
        if (message.type !== 'user') continue;
        if (getRawUuid(message)) continue;

        const rawText = extractRawBlocks(message.raw)
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => String(block.text))
          .join('\n');
        if ((message.content || '') !== content && rawText !== content) continue;

        const raw: ClaudeMessage['raw'] =
          typeof message.raw === 'object' && message.raw
            ? { ...message.raw, uuid }
            : {
                uuid,
                message: {
                  content: [{ type: 'text' as const, text: message.content || content }],
                },
              };

        const next = [...prev];
        next[i] = {
          ...message,
          raw,
        };
        return next;
      }

      console.debug('[patchMessageUuid] no matching unresolved user message found for content:', content);
      return prev;
    });
  };

  window.clearMessages = (barrierSequenceArg) => {
    // Advance the sequence barrier so any updateMessages still in flight from
    // the previous session are rejected. Such a snapshot may already have been
    // dispatched to JS and be sitting in the JCEF IPC channel, so neither the
    // backend's post-reset sequence check nor the __sessionTransitioning
    // time-window guard can stop it once that guard is released. The barrier is
    // the backend coalescer's post-reset updateSequence; stale snapshots carry a
    // strictly smaller sequence. Closes the "new session does not clear" race.
    const barrierSequence = parseSequence(barrierSequenceArg);
    if (barrierSequence != null) {
      window.__minAcceptedUpdateSequence = Math.max(
        window.__minAcceptedUpdateSequence ?? 0,
        barrierSequence,
      );
    }
    // Cancel any pending deferred updateMessages to prevent stale data from
    // being applied after messages are cleared.
    if (pendingUpdateRaf !== null) {
      clearTimeout(pendingUpdateRaf);
      pendingUpdateRaf = null;
      pendingUpdateJson = null;
      pendingUpdateSequence = null;
      window.__pendingUpdateRaf = null;
      window.__pendingUpdateJson = null;
      window.__pendingUpdateSequence = null;
    }
    window.__deniedToolIds?.clear();
    resetTransientUiState();
    closeContextUsageDialog();
    setMessages([]);
  };

  window.addErrorMessage = (message) => {
    addToast(message, 'error');
  };

  window.showContextUsageDialog = (json: string) => {
    try {
      const result = JSON.parse(json);
      const requestId = typeof result.requestId === 'string' ? result.requestId : null;
      const data: ContextUsageData = result.data || result;
      if (result.success === false) {
        if (closeContextUsageDialog(requestId)) {
          addToast(result.error || 'Failed to get context usage', 'error');
        }
        return;
      }
      updateContextUsageData(requestId, data);
    } catch (e) {
      debugError('[ContextUsage] Failed to parse context usage result:', e);
      closeContextUsageDialog();
      addToast('Failed to parse context usage data', 'error');
    }
  };

  window.onContextUsageError = (message: string, requestId?: string) => {
    if (closeContextUsageDialog(requestId)) {
      addToast(message, 'error');
    }
  };

  window.addHistoryMessage = (message: ClaudeMessage) => {
    if (window.__sessionTransitioning) return;
    setMessages((prev) => [...prev, message]);
  };

  // History load complete callback — triggers Markdown re-rendering
  // Use full shallow copy to ensure all messages trigger re-render regardless of batching timing
  // Also clear stream-ended markers since history messages don't have __turnId
  window.historyLoadComplete = () => {
    releaseSessionTransition();
    const pendingToast = window.__pendingSessionTransitionToast;
    if (pendingToast) {
      window.__pendingSessionTransitionToast = undefined;
      addToast(pendingToast.message, pendingToast.type);
    }
    window.__lastStreamEndedTurnId = undefined;
    window.__lastStreamEndedAt = undefined;
    // FIX: A replayed session may include aborted turns where some function_call
    // entries never received a function_call_output (user pressed STOP, write_stdin
    // was filtered out, etc.). Without this scan, BashToolGroupBlock / EditToolGroupBlock
    // render those tool_use blocks as perpetual loading spinners because parseBashItem
    // treats `result == null` as "still running". onStreamEnd is NEVER fired during
    // history replay, so the equivalent cleanup there does not help here.
    if (!window.__deniedToolIds) {
      window.__deniedToolIds = new Set<string>();
    }
    // Compute orphans inside the updater (needs the latest message list) but keep
    // the __deniedToolIds mutation OUTSIDE it — a setMessages updater must stay
    // pure, and React StrictMode double-invokes it. Mirrors onStreamEnd's pattern.
    let orphanIds: string[] = [];
    setMessages((prev) => {
      if (prev.length === 0) return prev;
      orphanIds = collectUnresolvedToolUseIds(prev, 'all');
      // Shallow copy forces ChatMessages to re-render so the now-denied IDs are
      // picked up by BashToolGroupBlock's deniedToolIds prop.
      return prev.map(m => ({ ...m }));
    });
    for (const id of orphanIds) {
      window.__deniedToolIds.add(id);
    }
  };

  window.addUserMessage = (content: string) => {
    if (window.__sessionTransitioning) return;
    const userMessage: ClaudeMessage = {
      type: 'user',
      content: content || '',
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => {
      // If the last message is an optimistic message with matching content,
      // skip adding — the frontend already rendered the optimistic copy.
      // Otherwise addUserMessage + optimistic create a brief duplicate until
      // the next updateMessages deduplicates them.
      const lastMsg = prev[prev.length - 1];
      if (lastMsg?.isOptimistic && lastMsg.type === 'user' && lastMsg.content === content) {
        return prev;
      }
      return [...prev, userMessage];
    });
    userPausedRef.current = false;
    isUserAtBottomRef.current = true;
    requestAnimationFrame(() => {
      if (messagesContainerRef.current) {
        messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
      }
    });
  };

}
