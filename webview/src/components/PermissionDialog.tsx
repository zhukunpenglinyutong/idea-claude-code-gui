import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatCountdown } from '../utils/helpers';
import { useDialogCountdownTimeout } from '../hooks/useDialogCountdownTimeout';
import { DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS } from '../utils/permissionDialogTimeout';
import MarkdownBlock from './MarkdownBlock';
import { useDialogResize } from '../hooks/useDialogResize';
import { isEditableEventTarget } from '../utils/isEditableEventTarget';

export interface PermissionRequest {
  channelId: string;
  toolName: string;
  inputs: Record<string, any>;
  suggestions?: any;
}

interface PermissionDialogProps {
  isOpen: boolean;
  request: PermissionRequest | null;
  onApprove: (channelId: string) => void;
  onSkip: (channelId: string) => void;
  onApproveAlways: (channelId: string) => void;
  timeoutSeconds?: number;
}

const PermissionDialog = ({
  isOpen,
  request,
  onApprove,
  onSkip,
  onApproveAlways,
  timeoutSeconds = DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS,
}: PermissionDialogProps) => {
  const [showCommand, setShowCommand] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { t } = useTranslation();
  const { dialogRef, dialogHeight, setDialogHeight, handleResizeStart } = useDialogResize({ minHeight: 150 });

  const handleTimeout = useCallback(() => {
    if (request) {
      onSkip(request.channelId);
    }
  }, [request, onSkip]);

  const { remainingSeconds, isTimeWarning, markSubmitted } = useDialogCountdownTimeout({
    isOpen,
    requestKey: request?.channelId,
    timeoutSeconds,
    onTimeout: handleTimeout,
  });

  const handleApprove = useCallback(() => {
    if (!request || !markSubmitted()) return;
    onApprove(request.channelId);
  }, [request, markSubmitted, onApprove]);

  const handleApproveAlways = useCallback(() => {
    if (!request || !markSubmitted()) return;
    onApproveAlways(request.channelId);
  }, [request, markSubmitted, onApproveAlways]);

  const handleSkip = useCallback(() => {
    if (!request || !markSubmitted()) return;
    onSkip(request.channelId);
  }, [request, markSubmitted, onSkip]);

  useEffect(() => {
    if (isOpen && request) {
      setShowCommand(true);
      setSelectedIndex(0);
      setDialogHeight(null);
    }
  }, [isOpen, request?.channelId, setDialogHeight]);

  useEffect(() => {
    if (!isOpen || !request) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableEventTarget(e.target)) {
        return;
      }

      if (e.key === '1') {
        handleApprove();
      } else if (e.key === '2') {
        handleApproveAlways();
      } else if (e.key === '3') {
        handleSkip();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => Math.max(0, prev - 1));
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => Math.min(2, prev + 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        setSelectedIndex(current => {
          if (current === 0) handleApprove();
          else if (current === 1) handleApproveAlways();
          else if (current === 2) handleSkip();
          return current;
        });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, request, handleApprove, handleApproveAlways, handleSkip]);

  if (!isOpen || !request) {
    return null;
  }

  // Format input parameters for display
  const formatInputValue = (value: any): string => {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'object') {
      return JSON.stringify(value, null, 2);
    }
    return String(value);
  };

  // Get the command or primary action content
  const getCommandContent = (): string => {
    // Get primary content based on tool type
    if (request.inputs.command) {
      return request.inputs.command;
    }
    if (request.inputs.content) {
      return request.inputs.content;
    }
    if (request.inputs.text) {
      return request.inputs.text;
    }
    // For other tools, format all inputs
    return Object.entries(request.inputs)
      .map(([key, value]) => `${key}: ${formatInputValue(value)}`)
      .join('\n');
  };

  // Get working directory
  const getWorkingDirectory = (): string => {
    if (request.inputs.cwd) {
      return request.inputs.cwd;
    }
    if (request.inputs.file_path) {
      return request.inputs.file_path;
    }
    if (request.inputs.path) {
      return request.inputs.path;
    }
    return '~';
  };

  // Map tool name to display title
  const getToolTitle = (toolName: string): string => {
    const key = `permission.tools.${toolName}`;
    const translated = t(key);
    // If translation key does not exist, return default template
    if (translated === key) {
      return t('permission.tools.execute', { toolName });
    }
    return translated;
  };

  const commandContent = getCommandContent();
  const workingDirectory = getWorkingDirectory();

  return (
    <div className="permission-dialog-overlay">
      <div
        ref={dialogRef}
        className="permission-dialog-v3"
        style={dialogHeight ? { height: dialogHeight, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' as const } : undefined}
      >
        <div className="permission-dialog-v3-resize-handle" onPointerDown={handleResizeStart} />
        <div className="permission-dialog-v3-header-row">
          <h3 className="permission-dialog-v3-title">{getToolTitle(request.toolName)}</h3>
          <span className={`countdown-timer ${isTimeWarning ? 'warning' : ''}`}>
            <span className="codicon codicon-clock" />
            <span className="countdown-time">{formatCountdown(remainingSeconds)}</span>
          </span>
        </div>
        {isTimeWarning && (
          <div className="timeout-warning-banner">
            <span className="codicon codicon-warning" />
            <span>{t('permission.timeoutWarning', 'Please answer soon, dialog will close in {{seconds}} seconds', { seconds: remainingSeconds })}</span>
          </div>
        )}
        <p className="permission-dialog-v3-subtitle">{t('permission.fromExternalProcess')}</p>

        <div className="permission-dialog-v3-command-box">
          <div className="permission-dialog-v3-command-header">
            <span className="command-path">
              <span className="command-arrow">→</span> ~ {workingDirectory}
            </span>
            <button
              className="command-toggle"
              onClick={() => setShowCommand(!showCommand)}
              title={showCommand ? t('chat.collapse') : t('chat.expand')}
            >
              <span className={`codicon codicon-chevron-${showCommand ? 'up' : 'down'}`} />
            </button>
          </div>

          {showCommand && (
            <div
              className="permission-dialog-v3-command-content"
              style={dialogHeight ? { maxHeight: 'none' } : undefined}
            >
              <MarkdownBlock content={commandContent} isStreaming={false} />
            </div>
          )}
        </div>

        {/* Option buttons list */}
        <div className="permission-dialog-v3-options">
          <button
            className={`permission-dialog-v3-option ${selectedIndex === 0 ? 'selected' : ''}`}
            onClick={handleApprove}
            onMouseEnter={() => setSelectedIndex(0)}
          >
            <span className="option-text">{t('permission.allow')}</span>
            <span className="option-key">1</span>
          </button>
          <button
            className={`permission-dialog-v3-option ${selectedIndex === 1 ? 'selected' : ''}`}
            onClick={handleApproveAlways}
            onMouseEnter={() => setSelectedIndex(1)}
          >
            <span className="option-text">{t('permission.allowAlways')}</span>
            <span className="option-key">2</span>
          </button>
          <button
            className={`permission-dialog-v3-option ${selectedIndex === 2 ? 'selected' : ''}`}
            onClick={handleSkip}
            onMouseEnter={() => setSelectedIndex(2)}
          >
            <span className="option-text">{t('permission.deny')}</span>
            <span className="option-key">3</span>
          </button>
        </div>
      </div>
    </div>
  );
};

export default PermissionDialog;
