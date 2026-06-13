import type React from 'react';
import { useNativeFileIcon } from '../../utils/nativeFileIcons';

interface NativeFileIconProps {
  fileName?: string;
  filePath?: string;
  isDirectory?: boolean;
  className?: string;
  style?: React.CSSProperties;
  fallback?: React.ReactNode;
  enabled?: boolean;
}

function joinClasses(...parts: Array<string | undefined | false>): string | undefined {
  const classes = parts.filter(Boolean).join(' ').trim();
  return classes || undefined;
}

export function NativeFileIcon({
  fileName,
  filePath,
  isDirectory = false,
  className,
  style,
  fallback,
  enabled = true,
}: NativeFileIconProps) {
  const nativeIcon = useNativeFileIcon({ filePath, fileName, isDirectory }, enabled);
  const classes = joinClasses('codriver-native-file-icon', nativeIcon ? 'native-loaded' : 'native-pending', className);

  if (nativeIcon) {
    return (
      <span className={classes} style={style} aria-hidden="true">
        <img src={nativeIcon} alt="" draggable={false} />
      </span>
    );
  }

  return (
    <span className={classes} style={style} aria-hidden="true">
      {fallback}
    </span>
  );
}
