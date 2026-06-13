import type React from 'react';
import { useIsCoDriverTheme } from '../../hooks/useActiveThemeMode';

export type ToolStatusState = 'pending' | 'completed' | 'error';

interface ToolStatusIndicatorProps {
  isCompleted: boolean;
  isError: boolean;
  className?: string;
  style?: React.CSSProperties;
}

interface ToolFileIconProps {
  fileName?: string;
  isDirectory?: boolean;
  stockSvg: string;
  className?: string;
  style?: React.CSSProperties;
}

function getToolStatusState(isCompleted: boolean, isError: boolean): ToolStatusState {
  if (isError) return 'error';
  if (isCompleted) return 'completed';
  return 'pending';
}

export function ToolStatusIndicator({ isCompleted, isError, className, style }: ToolStatusIndicatorProps) {
  const isCoDriver = useIsCoDriverTheme();
  const state = getToolStatusState(isCompleted, isError);

  if (!isCoDriver) {
    return <div className={`tool-status-indicator ${state}${className ? ` ${className}` : ''}`} style={style} />;
  }

  const iconClass = state === 'completed'
    ? 'codicon-check'
    : state === 'error'
      ? 'codicon-close'
      : 'codicon-loading codicon-modifier-spin';

  return (
    <span
      className={`tool-status-indicator codriver-tool-status codriver-tool-status-${state}${className ? ` ${className}` : ''}`}
      data-status={state}
      aria-hidden="true"
      style={style}
    >
      <span className={`codicon ${iconClass}`} />
    </span>
  );
}

export function ToolFileIcon({ stockSvg, className, style }: ToolFileIconProps) {
  const isCoDriver = useIsCoDriverTheme();

  return (
    <span
      className={`${isCoDriver ? 'codriver-tool-file-icon ' : ''}${className ?? ''}`.trim() || undefined}
      style={style}
      dangerouslySetInnerHTML={{ __html: stockSvg }}
    />
  );
}
