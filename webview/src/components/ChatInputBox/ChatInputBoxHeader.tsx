import type { TFunction } from 'i18next';
import type { Attachment, SelectedAgent, QueuedMessage } from './types.js';
import { AttachmentList } from './AttachmentList.js';
import { ContextBar } from './ContextBar.js';
import { MessageQueue } from './MessageQueue.js';
import { openBrowser, GITHUB_REPO_URL } from '../../utils/bridge';

export function ChatInputBoxHeader({
  sdkStatusLoading,
  sdkStatusError,
  sdkInstalled,
  currentProvider,
  onRetrySdkStatus,
  onInstallSdk,
  t,
  attachments,
  onRemoveAttachment,
  activeFile,
  selectedLines,
  usagePercentage,
  usageUsedTokens,
  usageMaxTokens,
  showUsage,
  onClearContext,
  onAddAttachment,
  selectedAgent,
  onClearAgent,
  hasMessages,
  onRewind,
  statusPanelExpanded,
  onToggleStatusPanel,
  messageQueue,
  onRemoveFromQueue,
  showOpenSourceBanner,
  onDismissOpenSourceBanner,
  autoOpenFileEnabled,
  onRequestEnableFileContext,
}: {
  sdkInstalled: boolean;
  sdkStatusLoading: boolean;
  sdkStatusError: boolean;
  currentProvider: string;
  onRetrySdkStatus?: () => void;
  onInstallSdk?: () => void;
  t: TFunction;
  attachments: Attachment[];
  onRemoveAttachment: (id: string) => void;
  activeFile?: string;
  selectedLines?: string;
  usagePercentage: number;
  usageUsedTokens?: number;
  usageMaxTokens?: number;
  showUsage: boolean;
  onClearContext?: () => void;
  onAddAttachment: (files: FileList) => void;
  selectedAgent?: SelectedAgent | null;
  onClearAgent: () => void;
  hasMessages: boolean;
  onRewind?: () => void;
  statusPanelExpanded: boolean;
  onToggleStatusPanel?: () => void;
  messageQueue?: QueuedMessage[];
  onRemoveFromQueue?: (id: string) => void;
  showOpenSourceBanner?: boolean;
  onDismissOpenSourceBanner?: () => void;
  autoOpenFileEnabled?: boolean;
  onRequestEnableFileContext?: () => void;
}) {
  const handleStarProject = () => {
    openBrowser(GITHUB_REPO_URL);
  };

  return (
    <>
      {/* Open source banner */}
      {showOpenSourceBanner && (
        <div className="open-source-banner">
          <span className="banner-text">{t('chat.openSourceBanner')}</span>
          <button
            type="button"
            className="banner-star"
            aria-label={t('chat.openSourceBannerStarAria')}
            onClick={(e) => {
              e.stopPropagation();
              handleStarProject();
            }}
          >
            <svg className="star-icon" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path d="M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.9l-5.8 3.05 1.11-6.46-4.7-4.58 6.49-.94z" />
            </svg>
            <span className="banner-star-text">{t('chat.openSourceBannerStar')}</span>
          </button>
          <button
            className="banner-close"
            aria-label="Close"
            onClick={(e) => {
              e.stopPropagation();
              onDismissOpenSourceBanner?.();
            }}
          >
            &#x2715;
          </button>
        </div>
      )}

      {/* SDK status loading, query error, or not installed warning bar */}
      {(sdkStatusLoading || sdkStatusError || !sdkInstalled) && (
        <div className={`sdk-warning-bar ${sdkStatusLoading ? 'sdk-loading' : ''}`}>
          <span
            className={`codicon ${sdkStatusLoading ? 'codicon-loading codicon-modifier-spin' : 'codicon-warning'}`}
          />
          <span className="sdk-warning-text">
            {sdkStatusLoading
              ? t('chat.sdkStatusLoading')
              : sdkStatusError
                ? t('chat.sdkStatusUnavailable')
              : t('chat.sdkNotInstalled', {
                  provider: currentProvider === 'codex' ? 'Codex' : currentProvider === 'codebuddy' ? 'CodeBuddy' : 'Claude Code',
                })}
          </span>
          {sdkStatusError ? (
            <button
              className="sdk-install-btn"
              onClick={(e) => {
                e.stopPropagation();
                onRetrySdkStatus?.();
              }}
            >
              <span className="codicon codicon-refresh" />
              <span>{t('chat.retrySdkStatus')}</span>
            </button>
          ) : !sdkStatusLoading && (
            <button
              className="sdk-install-btn"
              onClick={(e) => {
                e.stopPropagation();
                onInstallSdk?.();
              }}
            >
              {t('chat.goInstallSdk')}
            </button>
          )}
        </div>
      )}

      {/* Message queue */}
      {messageQueue && messageQueue.length > 0 && (
        <MessageQueue
          queue={messageQueue}
          onRemove={onRemoveFromQueue ?? (() => {})}
        />
      )}

      {/* Attachment list */}
      {attachments.length > 0 && (
        <AttachmentList attachments={attachments} onRemove={onRemoveAttachment} />
      )}

      {/* Context bar (Top Control Bar) */}
      <ContextBar
        activeFile={activeFile}
        selectedLines={selectedLines}
        percentage={usagePercentage}
        usedTokens={usageUsedTokens}
        maxTokens={usageMaxTokens}
        showUsage={showUsage}
        onClearFile={onClearContext}
        onAddAttachment={onAddAttachment}
        selectedAgent={selectedAgent}
        onClearAgent={onClearAgent}
        currentProvider={currentProvider}
        hasMessages={hasMessages}
        onRewind={onRewind}
        statusPanelExpanded={statusPanelExpanded}
        onToggleStatusPanel={onToggleStatusPanel}
        autoOpenFileEnabled={autoOpenFileEnabled}
        onRequestEnableFileContext={onRequestEnableFileContext}
      />
    </>
  );
}
