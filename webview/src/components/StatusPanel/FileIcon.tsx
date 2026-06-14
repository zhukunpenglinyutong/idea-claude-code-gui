import { memo, useMemo } from 'react';
import { useIsCoDriverTheme } from '../../hooks/useActiveThemeMode';
import { NativeFileIcon } from '../nativeIcons/NativeFileIcon';
import { getFileIconSvg } from './utils';

interface FileIconProps {
  filePath: string;
  className?: string;
}

/**
 * File icon component that safely renders SVG icons.
 *
 * CoDriver asks the IntelliJ backend for the native IDE file icon. The stock
 * SVG icon remains the fallback and is still used by the other themes.
 */
const FileIcon = memo(({ filePath, className = 'file-change-icon' }: FileIconProps) => {
  const isCoDriver = useIsCoDriverTheme();
  const fileName = useMemo(() => filePath.split(/[/\\]/).pop() || filePath, [filePath]);
  const svgContent = useMemo(() => getFileIconSvg(filePath), [filePath]);

  const fallback = (
    <span
      dangerouslySetInnerHTML={{ __html: svgContent }}
      aria-hidden="true"
    />
  );

  if (isCoDriver) {
    return (
      <NativeFileIcon
        className={className}
        filePath={filePath}
        fileName={fileName}
        fallback={fallback}
      />
    );
  }

  return (
    <span
      className={className}
      dangerouslySetInnerHTML={{ __html: svgContent }}
      aria-hidden="true"
    />
  );
});

FileIcon.displayName = 'FileIcon';

export default FileIcon;
