import React, { useRef, useState, useEffect, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { getFileIcon } from '../../utils/fileIcons';
import { TokenIndicator } from './TokenIndicator';
import { LimitRing } from './LimitRing';
import type { SelectedAgent } from './types';
import type { UsageLimits } from '../../hooks/providers/useUsageTracking';

const HIDDEN_INPUT_STYLE: React.CSSProperties = { display: 'none' };
const CURSOR_DEFAULT_STYLE: React.CSSProperties = { cursor: 'default' };
const ROBOT_ICON_STYLE: React.CSSProperties = { marginRight: 4 };
const FILE_ICON_STYLE: React.CSSProperties = {
  marginRight: 4,
  display: 'inline-flex',
  alignItems: 'center',
  width: 16,
  height: 16,
};

interface ContextBarProps {
  activeFile?: string;
  selectedLines?: string;
  percentage?: number;
  usedTokens?: number;
  maxTokens?: number;
  showUsage?: boolean;
  onClearFile?: () => void;
  onAddAttachment?: (files: FileList) => void;
  selectedAgent?: SelectedAgent | null;
  onClearAgent?: () => void;
  /** Current provider (for conditional rendering) */
  currentProvider?: string;
  /** Whether there are messages (for rewind button visibility) */
  hasMessages?: boolean;
  /** Rewind callback */
  onRewind?: () => void;
  /** Whether StatusPanel is expanded */
  statusPanelExpanded?: boolean;
  /** Toggle StatusPanel expand/collapse */
  onToggleStatusPanel?: () => void;
  /** Whether auto open file is enabled */
  autoOpenFileEnabled?: boolean;
  /** Callback to enable file context (called from placeholder click) */
  onRequestEnableFileContext?: () => void;
  /** Usage limits for rendering LimitRing indicators */
  usageLimits?: UsageLimits | null;
}

export const ContextBar: React.FC<ContextBarProps> = memo(({
  activeFile,
  selectedLines,
  percentage = 0,
  usedTokens,
  maxTokens,
  showUsage = true,
  onClearFile,
  onAddAttachment,
  selectedAgent,
  onClearAgent,
  currentProvider = 'claude',
  hasMessages = false,
  onRewind,
  statusPanelExpanded = true,
  onToggleStatusPanel,
  autoOpenFileEnabled = false,
  onRequestEnableFileContext,
  usageLimits = null,
}) => {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [showEnablePopover, setShowEnablePopover] = useState(false);

  // Reset popover state when autoOpenFileEnabled changes
  useEffect(() => {
    if (autoOpenFileEnabled) {
      setShowEnablePopover(false);
    }
  }, [autoOpenFileEnabled]);

  // Click outside or Escape to close popover
  useEffect(() => {
    if (!showEnablePopover) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setShowEnablePopover(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowEnablePopover(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showEnablePopover]);

  const handleAttachClick = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onAddAttachment?.(e.target.files);
    }
    e.target.value = '';
  }, [onAddAttachment]);

  const handlePlaceholderClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowEnablePopover(true);
  }, []);

  const handlePopoverCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowEnablePopover(false);
  }, []);

  const handlePopoverConfirm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowEnablePopover(false);
    onRequestEnableFileContext?.();
  }, [onRequestEnableFileContext]);

  // Extract filename from path
  const getFileName = (path: string) => {
    return path.split(/[/\\]/).pop() || path;
  };

  const getFileIconSvg = (path: string) => {
    const fileName = getFileName(path);
    const extension = fileName.indexOf('.') !== -1 ? fileName.split('.').pop() : '';
    return getFileIcon(extension, fileName);
  };

  const displayText = activeFile ? (
    selectedLines ? `${getFileName(activeFile)}#${selectedLines}` : getFileName(activeFile)
  ) : '';

  const fullDisplayText = activeFile ? (
    selectedLines ? `${activeFile}#${selectedLines}` : activeFile
  ) : '';

  return (
    <div className="context-bar">
      {/* Tool Icons Group */}
      <div className="context-tools">
        <div
          className="context-tool-btn"
          onClick={handleAttachClick}
          title="Add attachment"
        >
          <span className="codicon codicon-attach" />
        </div>

        {/* Token Indicator */}
        {showUsage && (
          <div className="context-token-indicator">
            <TokenIndicator
              percentage={percentage}
              usedTokens={usedTokens}
              maxTokens={maxTokens}
              size={14}
            />
          </div>
        )}

        {/* Usage Limit Rings */}
        {usageLimits?.provider === 'claude' && usageLimits.fiveHour && (
          <LimitRing
            percent={usageLimits.fiveHour.percent}
            label="5h"
            resetsAt={usageLimits.fiveHour.resetsAt ?? null}
          />
        )}
        {usageLimits?.provider === 'claude' && usageLimits.sevenDay && (
          <LimitRing
            percent={usageLimits.sevenDay.percent}
            label="7d"
            resetsAt={usageLimits.sevenDay.resetsAt ?? null}
          />
        )}
        {usageLimits?.provider === 'codex' && usageLimits.primaryWindow && (
          <LimitRing
            percent={usageLimits.primaryWindow.percent}
            label="3h"
            resetsAt={usageLimits.primaryWindow.resetsAt ?? null}
          />
        )}
        {usageLimits?.provider === 'codex' && usageLimits.secondaryWindow && (
          <LimitRing
            percent={usageLimits.secondaryWindow.percent}
            label="7d"
            resetsAt={usageLimits.secondaryWindow.resetsAt ?? null}
          />
        )}
        
        {/* Hidden file input */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden-file-input"
          onChange={handleFileChange}
          style={HIDDEN_INPUT_STYLE}
        />
        
        <div className="context-tool-divider" />
      </div>

      {/* Selected Agent Chip */}
      {selectedAgent && (
        <div
          className="context-item has-tooltip"
          data-tooltip={selectedAgent.name}
          style={CURSOR_DEFAULT_STYLE}
        >
          <span
            className="codicon codicon-robot"
            style={ROBOT_ICON_STYLE}
          />
          <span className="context-text">
            <span dir="ltr">
              {selectedAgent.name.length > 3 
                ? `${selectedAgent.name.slice(0, 3)}...` 
                : selectedAgent.name}
            </span>
          </span>
          <span 
            className="codicon codicon-close context-close" 
            onClick={onClearAgent}
            title="Remove agent"
          />
        </div>
      )}

      {/* Active Context Chip or Empty Placeholder */}
      {displayText ? (
        <div
          className="context-item has-tooltip"
          data-tooltip={fullDisplayText}
          style={CURSOR_DEFAULT_STYLE}
        >
          {activeFile && (
            <span
              className="context-file-icon"
              style={FILE_ICON_STYLE}
              dangerouslySetInnerHTML={{ __html: getFileIconSvg(activeFile) }}
            />
          )}
          <span className="context-text">
            <span dir="ltr">{displayText}</span>
          </span>
          <span
            className="codicon codicon-close context-close"
            onClick={onClearFile}
            title="Remove file context"
          />
        </div>
      ) : !autoOpenFileEnabled && (
        <div className="context-file-placeholder-wrapper" ref={popoverRef}>
          <button
            className="context-file-placeholder"
            onClick={handlePlaceholderClick}
            title={t('fileContext.placeholder')}
            type="button"
          >
            <span className="codicon codicon-file" />
            <span className="placeholder-text">{t('fileContext.placeholder')}</span>
          </button>

          {showEnablePopover && (
            <div className="file-context-confirm-popover">
              <div className="popover-title">{t('fileContext.enableTitle')}</div>
              <div className="popover-description">{t('fileContext.enableDescription')}</div>
              <div className="popover-actions">
                <button
                  className="popover-btn popover-btn-cancel"
                  onClick={handlePopoverCancel}
                >
                  {t('fileContext.cancel')}
                </button>
                <button
                  className="popover-btn popover-btn-confirm"
                  onClick={handlePopoverConfirm}
                >
                  {t('fileContext.enable')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Right side tools - StatusPanel toggle and Rewind button */}
      <div className="context-tools-right">
        {/* StatusPanel expand/collapse toggle - always visible */}
        {onToggleStatusPanel && (
          <button
            className={`context-tool-btn status-panel-toggle has-tooltip ${statusPanelExpanded ? 'expanded' : 'collapsed'}`}
            onClick={onToggleStatusPanel}
            data-tooltip={statusPanelExpanded ? t('statusPanel.collapse') : t('statusPanel.expand')}
          >
            <span className={`codicon ${statusPanelExpanded ? 'codicon-chevron-down' : 'codicon-layers'}`} />
          </button>
        )}

        {/* Rewind button */}
        {currentProvider === 'claude' && onRewind && (
          <button
            className="context-tool-btn has-tooltip"
            onClick={onRewind}
            disabled={!hasMessages}
            data-tooltip={t('rewind.tooltip')}
          >
            <span className="codicon codicon-discard" />
          </button>
        )}
      </div>
    </div>
  );
});
