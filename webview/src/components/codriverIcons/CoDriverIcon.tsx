import type React from 'react';

export type CoDriverIconName =
  | 'agent'
  | 'attachment'
  | 'back'
  | 'branch'
  | 'check'
  | 'chevronDown'
  | 'chevronRight'
  | 'code'
  | 'copy'
  | 'edit'
  | 'error'
  | 'file'
  | 'history'
  | 'info'
  | 'link'
  | 'model'
  | 'reload'
  | 'search'
  | 'send'
  | 'settings'
  | 'spark'
  | 'spinner'
  | 'stop'
  | 'terminal'
  | 'thumbsDown'
  | 'thumbsUp'
  | 'tool'
  | 'warning'
  | 'x';

export interface CoDriverIconProps extends Omit<React.SVGProps<SVGSVGElement>, 'name'> {
  name: CoDriverIconName;
  size?: number;
  strokeWidth?: number;
}

function renderIcon(name: CoDriverIconName): React.ReactNode {
  switch (name) {
    case 'agent':
      return (
        <>
          <circle cx="12" cy="8" r="3" />
          <path d="M5.75 19.25c.65-3.45 2.75-5.25 6.25-5.25s5.6 1.8 6.25 5.25" />
          <path d="M8.25 8h-.9a2.1 2.1 0 0 0-2.1 2.1v1.3" />
          <path d="M15.75 8h.9a2.1 2.1 0 0 1 2.1 2.1v1.3" />
        </>
      );
    case 'attachment':
      return <path d="M8.5 12.5 14.8 6.2a3.05 3.05 0 0 1 4.3 4.3l-7.8 7.8a5 5 0 0 1-7.1-7.1l7.5-7.5" />;
    case 'back':
      return <path d="M15.5 5.5 9 12l6.5 6.5" />;
    case 'branch':
      return (
        <>
          <circle cx="7" cy="6" r="2.25" />
          <circle cx="17" cy="18" r="2.25" />
          <circle cx="7" cy="18" r="2.25" />
          <path d="M7 8.25v7.5" />
          <path d="M9.25 6H13a4 4 0 0 1 4 4v5.75" />
        </>
      );
    case 'check':
      return <path d="m5 12.5 4.2 4.2L19 6.8" />;
    case 'chevronDown':
      return <path d="m6.5 9 5.5 5.5L17.5 9" />;
    case 'chevronRight':
      return <path d="m9 6.5 5.5 5.5L9 17.5" />;
    case 'code':
      return (
        <>
          <path d="m9 7-4.5 5L9 17" />
          <path d="m15 7 4.5 5L15 17" />
          <path d="m13.2 5.75-2.4 12.5" />
        </>
      );
    case 'copy':
      return (
        <>
          <rect x="8" y="7" width="10" height="12" rx="2" />
          <path d="M6 15H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
        </>
      );
    case 'edit':
      return (
        <>
          <path d="M5 19h4.3L18.6 9.7a2.1 2.1 0 0 0-3-3L6.3 16H5v3Z" />
          <path d="m13.8 8.5 1.7 1.7" />
        </>
      );
    case 'error':
      return (
        <>
          <circle cx="12" cy="12" r="8.25" />
          <path d="M12 7.75v5" />
          <path d="M12 16.25h.01" />
        </>
      );
    case 'file':
      return (
        <>
          <path d="M6.75 3.75h6.6L18.25 8.7v11.55H6.75V3.75Z" />
          <path d="M13.25 4v5h5" />
        </>
      );
    case 'history':
      return (
        <>
          <path d="M5 12a7 7 0 1 0 2.05-4.95" />
          <path d="M5 5.5v4h4" />
          <path d="M12 8v4.25l2.75 1.75" />
        </>
      );
    case 'info':
      return (
        <>
          <circle cx="12" cy="12" r="8.25" />
          <path d="M12 11v5" />
          <path d="M12 8h.01" />
        </>
      );
    case 'link':
      return (
        <>
          <path d="M9.75 13.75a3.25 3.25 0 0 1 0-4.6l2.1-2.1a3.25 3.25 0 1 1 4.6 4.6l-1.1 1.1" />
          <path d="M14.25 10.25a3.25 3.25 0 0 1 0 4.6l-2.1 2.1a3.25 3.25 0 1 1-4.6-4.6l1.1-1.1" />
        </>
      );
    case 'model':
      return (
        <>
          <rect x="4" y="5" width="16" height="14" rx="3" />
          <path d="M8 9h8" />
          <path d="M8 13h5" />
          <path d="M16 13h.01" />
        </>
      );
    case 'reload':
      return (
        <>
          <path d="M19 11a7 7 0 1 0-2 4.9" />
          <path d="M19 5.75V11h-5.25" />
        </>
      );
    case 'search':
      return (
        <>
          <circle cx="10.75" cy="10.75" r="5.75" />
          <path d="m15.25 15.25 4 4" />
        </>
      );
    case 'send':
      return (
        <>
          <path d="M4 12 19.5 4.5 16 19.5 12 13 4 12Z" />
          <path d="M12 13 19.5 4.5" />
        </>
      );
    case 'settings':
      return (
        <>
          <circle cx="12" cy="12" r="2.75" />
          <path d="M19 12a7.2 7.2 0 0 0-.1-1.15l2-1.55-2-3.45-2.45 1a7.4 7.4 0 0 0-1.95-1.12L14.15 3h-4.3L9.5 5.73a7.4 7.4 0 0 0-1.95 1.12l-2.45-1-2 3.45 2 1.55a7.2 7.2 0 0 0 0 2.3l-2 1.55 2 3.45 2.45-1A7.4 7.4 0 0 0 9.5 18.27l.35 2.73h4.3l.35-2.73a7.4 7.4 0 0 0 1.95-1.12l2.45 1 2-3.45-2-1.55c.07-.37.1-.75.1-1.15Z" />
        </>
      );
    case 'spark':
      return (
        <>
          <path d="M12 3.75 13.55 9 19 10.55 13.55 12.1 12 17.25 10.45 12.1 5 10.55 10.45 9 12 3.75Z" />
          <path d="M18.5 15.5 19.1 17.4 21 18l-1.9.6-.6 1.9-.6-1.9L16 18l1.9-.6.6-1.9Z" />
        </>
      );
    case 'spinner':
      return <path d="M20 12a8 8 0 1 1-3.2-6.4" />;
    case 'stop':
      return <rect x="7" y="7" width="10" height="10" rx="2" />;
    case 'terminal':
      return (
        <>
          <path d="m5.5 8 4 4-4 4" />
          <path d="M11.5 16h7" />
        </>
      );
    case 'thumbsDown':
      return (
        <>
          <path d="M7.5 4.5v10" />
          <path d="M7.5 13.5h-2a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h8.25a2 2 0 0 1 1.9 1.37l1.85 5.63a2 2 0 0 1-1.9 2.63H13l.55 3.2a2 2 0 0 1-3.35 1.7L7.5 16.5v-3Z" />
        </>
      );
    case 'thumbsUp':
      return (
        <>
          <path d="M7.5 19.5v-10" />
          <path d="M7.5 10.5h-2a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h8.25a2 2 0 0 0 1.9-1.37l1.85-5.63a2 2 0 0 0-1.9-2.63H13l.55-3.2a2 2 0 0 0-3.35-1.7L7.5 7.5v3Z" />
        </>
      );
    case 'tool':
      return (
        <>
          <path d="M15.5 4.75a4 4 0 0 0 3.75 5.25l-8.7 8.7a2.2 2.2 0 0 1-3.1-3.1l8.7-8.7a4 4 0 0 0-.65-2.15Z" />
          <path d="M7.5 16.5h.01" />
        </>
      );
    case 'warning':
      return (
        <>
          <path d="M10.2 4.8a2.1 2.1 0 0 1 3.6 0l7.1 12.3a2.1 2.1 0 0 1-1.8 3.15H4.9a2.1 2.1 0 0 1-1.8-3.15L10.2 4.8Z" />
          <path d="M12 9v4.5" />
          <path d="M12 17h.01" />
        </>
      );
    case 'x':
      return <path d="m7 7 10 10M17 7 7 17" />;
  }
}

export function CoDriverIcon({
  name,
  size = 16,
  strokeWidth = 1.7,
  className,
  ...svgProps
}: CoDriverIconProps) {
  const classes = ['codriver-icon', `codriver-icon-${name}`, className]
    .filter(Boolean)
    .join(' ');

  // Respect an explicit `aria-hidden` if the caller set one; otherwise expose
  // the icon only when it carries its own accessible name, and hide it as
  // decorative in every other case.
  const hasExplicitAriaHidden = Object.prototype.hasOwnProperty.call(svgProps, 'aria-hidden');
  const hasAccessibleName = Boolean(svgProps['aria-label'] || svgProps['aria-labelledby']);
  const ariaHidden = hasExplicitAriaHidden
    ? svgProps['aria-hidden']
    : hasAccessibleName
      ? undefined
      : true;

  return (
    <svg
      {...svgProps}
      className={classes}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={ariaHidden}
      focusable="false"
    >
      {renderIcon(name)}
    </svg>
  );
}
