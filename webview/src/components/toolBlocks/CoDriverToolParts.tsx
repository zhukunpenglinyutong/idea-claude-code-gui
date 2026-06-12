import type React from 'react';
import { CoDriverIcon, type CoDriverIconName } from '../codriverIcons';
import { useIsCoDriverTheme } from '../../hooks/useActiveThemeMode';
import { getFileIconKind } from '../../utils/fileIconKind';

interface ThemedToolIconProps {
  codiconClass: string;
  codriverName: CoDriverIconName;
  className?: string;
  size?: number;
  style?: React.CSSProperties;
}

interface ThemedFileIconProps {
  fileName: string;
  fallbackSvg: string;
  isDirectory?: boolean;
  className?: string;
  size?: number;
  style?: React.CSSProperties;
}

interface ToolStatusIndicatorProps {
  isCompleted: boolean;
  isError: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function ThemedToolIcon({
  codiconClass,
  codriverName,
  className,
  size = 16,
  style,
}: ThemedToolIconProps) {
  const isCoDriver = useIsCoDriverTheme();

  if (isCoDriver) {
    return (
      <CoDriverIcon
        name={codriverName}
        size={size}
        className={[className, 'codriver-tool-title-icon'].filter(Boolean).join(' ')}
        style={style}
        aria-hidden="true"
      />
    );
  }

  return <span className={[`codicon ${codiconClass}`, className].filter(Boolean).join(' ')} style={style} />;
}

export function ThemedFileIcon({
  fileName,
  fallbackSvg,
  isDirectory = false,
  className,
  size = 16,
  style,
}: ThemedFileIconProps) {
  const isCoDriver = useIsCoDriverTheme();

  if (isCoDriver) {
    return (
      <CoDriverIcon
        name={isDirectory ? 'folder' : getFileIconKind(fileName)}
        size={size}
        className={[className, 'codriver-tool-file-icon'].filter(Boolean).join(' ')}
        style={style}
        aria-hidden="true"
      />
    );
  }

  return <span className={className} style={style} dangerouslySetInnerHTML={{ __html: fallbackSvg }} />;
}

export function ToolStatusIndicator({ isCompleted, isError, className, style }: ToolStatusIndicatorProps) {
  const status = isError ? 'error' : isCompleted ? 'completed' : 'pending';
  return <div className={['tool-status-indicator', status, className].filter(Boolean).join(' ')} style={style} />;
}
