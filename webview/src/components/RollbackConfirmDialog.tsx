import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { RollbackRequest } from '../hooks/useRollbackHandlers';

interface RollbackConfirmDialogProps {
  isOpen: boolean;
  request: RollbackRequest | null;
  isLoading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const RollbackConfirmDialog = ({
  isOpen,
  request,
  isLoading = false,
  onConfirm,
  onCancel,
}: RollbackConfirmDialogProps) => {
  const { t } = useTranslation();

  useEffect(() => {
    if (isOpen) {
      const handleEscape = (e: KeyboardEvent) => {
        if (e.key === 'Escape' && !isLoading) {
          onCancel();
        }
      };
      window.addEventListener('keydown', handleEscape);
      return () => window.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, isLoading, onCancel]);

  if (!isOpen || !request) {
    return null;
  }

  // Truncate message content for display
  const displayContent =
    request.messageContent.length > 120
      ? `${request.messageContent.substring(0, 120)}...`
      : request.messageContent;

  return (
    <div className="confirm-dialog-overlay" onClick={isLoading ? undefined : onCancel}>
      <div
        className="confirm-dialog rewind-dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-dialog-header">
          <h3 className="confirm-dialog-title">
            <span className="rewind-icon">&#x21BA;</span>{' '}
            {t('rollback.title', 'Reset to this point?')}
          </h3>
        </div>
        <div className="confirm-dialog-body">
          {isLoading ? (
            <div className="rewind-loading">
              <span className="codicon codicon-loading codicon-modifier-spin rewind-loading-icon" />
              <span className="rewind-loading-text">
                {t('rollback.restoring', 'Reverting changes...')}
              </span>
            </div>
          ) : (
            <>
              <div className="rewind-target">
                <div className="rewind-target-label">
                  {t('rollback.rollbackTo', 'Rollback to')}:
                </div>
                <div className="rewind-target-message">
                  {request.messageTimestamp && (
                    <span className="rewind-timestamp">
                      [{request.messageTimestamp}]
                    </span>
                  )}
                  <span className="rewind-content">"{displayContent}"</span>
                </div>
              </div>

              <div className="rewind-warning">
                <div className="rewind-warning-icon">&#x26A0;</div>
                <div className="rewind-warning-content">
                  <div className="rewind-warning-title">
                    {t('rollback.impact', 'Impact')}:
                  </div>
                  <ul className="rewind-warning-list">
                    <li>
                      {t('rollback.confirmMessage', 'This will discard all messages after this point.')}
                    </li>
                    <li>
                      {t('rollback.messagesAffected', {
                        count: request.messagesAfterCount,
                      })}
                    </li>
                    {request.hasFileChanges ? (
                      <li>
                        {t('rollback.fileChangesReverted', {
                          count: request.fileChangesCount,
                        })}
                      </li>
                    ) : (
                      <li>{t('rollback.noFileChanges', 'No file changes to revert')}</li>
                    )}
                  </ul>
                </div>
              </div>

              <p className="rewind-note">
                {t('rollback.cannotUndo', 'This action cannot be undone.')}
              </p>
            </>
          )}
        </div>
        <div className="confirm-dialog-footer">
          {isLoading ? (
            <button
              className="confirm-dialog-button cancel-button"
              onClick={onCancel}
            >
              {t('common.close', 'Close')}
            </button>
          ) : (
            <>
              <button
                className="confirm-dialog-button cancel-button"
                onClick={onCancel}
              >
                {t('rollback.cancel', 'Cancel')}
              </button>
              <button
                className="confirm-dialog-button confirm-button rewind-confirm-button"
                onClick={onConfirm}
                autoFocus
              >
                {t('rollback.confirm', 'Reset')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default RollbackConfirmDialog;
