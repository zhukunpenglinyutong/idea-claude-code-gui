/**
 * registerCallbacks.ts
 *
 * Single entry point that mounts all window bridge callbacks.  Called once
 * inside useWindowCallbacks' useEffect.  Receives the full options bag from
 * the hook rather than individual parameters to keep the call-site tidy.
 *
 * Pure functions have been extracted to messageSync.ts / sessionTransition.ts /
 * settingsBootstrap.ts; callback groups are further split into dedicated
 * sub-modules under registerCallbacks/ for easier navigation and maintenance.
 */

import type { MutableRefObject } from 'react';
import type { UseWindowCallbacksOptions } from '../useWindowCallbacks';
import {
  setupSlashCommandsCallback,
  resetSlashCommandsState,
  resetFileReferenceState,
  setupDollarCommandsCallback,
  resetDollarCommandsState,
} from '../../components/ChatInputBox/providers';
import { buildResetTransientUiState } from './sessionTransition';
import {
  startActiveProviderRequest,
  startModeRequest,
  startThinkingEnabledRequest,
} from './settingsBootstrap';
import { registerMessageCallbacks } from './registerCallbacks/messageCallbacks';
import { registerStreamingCallbacks } from './registerCallbacks/streamingCallbacks';
import { registerSessionAndSdkCallbacks } from './registerCallbacks/sessionCallbacks';
import { registerUsageModeCallbacks } from './registerCallbacks/usageModeCallbacks';
import { registerPermissionCallbacks } from './registerCallbacks/permissionCallbacks';
import { registerAgentAndSelectionCallbacks } from './registerCallbacks/agentCallbacks';

function areSubagentMessagesEquivalent(previousMessages?: unknown[], nextMessages?: unknown[]): boolean {
  if (previousMessages === nextMessages) return true;
  if (!Array.isArray(previousMessages) || !Array.isArray(nextMessages)) {
    return previousMessages === nextMessages;
  }
  if (previousMessages.length !== nextMessages.length) return false;

  // NOTE: Uses JSON.stringify for shallow deep-equality check.
  // Acceptable for cache invalidation; key order divergence between code paths
  // produces false negatives that just trigger re-render (safe degradation).
  try {
    return JSON.stringify(previousMessages) === JSON.stringify(nextMessages);
  } catch {
    return false;
  }
}

export function registerWindowCallbacks(
  options: UseWindowCallbacksOptions,
  tRef: MutableRefObject<UseWindowCallbacksOptions['t']>,
): void {
  // -------------------------------------------------------------------------
  // Session transition helpers
  // -------------------------------------------------------------------------

  const resetTransientUiState = buildResetTransientUiState({
    clearToasts: options.clearToasts,
    setStatus: options.setStatus,
    setLoading: options.setLoading,
    setLoadingStartTime: options.setLoadingStartTime,
    setIsThinking: options.setIsThinking,
    setStreamingActive: options.setStreamingActive,
    isStreamingRef: options.isStreamingRef,
    useBackendStreamingRenderRef: options.useBackendStreamingRenderRef,
    streamingMessageIndexRef: options.streamingMessageIndexRef,
    streamingContentRef: options.streamingContentRef,
    streamingThinkingRef: options.streamingThinkingRef,
    autoExpandedThinkingKeysRef: options.autoExpandedThinkingKeysRef,
    contentUpdateTimeoutRef: options.contentUpdateTimeoutRef,
    thinkingUpdateTimeoutRef: options.thinkingUpdateTimeoutRef,
    streamingTurnIdRef: options.streamingTurnIdRef,
  });

  // Expose as single entry point for session transition cleanup.
  // beginSessionTransition (useSessionManagement) calls this to synchronously
  // clear both React state AND internal refs in one shot.
  window.__resetTransientUiState = resetTransientUiState;

  // =========================================================================
  // Register callback groups
  // =========================================================================

  registerMessageCallbacks(options, resetTransientUiState);
  registerStreamingCallbacks(options);
  registerSessionAndSdkCallbacks(options, tRef);
  registerUsageModeCallbacks(options);
  registerPermissionCallbacks(options);
  registerAgentAndSelectionCallbacks(options);

  window.onSubagentHistoryLoaded = (json: string) => {
    try {
      if (!options.setSubagentHistories) return;
      const result = JSON.parse(json);
      const key = result.toolUseId || result.agentId;
      if (!key) return;
      options.setSubagentHistories((prev) => {
        const existing = prev[key];
        // Skip state update when the payload is structurally identical.
        // This prevents cascading re-renders and scroll jumps caused by
        // periodic subagent polling (every 2 s) returning unchanged data.
        if (existing && existing.success === result.success
          && existing.error === result.error
          && existing.sessionId === result.sessionId
          && existing.toolUseId === result.toolUseId
          && existing.agentId === result.agentId
          && existing.truncated === result.truncated
          && areSubagentMessagesEquivalent(existing.messages, result.messages)) {
          return prev;
        }
        return { ...prev, [key]: result };
      });
    } catch {
      // Ignore malformed callback payloads; the request can be retried by reopening the Agent row.
    }
  };

  // =========================================================================
  // Slash Commands Setup
  // =========================================================================

  resetSlashCommandsState();
  resetDollarCommandsState();
  resetFileReferenceState();
  setupSlashCommandsCallback();
  setupDollarCommandsCallback();

  // =========================================================================
  // Request Initial States
  // =========================================================================

  startActiveProviderRequest();
  startModeRequest();
  startThinkingEnabledRequest();
}
