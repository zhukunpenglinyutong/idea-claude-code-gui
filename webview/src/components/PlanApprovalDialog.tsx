import { useEffect, useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCountdown } from '../utils/helpers';
import { useDialogCountdownTimeout } from '../hooks/useDialogCountdownTimeout';
import { DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS } from '../utils/permissionDialogTimeout';
import MarkdownBlock from './MarkdownBlock';
import { useDialogResize } from '../hooks/useDialogResize';
import { isEditableEventTarget } from '../utils/isEditableEventTarget';
import './PlanApprovalDialog.css';

export interface AllowedPrompt {
  tool: string;
  prompt: string;
}

export interface PlanApprovalRequest {
  requestId: string;
  toolName: string;
  plan?: string;
  allowedPrompts?: AllowedPrompt[];
  timestamp?: string;
}

interface PlanApprovalDialogProps {
  isOpen: boolean;
  request: PlanApprovalRequest | null;
  onApprove: (requestId: string, targetMode: string) => void;
  onReject: (requestId: string, message?: string) => void;
  timeoutSeconds?: number;
}

// Execution modes available after plan approval
const EXECUTION_MODES = [
  { id: 'default', labelKey: 'modes.default.label', descriptionKey: 'modes.default.description' },
  { id: 'acceptEdits', labelKey: 'modes.acceptEdits.label', descriptionKey: 'modes.acceptEdits.description' },
  { id: 'bypassPermissions', labelKey: 'modes.bypassPermissions.label', descriptionKey: 'modes.bypassPermissions.description' },
];

const PlanApprovalDialog = ({
  isOpen,
  request,
  onApprove,
  onReject,
  timeoutSeconds = DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS,
}: PlanApprovalDialogProps) => {
  const { t } = useTranslation();
  const [selectedMode, setSelectedMode] = useState('default');
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isApproving, setIsApproving] = useState(false);
  const [rejectFeedback, setRejectFeedback] = useState('');
  const rejectFeedbackRef = useRef<HTMLTextAreaElement>(null);
  const { dialogRef, dialogHeight, setDialogHeight, handleResizeStart } = useDialogResize({ minHeight: 200 });

  const handleTimeout = useCallback(() => {
    if (request) {
      onReject(request.requestId);
    }
  }, [request, onReject]);

  const { remainingSeconds, isTimeWarning, markSubmitted } = useDialogCountdownTimeout({
    isOpen,
    requestKey: request?.requestId,
    timeoutSeconds,
    onTimeout: handleTimeout,
  });

  const handleApproveClick = useCallback(() => {
    setIsApproving(true);
  }, []);

  const handleApproveConfirm = useCallback(() => {
    if (!request || !markSubmitted()) return;
    onApprove(request.requestId, selectedMode);
  }, [request, selectedMode, markSubmitted, onApprove]);

  const handleReject = useCallback(() => {
    if (!request || !markSubmitted()) return;
    onReject(request.requestId, rejectFeedback.trim() || undefined);
  }, [request, markSubmitted, onReject, rejectFeedback]);

  useEffect(() => {
    if (isOpen && request) {
      setSelectedMode('default');
      setIsCollapsed(false);
      setIsApproving(false);
      setRejectFeedback('');
      setDialogHeight(null);
    }
  }, [isOpen, request?.requestId, setDialogHeight]);

  // Keyboard event handling
  useEffect(() => {
    if (isOpen && request) {
      const handleKeyDown = (e: KeyboardEvent) => {
        if (isEditableEventTarget(e.target)) {
          return;
        }

        if (e.key === 'Escape') {
          handleReject();
        } else if (e.key === 'Enter') {
          if (isApproving) {
            handleApproveConfirm();
          } else {
            handleApproveClick();
          }
        }
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, request, isApproving, handleApproveClick, handleApproveConfirm, handleReject]);

  if (!isOpen || !request) {
    return null;
  }

  const handleModeChange = (modeId: string) => {
    setSelectedMode(modeId);
  };

  // Render collapsed mode
  if (isCollapsed) {
    return (
      <div className="permission-dialog-overlay collapsed-mode">
        <div className="plan-approval-dialog-collapsed">
          <div className="collapsed-header">
            <span className="collapsed-title">
              {t('planApproval.title', '计划已准备就绪')}
            </span>
            <span className={`countdown-timer ${isTimeWarning ? 'warning' : ''}`}>
              <span className="codicon codicon-clock" />
              <span className="countdown-time">{formatCountdown(remainingSeconds)}</span>
            </span>
          </div>
          <button
            className="expand-button"
            onClick={() => setIsCollapsed(false)}
            title={t('common.expand', '展开')}
          >
            <span className="codicon codicon-chevron-up" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`permission-dialog-overlay ${isTimeWarning ? 'warning-mode' : ''}`}>
      <div
        ref={dialogRef}
        className="plan-approval-dialog"
        style={dialogHeight ? { height: dialogHeight, maxHeight: '90vh' } : undefined}
      >
        {/* Resize handle at the top edge */}
        <div className="plan-approval-resize-handle" onPointerDown={handleResizeStart} />
        {/* Timeout warning notice */}
        {isTimeWarning && (
          <div className="timeout-warning-banner">
            <span className="codicon codicon-warning" />
            <span>{t('planApproval.timeoutWarning', '请尽快做出选择，对话框将在 {{seconds}} 秒后自动关闭', { seconds: remainingSeconds })}</span>
          </div>
        )}

        {/* Header with collapse button and countdown */}
        <div className="plan-approval-dialog-header">
          <div className="header-left">
            <h3 className="plan-approval-dialog-title">
              {t('planApproval.title', '计划已准备就绪')}
            </h3>
            <p className="plan-approval-dialog-subtitle">
              {t('planApproval.subtitle', 'Claude 已完成规划，准备执行。')}
            </p>
          </div>
          <div className="header-right">
            {/* Countdown display */}
            <span className={`countdown-timer ${isTimeWarning ? 'warning' : ''}`}>
              <span className="codicon codicon-clock" />
              <span className="countdown-time">{formatCountdown(remainingSeconds)}</span>
            </span>
            {/* Collapse button */}
            <button
              className="collapse-button"
              onClick={() => setIsCollapsed(true)}
              title={t('common.collapse', '收起')}
            >
              <span className="codicon codicon-chevron-down" />
            </button>
          </div>
        </div>

        {/* Plan content (markdown) */}
        {request.plan && (
          <div className="plan-approval-content">
            <MarkdownBlock content={request.plan} isStreaming={false} />
          </div>
        )}

        {/* Execution Mode Selection — only shown after clicking Approve */}
        {isApproving && (
          <div className="plan-approval-mode-section">
            <h4 className="mode-header">
              {t('planApproval.executionMode', '执行模式')}
            </h4>
            <p className="mode-description">
              {t('planApproval.executionModeDescription', '选择 Claude 执行计划的方式：')}
            </p>
            <div className="mode-options">
              {EXECUTION_MODES.map((mode) => (
                <button
                  key={mode.id}
                  className={`mode-option ${selectedMode === mode.id ? 'selected' : ''}`}
                  onClick={() => handleModeChange(mode.id)}
                >
                  <div className="mode-radio">
                    <span className={`codicon codicon-${selectedMode === mode.id ? 'circle-filled' : 'circle-outline'}`} />
                  </div>
                  <div className="mode-content">
                    <div className="mode-label">{t(mode.labelKey, mode.id)}</div>
                    <div className="mode-option-description">{t(mode.descriptionKey, '')}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Reject feedback textarea */}
        <div className="plan-approval-reject-feedback">
          <textarea
            ref={rejectFeedbackRef}
            className="plan-approval-reject-feedback-input"
            value={rejectFeedback}
            onChange={(e) => setRejectFeedback(e.target.value.slice(0, 2000))}
            placeholder={t('planApproval.rejectFeedbackPlaceholder', '可选：告诉 Claude 计划有什么问题，应该如何修改...')}
            rows={2}
          />
        </div>

        {/* Actions */}
        <div className="plan-approval-dialog-actions">
          <button
            className="action-button secondary"
            onClick={handleReject}
          >
            {t('planApproval.reject', '拒绝')}
          </button>

          <div className="action-buttons-right">
            {isApproving && (
              <button
                className="action-button primary"
                onClick={handleApproveConfirm}
              >
                {t('planApproval.confirm', '确认执行')}
              </button>
            )}
            {!isApproving && (
              <button
                className="action-button primary"
                onClick={handleApproveClick}
              >
                {t('planApproval.approve', '批准')}
              </button>
            )}
          </div>
        </div>

        {/* Keyboard hints */}
        <div className="plan-approval-hints">
          {isApproving ? (
            <span className="hint">
              <kbd>Enter</kbd> {t('planApproval.toConfirm', '确认执行')}
            </span>
          ) : (
            <span className="hint">
              <kbd>Enter</kbd> {t('planApproval.toApprove', '批准')}
            </span>
          )}
          <span className="hint">
            <kbd>Esc</kbd> {t('planApproval.toReject', '拒绝')}
          </span>
        </div>
      </div>
    </div>
  );
};

export default PlanApprovalDialog;
