import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';

import { BackIcon } from '../Icons';

export interface ChatHeaderProps {
  currentView: 'chat' | 'history' | 'settings';
  sessionTitle: string;
  t: TFunction;
  onBack: () => void;
  onNewSession: () => void;
  onNewTab: () => void;
  onHistory: () => void;
  onSettings: () => void;
  /**
   * Opens the in-conversation search panel. Only rendered when provided.
   * Wired up by App.tsx via UIStateContext.setSearchOpen.
   */
  onOpenSearch?: () => void;
  /**
   * Toggles the "auto-resume session after usage limit reset" preference.
   * The toggle button is only rendered when provided (Claude provider only).
   */
  onToggleAutoResume?: () => void;
  /** Current state of the auto-resume toggle; drives the active styling. */
  autoResumeEnabled?: boolean;
  onTitleChange?: (newTitle: string) => void;
  titleEditable?: boolean;
}

export function ChatHeader({
  currentView,
  sessionTitle,
  t,
  onBack,
  onNewSession,
  onNewTab,
  onHistory,
  onSettings,
  onOpenSearch,
  onToggleAutoResume,
  autoResumeEnabled = false,
  onTitleChange,
  titleEditable = false,
}: ChatHeaderProps): React.ReactElement | null {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!titleEditable) {
      setEditing(false);
    }
  }, [titleEditable]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const startEditing = useCallback(() => {
    if (!titleEditable || !onTitleChange) return;
    setEditValue(sessionTitle);
    setEditing(true);
  }, [titleEditable, onTitleChange, sessionTitle]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    const trimmed = editValue.trim().slice(0, 50);
    if (trimmed && trimmed !== sessionTitle && onTitleChange) {
      onTitleChange(trimmed);
    }
  }, [editValue, sessionTitle, onTitleChange]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitEdit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  }, [commitEdit, cancelEdit]);

  const handleBlur = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    // If focus moves to save/cancel button inside edit container, let that button handle it
    const editContainer = e.currentTarget.closest('.session-title-edit-mode');
    if (editContainer && editContainer.contains(e.relatedTarget as Node)) {
      return;
    }
    commitEdit();
  }, [commitEdit]);

  if (currentView === 'settings') {
    return null;
  }

  return (
    <div className="header">
      <div className="header-left">
        {currentView === 'history' ? (
          <button className="back-button" onClick={onBack} data-tooltip={t('common.back')}>
            <BackIcon /> {t('common.back')}
          </button>
        ) : editing ? (
          <div className="session-title-edit-mode" onClick={(e) => e.stopPropagation()}>
            <input
              ref={inputRef}
              type="text"
              className="session-title-input"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleBlur}
              maxLength={50}
              spellCheck={false}
              aria-label="Session title"
            />
            <button className="session-title-save-btn" onClick={commitEdit} aria-label="Save title">
              <span className="codicon codicon-check" />
            </button>
            <button className="session-title-cancel-btn" onClick={cancelEdit} aria-label="Cancel editing">
              <span className="codicon codicon-close" />
            </button>
          </div>
        ) : (
          <div className="session-title-wrapper">
            <div className="session-title">
              {sessionTitle}
            </div>
            {titleEditable && (
              <button className="session-title-edit-btn" onClick={startEditing} aria-label="Edit session title">
                <span className="codicon codicon-edit" />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="header-right">
        {currentView === 'chat' && (
          <>
            {onToggleAutoResume && (
              <button
                className={`icon-button${autoResumeEnabled ? ' is-active' : ''}`}
                onClick={onToggleAutoResume}
                data-tooltip={autoResumeEnabled
                  ? t('chat.autoResume.tooltipOn', { defaultValue: 'Auto-resume after usage limit reset: on' })
                  : t('chat.autoResume.tooltipOff', { defaultValue: 'Auto-resume after usage limit reset: off' })}
                aria-label={t('chat.autoResume.toggleLabel', { defaultValue: 'Auto-resume after usage limit reset' })}
                aria-pressed={autoResumeEnabled}
              >
                <span className="codicon codicon-sync" />
              </button>
            )}
            {onOpenSearch && (
              <button
                className="icon-button"
                onClick={onOpenSearch}
                data-tooltip={t('chat.search.openTooltip', { defaultValue: 'Search in conversation' })}
                aria-label={t('chat.search.openTooltip', { defaultValue: 'Search in conversation' })}
              >
                <span className="codicon codicon-search" />
              </button>
            )}
            <button className="icon-button" onClick={onNewSession} data-tooltip={t('common.newSession')}>
              <span className="codicon codicon-plus" />
            </button>
            <button
              className="icon-button"
              onClick={onNewTab}
              data-tooltip={t('common.newTab')}
            >
              <span className="codicon codicon-split-horizontal" />
            </button>
            <button
              className="icon-button"
              onClick={onHistory}
              data-tooltip={t('common.history')}
            >
              <span className="codicon codicon-history" />
            </button>
            <button
              className="icon-button"
              onClick={onSettings}
              data-tooltip={t('common.settings')}
            >
              <span className="codicon codicon-settings-gear" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
