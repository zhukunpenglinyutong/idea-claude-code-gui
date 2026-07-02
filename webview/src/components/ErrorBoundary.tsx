import React, { Component } from 'react';
import type { ReactNode } from 'react';
import i18n from '../i18n/config';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
  errorInfo?: React.ErrorInfo;
  copied: boolean;
}

const ROOT_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '100vh',
  padding: '20px',
  backgroundColor: 'var(--vscode-editor-background, #1e1e1e)',
  color: 'var(--vscode-editor-foreground, #cccccc)',
};

const CARD_STYLE: React.CSSProperties = {
  maxWidth: '700px',
  width: '100%',
  padding: '24px',
  backgroundColor: 'var(--vscode-notifications-background, #252526)',
  border: '1px solid var(--vscode-notifications-border, #454545)',
  borderRadius: '6px',
};

const HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  marginBottom: '16px',
};

const HEADER_ICON_STYLE: React.CSSProperties = {
  fontSize: '24px',
  color: 'var(--vscode-errorForeground, #f48771)',
  marginRight: '12px',
};

const HEADER_TITLE_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: '18px',
  fontWeight: 600,
};

const DESCRIPTION_STYLE: React.CSSProperties = {
  marginBottom: '16px',
  lineHeight: '1.5',
};

const CAUSES_BOX_STYLE: React.CSSProperties = {
  padding: '12px',
  marginBottom: '16px',
  backgroundColor: 'var(--vscode-inputValidation-warningBackground, #352a05)',
  border: '1px solid var(--vscode-inputValidation-warningBorder, #be8c0088)',
  borderRadius: '4px',
};

const CAUSES_TITLE_STYLE: React.CSSProperties = {
  fontWeight: 500,
  marginBottom: '8px',
};

const CAUSES_LIST_STYLE: React.CSSProperties = {
  margin: 0,
  paddingLeft: '20px',
  lineHeight: '1.6',
};

const HINTS_BOX_STYLE: React.CSSProperties = {
  padding: '12px',
  marginBottom: '16px',
  backgroundColor: 'var(--vscode-textBlockQuote-background, rgba(127, 127, 127, 0.12))',
  borderLeft: '3px solid var(--vscode-focusBorder, #4ea1ff)',
  borderRadius: '4px',
};

const HINTS_TITLE_STYLE: React.CSSProperties = {
  fontWeight: 600,
  marginBottom: '8px',
};

const HINTS_LIST_STYLE: React.CSSProperties = {
  margin: 0,
  paddingLeft: '20px',
  lineHeight: '1.6',
};

const DETAILS_STYLE: React.CSSProperties = {
  marginBottom: '16px',
};

const SUMMARY_STYLE: React.CSSProperties = {
  cursor: 'pointer',
  padding: '8px 12px',
  backgroundColor: 'var(--vscode-input-background, #3c3c3c)',
  border: '1px solid var(--vscode-input-border, #3c3c3c)',
  borderRadius: '4px',
  marginBottom: '8px',
  fontWeight: 500,
};

const PRE_STYLE: React.CSSProperties = {
  padding: '12px',
  backgroundColor: 'var(--vscode-textCodeBlock-background, #2d2d2d)',
  border: '1px solid var(--vscode-input-border, #3c3c3c)',
  borderRadius: '4px',
  overflow: 'auto',
  fontSize: '11px',
  lineHeight: '1.4',
  maxHeight: '300px',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const ACTION_BUTTONS_STYLE: React.CSSProperties = {
  display: 'flex',
  gap: '12px',
  flexWrap: 'wrap',
};

const RELOAD_BUTTON_STYLE: React.CSSProperties = {
  padding: '8px 16px',
  backgroundColor: 'var(--vscode-button-secondaryBackground, #3a3d41)',
  color: 'var(--vscode-button-secondaryForeground, #cccccc)',
  border: 'none',
  borderRadius: '4px',
  cursor: 'pointer',
  fontSize: '13px',
  fontWeight: 500,
  display: 'flex',
  alignItems: 'center',
  gap: '6px',
};

const BUTTON_ICON_STYLE: React.CSSProperties = {
  fontSize: '14px',
};

const HELP_TEXT_STYLE: React.CSSProperties = {
  marginTop: '16px',
  marginBottom: 0,
  fontSize: '12px',
  color: 'var(--vscode-descriptionForeground, #8b8b8b)',
  lineHeight: '1.5',
};

function getCopyButtonStyle(copied: boolean): React.CSSProperties {
  return {
    padding: '8px 16px',
    backgroundColor: copied
      ? 'var(--vscode-button-secondaryBackground, #3a3d41)'
      : 'var(--vscode-button-background, #0e639c)',
    color: copied
      ? 'var(--vscode-button-secondaryForeground, #cccccc)'
      : 'var(--vscode-button-foreground, #ffffff)',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    transition: 'background-color 0.2s',
  };
}

/**
 * Collect system environment information for debugging
 */
function getSystemInfo(): string {
  const info: string[] = [];

  info.push(`Time: ${new Date().toISOString()}`);
  info.push(`UserAgent: ${navigator.userAgent}`);
  info.push(`Platform: ${navigator.platform}`);
  info.push(`Language: ${navigator.language}`);
  info.push(`URL: ${window.location.href}`);
  info.push(`Screen: ${window.screen.width}x${window.screen.height}`);
  info.push(`Viewport: ${window.innerWidth}x${window.innerHeight}`);
  info.push(`DevicePixelRatio: ${window.devicePixelRatio}`);

  // Check if sendToJava bridge exists (JCEF environment)
  info.push(`JCEF Bridge: ${typeof window.sendToJava === 'function' ? 'available' : 'not available'}`);

  // Check localStorage availability
  try {
    localStorage.setItem('__test__', '1');
    localStorage.removeItem('__test__');
    info.push(`LocalStorage: available`);
  } catch {
    info.push(`LocalStorage: not available`);
  }

  return info.join('\n');
}

function extractComponentNames(componentStack?: string | null): string[] {
  if (!componentStack) {
    return [];
  }

  return componentStack
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^at\s+([^\s(]+)/);
      return match?.[1] ?? '';
    })
    .filter(Boolean);
}

function getErrorHints(error?: Error): string[] {
  const message = error?.message ?? '';
  const hints: string[] = [];

  if (/\.replace is not a function/i.test(message)) {
    hints.push('A non-string value reached code that expects plain text and calls string.replace().');
    hints.push('Check dialog/message payload fields such as command, content, text, or markdown props for arrays/objects.');
  }

  if (/Cannot read properties of undefined/i.test(message) || /Cannot read properties of null/i.test(message)) {
    hints.push('A required object was missing at render time; inspect optional chaining and async data guards.');
  }

  return hints;
}

/**
 * Format error details for display and copy
 */
function formatErrorDetails(error?: Error, errorInfo?: React.ErrorInfo): string {
  const parts: string[] = [];
  const componentNames = extractComponentNames(errorInfo?.componentStack ?? undefined);
  const hints = getErrorHints(error);

  parts.push('=== Error Summary ===');
  if (error) {
    parts.push(`Error: ${error.name}`);
    parts.push(`Message: ${error.message}`);
    if (hints.length > 0) {
      parts.push('Likely Cause(s):');
      hints.forEach((hint) => parts.push(`- ${hint}`));
    }
    if (componentNames.length > 0) {
      parts.push(`Component Chain: ${componentNames.join(' -> ')}`);
    }
    if (error.stack) {
      parts.push(`\nRaw Stack Trace:\n${error.stack}`);
    }
  }

  if (errorInfo?.componentStack) {
    parts.push(`\nRaw Component Stack:${errorInfo.componentStack}`);
  }

  parts.push('\n=== System Information ===');
  parts.push(getSystemInfo());

  return parts.join('\n');
}

/**
 * Get translated text with fallback
 */
function t(key: string, fallback: string): string {
  const translated = i18n.t(key);
  // If translation returns the key itself, use fallback
  return translated === key ? fallback : translated;
}

/**
 * Error Boundary Component
 * Catches JavaScript errors anywhere in the child component tree
 * and displays a fallback UI instead of crashing the whole app
 */
class ErrorBoundary extends Component<Props, State> {
  private copyTimerId: ReturnType<typeof setTimeout> | null = null;

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, copied: false };
  }

  componentWillUnmount() {
    if (this.copyTimerId) {
      clearTimeout(this.copyTimerId);
    }
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    // Update state so the next render will show the fallback UI
    return { hasError: true, error, copied: false };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Log error details for debugging
    console.error('[ErrorBoundary] Caught error:', error);
    console.error('[ErrorBoundary] Error info:', errorInfo);
    console.error('[ErrorBoundary] Component stack:', errorInfo.componentStack);

    this.setState({
      error,
      errorInfo,
    });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined, copied: false });

    // Reload the page to fully reset the app state
    window.location.reload();
  };

  private setCopiedWithAutoReset = () => {
    if (this.copyTimerId) {
      clearTimeout(this.copyTimerId);
    }
    this.setState({ copied: true });
    this.copyTimerId = setTimeout(() => {
      this.setState({ copied: false });
      this.copyTimerId = null;
    }, 2000);
  };

  handleCopyError = async () => {
    const errorDetails = formatErrorDetails(this.state.error, this.state.errorInfo);

    try {
      await navigator.clipboard.writeText(errorDetails);
      this.setCopiedWithAutoReset();
    } catch (err) {
      // Fallback: create a textarea and copy from there
      const textarea = document.createElement('textarea');
      textarea.value = errorDetails;
      textarea.style.position = 'fixed';
      textarea.style.left = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        this.setCopiedWithAutoReset();
      } catch {
        console.error('Failed to copy error details');
      }
      document.body.removeChild(textarea);
    }
  };

  render() {
    if (this.state.hasError) {
      // Custom fallback UI if provided
      if (this.props.fallback) {
        return this.props.fallback;
      }

      const errorDetails = formatErrorDetails(this.state.error, this.state.errorInfo);
      const copyButtonStyle = getCopyButtonStyle(this.state.copied);
      const errorHints = getErrorHints(this.state.error);
      const componentNames = extractComponentNames(this.state.errorInfo?.componentStack ?? undefined);

      // Default fallback UI — role/aria-live announce the error to assistive
      // tech, otherwise screen-reader users have no signal that the surface
      // suddenly switched to an error state.
      return (
        <div
          style={ROOT_STYLE}
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          <div style={CARD_STYLE}>
            {/* Header */}
            <div style={HEADER_STYLE}>
              <span
                className="codicon codicon-error"
                style={HEADER_ICON_STYLE}
                aria-hidden="true"
              />
              <h2 style={HEADER_TITLE_STYLE}>
                {t('errorBoundary.title', 'Something went wrong')}
              </h2>
            </div>

            {/* Description */}
            <p style={DESCRIPTION_STYLE}>
              {t('errorBoundary.description', 'The application encountered an unexpected error. Please copy the error details below and share them with the developer for troubleshooting.')}
            </p>

            {/* Possible causes hint */}
            <div style={CAUSES_BOX_STYLE}>
              <div style={CAUSES_TITLE_STYLE}>
                {t('errorBoundary.possibleCauses', 'Possible causes:')}
              </div>
              <ul style={CAUSES_LIST_STYLE}>
                <li>{t('errorBoundary.cause1', 'Node.js is not installed or not configured correctly')}</li>
                <li>{t('errorBoundary.cause2', 'Network connection issues')}</li>
                <li>{t('errorBoundary.cause3', 'Plugin or IDE compatibility issues')}</li>
                <li>{t('errorBoundary.cause4', 'Insufficient system resources')}</li>
              </ul>
            </div>

            {(errorHints.length > 0 || componentNames.length > 0) && (
              <div style={HINTS_BOX_STYLE}>
                <div style={HINTS_TITLE_STYLE}>
                  {t('errorBoundary.debugHints', 'Debug hints')}
                </div>
                <ul style={HINTS_LIST_STYLE}>
                  {errorHints.map((hint) => (
                    <li key={hint}>{hint}</li>
                  ))}
                  {componentNames.length > 0 && (
                    <li>
                      {t('errorBoundary.componentChain', 'Component chain')}: {componentNames.join(' → ')}
                    </li>
                  )}
                </ul>
              </div>
            )}

            {/* Error Details */}
            {this.state.error && (
              <details style={DETAILS_STYLE} open>
                <summary style={SUMMARY_STYLE}>
                  {t('errorBoundary.errorDetails', 'Error Details')}
                </summary>
                <pre style={PRE_STYLE}>
                  {errorDetails}
                </pre>
              </details>
            )}

            {/* Action Buttons */}
            <div style={ACTION_BUTTONS_STYLE}>
              {/* Copy Error Button */}
              <button
                onClick={this.handleCopyError}
                aria-label={t('errorBoundary.copyError', 'Copy Error Info')}
                style={copyButtonStyle}
                onMouseOver={(e) => {
                  if (!this.state.copied) {
                    e.currentTarget.style.backgroundColor =
                      'var(--vscode-button-hoverBackground, #1177bb)';
                  }
                }}
                onMouseOut={(e) => {
                  if (!this.state.copied) {
                    e.currentTarget.style.backgroundColor =
                      'var(--vscode-button-background, #0e639c)';
                  }
                }}
              >
                <span
                  className={this.state.copied ? 'codicon codicon-check' : 'codicon codicon-copy'}
                  style={BUTTON_ICON_STYLE}
                />
                {this.state.copied
                  ? t('errorBoundary.copied', 'Copied!')
                  : t('errorBoundary.copyError', 'Copy Error Info')}
              </button>

              {/* Reload Button */}
              <button
                onClick={this.handleReset}
                aria-label={t('errorBoundary.reload', 'Reload Application')}
                style={RELOAD_BUTTON_STYLE}
                onMouseOver={(e) => {
                  e.currentTarget.style.backgroundColor =
                    'var(--vscode-button-secondaryHoverBackground, #45494e)';
                }}
                onMouseOut={(e) => {
                  e.currentTarget.style.backgroundColor =
                    'var(--vscode-button-secondaryBackground, #3a3d41)';
                }}
              >
                <span className="codicon codicon-refresh" style={BUTTON_ICON_STYLE} />
                {t('errorBoundary.reload', 'Reload Application')}
              </button>
            </div>

            {/* Help text */}
            <p style={HELP_TEXT_STYLE}>
              {t('errorBoundary.helpText', 'If the problem persists, please copy the error information and submit it as an issue on GitHub, or share it in the community group.')}
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
