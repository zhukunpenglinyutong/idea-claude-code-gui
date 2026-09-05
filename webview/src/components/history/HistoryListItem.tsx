import { memo, useCallback } from 'react';
import type { TFunction } from 'i18next';
import type { HistorySessionSummary } from '../../types';
import { extractCommandMessageContent } from '../../utils/messageUtils';
import { ProviderModelIcon } from '../shared/ProviderModelIcon';

// Module-level style constants (avoid breaking memoization)
const PROVIDER_BADGE_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  marginRight: '8px',
  verticalAlign: 'middle',
};

const HIGHLIGHT_MARK_STYLE: React.CSSProperties = {
  backgroundColor: '#ffd700',
  color: '#000',
  padding: '0 2px',
};

export const formatTimeAgo = (timestamp: string | undefined, t: (key: string) => string) => {
  if (!timestamp) {
    return '';
  }
  const seconds = Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000);
  const units: [number, string][] = [
    [31536000, t('history.timeAgo.yearsAgo')],
    [2592000, t('history.timeAgo.monthsAgo')],
    [86400, t('history.timeAgo.daysAgo')],
    [3600, t('history.timeAgo.hoursAgo')],
    [60, t('history.timeAgo.minutesAgo')],
  ];

  for (const [unitSeconds, label] of units) {
    const interval = Math.floor(seconds / unitSeconds);
    if (interval >= 1) {
      return `${interval} ${label}`;
    }
  }
  return `${Math.max(seconds, 1)} ${t('history.timeAgo.secondsAgo')}`;
};

export const formatFileSize = (bytes: number | undefined): { text: string; isMB: boolean } => {
  if (!bytes || bytes === 0) {
    return { text: '0 KB', isMB: false };
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return { text: `${kb.toFixed(1)} KB`, isMB: false };
  }
  const mb = kb / 1024;
  return { text: `${mb.toFixed(1)} MB`, isMB: true };
};

// Highlight matching text within a label
export const highlightText = (text: string, query: string) => {
  if (!query.trim()) {
    return <span>{text}</span>;
  }

  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const index = lowerText.indexOf(lowerQuery);

  if (index === -1) {
    return <span>{text}</span>;
  }

  const before = text.slice(0, index);
  const match = text.slice(index, index + query.length);
  const after = text.slice(index + query.length);

  return (
    <span>
      {before}
      <mark style={HIGHLIGHT_MARK_STYLE}>{match}</mark>
      {after}
    </span>
  );
};

export const stopPropagationHandler = (e: React.MouseEvent) => {
  e.stopPropagation();
};

// Entrypoints the backend conversion service actually knows how to rewrite
// (SessionConversionService only matches sdk-cli / claude-vscode patterns).
const CONVERTIBLE_ENTRYPOINTS = new Set(['sdk-cli', 'claude-vscode']);

export interface HistoryListItemProps {
  session: HistorySessionSummary;
  isEditing: boolean;
  isSelected: boolean;
  isSelectionMode: boolean;
  isCopied: boolean;
  isCopyFailed: boolean;
  isActiveSession: boolean;
  editingTitle: string;
  searchQuery: string;
  t: TFunction;
  onItemClick: (session: HistorySessionSummary, isEditing: boolean) => void;
  onSelectionToggle: (sessionId: string) => void;
  onEditStart: (sessionId: string, currentTitle: string) => void;
  onEditSave: (sessionId: string, title: string) => void;
  onEditCancel: () => void;
  onEditTitleChange: (value: string) => void;
  onExport: (sessionId: string, title: string) => void;
  onDelete: (sessionId: string) => void;
  onFavorite: (sessionId: string) => void;
  onCopySessionId: (sessionId: string) => void;
  onConvertToCliSession: (sessionId: string) => void;
}

export const HistoryListItem = memo(({
  session,
  isEditing,
  isSelected,
  isSelectionMode,
  isCopied,
  isCopyFailed,
  isActiveSession,
  editingTitle,
  searchQuery,
  t,
  onItemClick,
  onSelectionToggle,
  onEditStart,
  onEditSave,
  onEditCancel,
  onEditTitleChange,
  onExport,
  onDelete,
  onFavorite,
  onCopySessionId,
  onConvertToCliSession,
}: HistoryListItemProps) => {
  const handleRowClick = useCallback(() => {
    onItemClick(session, isEditing);
  }, [onItemClick, session, isEditing]);

  const handleCheckboxChange = useCallback(() => {
    onSelectionToggle(session.sessionId);
  }, [onSelectionToggle, session.sessionId]);

  const handleEditStart = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onEditStart(session.sessionId, session.title);
  }, [onEditStart, session.sessionId, session.title]);

  const handleEditSave = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    onEditSave(session.sessionId, editingTitle);
  }, [onEditSave, session.sessionId, editingTitle]);

  const handleEditCancel = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
    e.stopPropagation();
    onEditCancel();
  }, [onEditCancel]);

  const handleEditChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onEditTitleChange(e.target.value);
  }, [onEditTitleChange]);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      handleEditSave(e);
    } else if (e.key === 'Escape') {
      handleEditCancel(e);
    }
  }, [handleEditSave, handleEditCancel]);

  const handleExport = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onExport(session.sessionId, session.title);
  }, [onExport, session.sessionId, session.title]);

  const handleDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete(session.sessionId);
  }, [onDelete, session.sessionId]);

  const handleFavorite = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onFavorite(session.sessionId);
  }, [onFavorite, session.sessionId]);

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onCopySessionId(session.sessionId);
  }, [onCopySessionId, session.sessionId]);

  const handleConvertToCliSession = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onConvertToCliSession(session.sessionId);
  }, [onConvertToCliSession, session.sessionId]);

  const fileSize = session.fileSize ? formatFileSize(session.fileSize) : null;
  const showEntrypointBadge = session.entrypoint && session.entrypoint !== 'cli' && session.entrypoint !== 'remote';
  // Converting the session this window is still chatting in would race with the
  // SDK process appending to the jsonl file, so hide the button for it.
  const showConvertButton = !isActiveSession
    && session.entrypoint != null
    && CONVERTIBLE_ENTRYPOINTS.has(session.entrypoint);

  return (
    <div
      className={`history-item ${isSelectionMode ? 'selection-mode' : ''} ${isSelected ? 'selected' : ''}`}
      onClick={handleRowClick}
    >
      <div className="history-item-header">
        {isSelectionMode && (
          <label
            className="history-selection-checkbox-wrapper"
            onClick={stopPropagationHandler}
            title={t('history.selectSession')}
          >
            <input
              type="checkbox"
              className="history-selection-checkbox"
              checked={isSelected}
              onChange={handleCheckboxChange}
              onClick={stopPropagationHandler}
              aria-label={t('history.selectSessionWithTitle', { title: extractCommandMessageContent(session.title) })}
            />
          </label>
        )}
        <div className="history-item-title">
          {/* Provider Logo */}
          {session.provider && (
            <span
              className="history-provider-badge"
              style={PROVIDER_BADGE_STYLE}
              title={session.provider === 'claude'
                ? 'Claude'
                : session.provider === 'codex'
                  ? 'Codex'
                  : session.provider === 'codebuddy'
                    ? 'CodeBuddy'
                    : session.provider}
            >
              <ProviderModelIcon providerId={session.provider} size={20} colored />
            </span>
          )}
          {isEditing ? (
            <div className="history-title-edit-mode" onClick={stopPropagationHandler}>
              <input
                type="text"
                className="history-title-input"
                value={editingTitle}
                onChange={handleEditChange}
                maxLength={50}
                autoFocus
                onKeyDown={handleEditKeyDown}
              />
              <button
                className="history-title-save-btn"
                onClick={handleEditSave}
                title={t('history.saveTitleButton')}
              >
                <span className="codicon codicon-check"></span>
              </button>
              <button
                className="history-title-cancel-btn"
                onClick={handleEditCancel}
                title={t('history.cancelEditButton')}
              >
                <span className="codicon codicon-close"></span>
              </button>
            </div>
          ) : (
            highlightText(extractCommandMessageContent(session.title), searchQuery)
          )}
        </div>
        <div className="history-item-time">{formatTimeAgo(session.lastTimestamp, t)}</div>
        {!isEditing && !isSelectionMode && (
          <div className={`history-action-buttons ${session.isFavorited ? 'has-favorite' : ''}`}>
            <button
              className="history-edit-btn"
              onClick={handleEditStart}
              title={t('history.editTitle')}
              aria-label={t('history.editTitle')}
            >
              <span className="codicon codicon-edit"></span>
            </button>
            <button
              className="history-export-btn"
              onClick={handleExport}
              title={t('history.exportSession')}
              aria-label={t('history.exportSession')}
            >
              <span className="codicon codicon-arrow-down"></span>
            </button>
            <button
              className="history-delete-btn"
              onClick={handleDelete}
              title={t('history.deleteSession')}
              aria-label={t('history.deleteSession')}
            >
              <span className="codicon codicon-trash"></span>
            </button>
            <button
              className={`history-favorite-btn ${session.isFavorited ? 'favorited' : ''}`}
              onClick={handleFavorite}
              title={session.isFavorited ? t('history.unfavoriteSession') : t('history.favoriteSession')}
              aria-label={session.isFavorited ? t('history.unfavoriteSession') : t('history.favoriteSession')}
            >
              <span className={session.isFavorited ? 'codicon codicon-star-full' : 'codicon codicon-star-empty'}></span>
            </button>
          </div>
        )}
      </div>
      <div className="history-item-meta">
        <span>{t('history.messageCount', { count: session.messageCount })}</span>
        {fileSize && (
          <>
            <span className="history-meta-dot">•</span>
            <span className={fileSize.isMB ? 'history-filesize-large' : ''}>{fileSize.text}</span>
          </>
        )}
        {showEntrypointBadge && (
          <>
            <span className="history-meta-dot">•</span>
            <span
              className={`history-entrypoint-badge history-entrypoint-${session.entrypoint}`}
              title={t(`history.entrypointTooltip.${session.entrypoint}`, { defaultValue: session.entrypoint })}
            >
              <span className={`codicon ${
                session.entrypoint === 'sdk-cli' ? 'codicon-symbol-namespace' :
                session.entrypoint === 'claude-vscode' ? 'codicon-extensions' :
                'codicon-debug-alt'
              }`}></span>
              {t(`history.entrypointLabel.${session.entrypoint}`, { defaultValue: session.entrypoint })}
            </span>
          </>
        )}
        <span className="history-meta-dot">•</span>
        <div className="history-session-id-container">
          <span
            className="history-session-id"
            title={session.sessionId}
          >
            {session.sessionId.slice(0, 8)}
          </span>
          <button
            className={`history-copy-id-btn ${isCopied ? 'copied' : ''} ${isCopyFailed ? 'failed' : ''}`}
            onClick={handleCopy}
            title={isCopied ? t('history.sessionIdCopied') : isCopyFailed ? t('history.copyFailed') : t('history.copySessionId')}
            aria-label={t('history.copySessionId')}
          >
            <span className={`codicon ${isCopied ? 'codicon-check' : isCopyFailed ? 'codicon-error' : 'codicon-copy'}`}></span>
          </button>
        </div>
        {showConvertButton && (
          <button
            className={`history-convert-btn history-convert-${session.entrypoint}`}
            onClick={handleConvertToCliSession}
            title={t('history.convertToCliSession')}
            aria-label={t('history.convertToCliSession')}
          >
            <span className="codicon codicon-arrow-swap"></span>
            {t('history.convertButton')}
          </button>
        )}
      </div>
    </div>
  );
});

HistoryListItem.displayName = 'HistoryListItem';
