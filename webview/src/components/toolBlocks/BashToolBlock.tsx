import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolInput, ToolResultBlock } from '../../types';
import { useIsToolDenied } from '../../hooks/useIsToolDenied';
import { stripAnsi } from '../../utils/stripAnsi';

const TASK_DETAILS_STYLE: React.CSSProperties = { padding: 0, border: 'none' };
const TASK_CONTENT_WRAPPER_STYLE: React.CSSProperties = { paddingLeft: '40px', position: 'relative', zIndex: 1 };
const ERROR_ICON_STYLE: React.CSSProperties = { fontSize: '14px', marginTop: '1px' };

interface BashToolBlockProps {
  name?: string;
  input?: ToolInput;
  result?: ToolResultBlock | null;
  /** Unique ID of the tool call, used to determine if the user denied permission */
  toolId?: string;
}

const BashToolBlock = ({ input, result, toolId }: BashToolBlockProps) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  if (!input) {
    return null;
  }

  const command = typeof input.command === 'string' ? input.command : '';
  const description = typeof input.description === 'string' ? input.description : '';

  const isDenied = useIsToolDenied(toolId);

  // Determine tool call status based on result
  // If denied, treat as completed (show error state)
  const isCompleted = (result !== undefined && result !== null) || isDenied;
  // If denied, show as error state
  const isError = isDenied || (isCompleted && result?.is_error === true);

  let output = '';

  if (result) {
    const content = result.content;
    if (typeof content === 'string') {
      output = content;
    } else if (Array.isArray(content)) {
      output = content.map((block) => block.text ?? '').join('\n');
    }
    output = stripAnsi(output);
  }

  return (
    <div className="task-container">
      <div
        className={`task-header bash-tool-header ${expanded ? 'expanded' : ''}`}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <div className="task-title-section">
          <span className="codicon codicon-terminal bash-tool-icon" />
          <span className="bash-tool-title">{t('tools.runCommand')}</span>
          <span className="bash-tool-description">{description}</span>
        </div>

        <div className={`tool-status-indicator ${isError ? 'error' : isCompleted ? 'completed' : 'pending'}`} />
      </div>

      {expanded && (
        <div className="task-details" style={TASK_DETAILS_STYLE}>
          <div className="bash-tool-content">
            <div className="bash-tool-line" />
            <div className="task-content-wrapper" style={TASK_CONTENT_WRAPPER_STYLE}>
              <div className="bash-command-block">{command}</div>

              {output && (
                <div className={`bash-output-block ${isError ? 'error' : 'normal'}`}>
                  {isError && (
                    <span className="codicon codicon-error" style={ERROR_ICON_STYLE} />
                  )}
                  <span className="bash-output-text">{output}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default BashToolBlock;
