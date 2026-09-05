import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { MutableRefObject, RefObject } from 'react';
import type { ClaudeMessage, ClaudeRawMessage, HistoryData, SubagentHistoryResponse, TaskEventMap } from '../types';
import type {
  CodexFastMode,
  PermissionMode,
  ReasoningEffort,
  SelectedAgent,
} from '../components/ChatInputBox/types';
import type { ProviderConfig } from '../types/provider';
import type { PermissionRequest } from '../components/PermissionDialog';
import type { AskUserQuestionRequest } from '../components/AskUserQuestionDialog';
import type { PlanApprovalRequest } from '../components/PlanApprovalDialog';
import type { RewindRequest } from '../components/RewindDialog';
import { registerWindowCallbacks } from './windowCallbacks/registerCallbacks';
import { sendBridgeEvent } from '../utils/bridge';

// Re-export from messageSync to avoid duplicate definition
export { OPTIMISTIC_MESSAGE_TIME_WINDOW } from './windowCallbacks/messageSync';

export interface ContextInfo {
  file: string;
  startLine?: number;
  endLine?: number;
  raw: string;
}

export interface UseWindowCallbacksOptions {
  t: TFunction;
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  clearToasts: () => void;

  // State setters
  setMessages: React.Dispatch<React.SetStateAction<ClaudeMessage[]>>;
  setStatus: React.Dispatch<React.SetStateAction<string>>;
  setLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setLoadingStartTime: React.Dispatch<React.SetStateAction<number | null>>;
  setIsThinking: React.Dispatch<React.SetStateAction<boolean>>;
  setExpandedThinking?: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  setStreamingActive: React.Dispatch<React.SetStateAction<boolean>>;
  setHistoryData: React.Dispatch<React.SetStateAction<HistoryData | null>>;
  setCurrentSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  setUsagePercentage: React.Dispatch<React.SetStateAction<number>>;
  setUsageUsedTokens: React.Dispatch<React.SetStateAction<number | undefined>>;
  setUsageMaxTokens: React.Dispatch<React.SetStateAction<number | undefined>>;
  setPermissionMode: React.Dispatch<React.SetStateAction<PermissionMode>>;
  setCurrentProvider: React.Dispatch<React.SetStateAction<string>>;
  setClaudePermissionMode: React.Dispatch<React.SetStateAction<PermissionMode>>;
  setCodexPermissionMode: React.Dispatch<React.SetStateAction<PermissionMode>>;
  setCodeBuddyPermissionMode: React.Dispatch<React.SetStateAction<PermissionMode>>;
  setSelectedClaudeModel: React.Dispatch<React.SetStateAction<string>>;
  setSelectedCodexModel: React.Dispatch<React.SetStateAction<string>>;
  setSelectedCodeBuddyModel: React.Dispatch<React.SetStateAction<string>>;
  setLongContextEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setReasoningEffort: React.Dispatch<React.SetStateAction<ReasoningEffort>>;
  setCodexFastMode: React.Dispatch<React.SetStateAction<CodexFastMode>>;
  setProviderConfigVersion: React.Dispatch<React.SetStateAction<number>>;
  setActiveProviderConfig: React.Dispatch<React.SetStateAction<ProviderConfig | null>>;
  setClaudeSettingsAlwaysThinkingEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setStreamingEnabledSetting: React.Dispatch<React.SetStateAction<boolean>>;
  setSendShortcut: React.Dispatch<React.SetStateAction<'enter' | 'cmdEnter'>>;
  setAutoOpenFileEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  setPermissionDialogTimeoutSeconds: React.Dispatch<React.SetStateAction<number>>;
  setSdkStatus: React.Dispatch<React.SetStateAction<Record<string, { installed?: boolean; status?: string }>>>;
  setSdkStatusLoaded: React.Dispatch<React.SetStateAction<boolean>>;
  setSdkStatusError: React.Dispatch<React.SetStateAction<string | null>>;
  setIsRewinding: (loading: boolean) => void;
  setRewindDialogOpen: (open: boolean) => void;
  setCurrentRewindRequest: (request: RewindRequest | null) => void;
  setContextInfo: React.Dispatch<React.SetStateAction<ContextInfo | null>>;
  setSelectedAgent: React.Dispatch<React.SetStateAction<SelectedAgent | null>>;
  setSubagentHistories?: React.Dispatch<React.SetStateAction<Record<string, SubagentHistoryResponse>>>;
  setTaskEvents?: React.Dispatch<React.SetStateAction<TaskEventMap>>;

  // Refs
  currentProviderRef: MutableRefObject<string>;
  messagesContainerRef: RefObject<HTMLDivElement | null>;
  isUserAtBottomRef: MutableRefObject<boolean>;
  userPausedRef: MutableRefObject<boolean>;
  suppressNextStatusToastRef: MutableRefObject<boolean>;

  // Streaming refs from useStreamingMessages
  streamingContentRef: MutableRefObject<string>;
  streamingThinkingRef: MutableRefObject<string>;
  isStreamingRef: MutableRefObject<boolean>;
  useBackendStreamingRenderRef: MutableRefObject<boolean>;
  autoExpandedThinkingKeysRef: MutableRefObject<Set<string>>;
  streamingMessageIndexRef: MutableRefObject<number>;
  streamingTurnIdRef: MutableRefObject<number>;
  turnIdCounterRef: MutableRefObject<number>;
  lastContentUpdateRef: MutableRefObject<number>;
  contentUpdateTimeoutRef: MutableRefObject<number | null>;
  lastThinkingUpdateRef: MutableRefObject<number>;
  thinkingUpdateTimeoutRef: MutableRefObject<number | null>;

  // Functions from useStreamingMessages
  findLastAssistantIndex: (messages: ClaudeMessage[]) => number;
  extractRawBlocks: (raw: ClaudeRawMessage | string | undefined) => Array<Record<string, unknown>>;
  getOrCreateStreamingAssistantIndex: (messages: ClaudeMessage[]) => number;
  patchAssistantForStreaming: (msg: ClaudeMessage) => ClaudeMessage;

  // Other functions
  syncActiveProviderModelMapping: (provider: ProviderConfig) => void;

  // Permission dialog handlers from useDialogManagement
  openPermissionDialog: (request: PermissionRequest) => void;
  openAskUserQuestionDialog: (request: AskUserQuestionRequest) => void;
  openPlanApprovalDialog: (request: PlanApprovalRequest) => void;
  forceClosePermissionDialog: (channelId?: string | null) => void;
  forceCloseAskUserQuestionDialog: (requestId?: string | null) => void;
  forceClosePlanApprovalDialog: (requestId?: string | null) => void;
  openContextUsageDialog: (requestId?: string | null, loading?: boolean) => void;
  updateContextUsageData: (
    requestId: string | null | undefined,
    data: import('../components/ContextUsageDialog').ContextUsageData,
  ) => boolean;
  closeContextUsageDialog: (requestId?: string | null) => boolean;

  // B-011: Title migration on session ID change
  customSessionTitleRef: MutableRefObject<string | null>;
  currentSessionIdRef: MutableRefObject<string | null>;
  updateHistoryTitle: (sessionId: string, newTitle: string) => void;
  applyHistoryTitleLocal: (sessionId: string, newTitle: string) => void;

  // AI title generation: update the displayed session title when backend generates one
  setCustomSessionTitle: React.Dispatch<React.SetStateAction<string | null>>;
}

export function useWindowCallbacks(options: UseWindowCallbacksOptions): void {
  const { t } = options;
  const [historyRenderCommitEpoch, setHistoryRenderCommitEpoch] = useState(0);

  // Store t in ref to avoid stale closures
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  useEffect(() => {
    registerWindowCallbacks(options, tRef, setHistoryRenderCommitEpoch);
    // Callbacks are registered once on mount; re-registration would cause duplicate handlers.
    // Options object reference is intentionally excluded from deps.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // This signal means only that React committed the restored message tree. Native OSR
  // publication is fenced separately by Java using real OnPaint callbacks.
  useLayoutEffect(() => {
    if (
      historyRenderCommitEpoch > 0
      && window.__historySurfaceRefreshEpoch === historyRenderCommitEpoch
    ) {
      sendBridgeEvent('history_dom_committed', String(historyRenderCommitEpoch));
    }
    return undefined;
  }, [historyRenderCommitEpoch]);
}
