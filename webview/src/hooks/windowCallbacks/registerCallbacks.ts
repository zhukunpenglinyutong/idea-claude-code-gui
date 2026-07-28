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
import { parseTaskNotification } from '../../utils/taskEventParser';
import { deepEqual } from '../../utils/deepEqual';
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

function areSubagentMessagesEquivalent(previousMessages: unknown[] | undefined, nextMessages: unknown[] | undefined): boolean {
  if (previousMessages === nextMessages) return true;
  return deepEqual(previousMessages, nextMessages);
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

  // task_* SDK system events signal the lifecycle of a background Agent
  // (Agent/Task tool invoked with run_in_background:true). Only
  // task_notification carries a terminal status; task_started / task_progress
  // merely announce progress and must not flip the running state. Without
  // this, the StatusPanel cannot tell a launched async agent from a finished
  // one, and the completion summary never surfaces.
  //
  // Cross-session safety is enforced by three layers, so this handler does
  // not re-check sessionId (which is not part of the taskEvent payload):
  //   1. Java ClaudeChatWindow.titleEventListener drops events whose sessionId
  //      does not match the active session.
  //   2. beginSessionTransition (useSessionManagement) clears taskEvents on
  //      session switch, so stale entries from the prior session cannot linger.
  //   3. tool_use_ids are globally unique, so even a delayed event can only
  //      update the agent it was emitted for, never mislabel another.
  window.onTaskEvent = (eventJson: string) => {
    try {
      if (!options.setTaskEvents) return;
      const taskEvent = parseTaskNotification(JSON.parse(eventJson));
      if (!taskEvent) return;
      const { toolUseId } = taskEvent;
      options.setTaskEvents((prev) => {
        const existing = prev[toolUseId];
        // Dedup: skip the state update when no observable field changed. Include
        // agentId/outputFilePath so a follow-up event that adds the sidechain
        // transcript path still lands (task_notification is terminal, but a
        // late output_file attachment would otherwise be swallowed).
        if (existing
          && existing.status === taskEvent.status
          && existing.summary === taskEvent.summary
          && existing.totalTokens === taskEvent.totalTokens
          && existing.totalToolUseCount === taskEvent.totalToolUseCount
          && existing.totalDurationMs === taskEvent.totalDurationMs
          && existing.agentId === taskEvent.agentId
          && existing.outputFilePath === taskEvent.outputFilePath) {
          return prev;
        }
        return { ...prev, [toolUseId]: taskEvent };
      });
    } catch {
      // Ignore malformed task event payloads. A task_notification is terminal,
      // so a dropped event is not retried - but a later task_progress /
      // task_notification for the same tool_use_id will still land and update
      // the entry, so the subagent list is not permanently stuck.
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
