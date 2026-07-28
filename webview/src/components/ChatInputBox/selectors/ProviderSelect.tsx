import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_PROVIDERS } from '../types';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import {
  fetchCodexSubscriptionQuota,
  subscribeCodexSubscriptionQuota,
  type CodexSubscriptionQuotaSnapshot,
} from '../../../utils/codexSubscriptionQuotaCapabilities';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';

const RELATIVE_INLINE_BLOCK_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };
const DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  zIndex: 10000,
  maxWidth: 'calc(100vw - 16px)',
};
const TOAST_STYLE: React.CSSProperties = { zIndex: 20000 };
/** Gap (px) between the floating quota panel and the top of the provider dropdown. */
const SUBMENU_GAP_PX = 4;
const SUBMENU_STYLE: React.CSSProperties = {
  // Float the quota panel above the whole dropdown (full-width, never overlapping rows).
  position: 'absolute',
  left: 0,
  right: 0,
  zIndex: 10001,
  whiteSpace: 'normal',
};
const SUBMENU_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  alignItems: 'flex-start',
};
const SUBMENU_SECTION_STYLE: React.CSSProperties = {
  padding: '6px 12px',
};
const SUBMENU_DIVIDER_STYLE: React.CSSProperties = {
  height: '1px',
  background: 'var(--dropdown-border)',
};

function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Math.trunc(value).toLocaleString();
}

function getProviderOptionStyle(enabled: boolean): React.CSSProperties {
  return {
    opacity: enabled ? 1 : 0.5,
    cursor: enabled ? 'pointer' : 'not-allowed',
  };
}

interface ProviderSelectProps {
  value: string;
  onChange?: (providerId: string) => void;
  /** When true, shows only the provider icon without text or chevron */
  compact?: boolean;
}

/**
 * ProviderSelect - AI provider selector component
 * Supports switching between Claude, Codex, Gemini, and other providers
 * compact mode: icon-only button for toolbar use
 */
export const ProviderSelect = ({ value, onChange, compact = false }: ProviderSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [activeSubmenu, setActiveSubmenu] = useState<'none' | 'codexQuota'>('none');
  const [codexQuota, setCodexQuota] = useState<CodexSubscriptionQuotaSnapshot | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(false);
  // Distance (px) from the Codex row's bottom edge up to the floating quota panel,
  // so it hovers just above the entire dropdown instead of overlapping provider rows.
  const [submenuBottom, setSubmenuBottom] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { positionedStyle, recalculate } = useDropdownPosition({ buttonRef, dropdownRef });

  const currentProvider = AVAILABLE_PROVIDERS.find(p => p.id === value) || AVAILABLE_PROVIDERS[0];

  // Helper function to get translated provider label
  const getProviderLabel = (providerId: string) => {
    return t(`providers.${providerId}.label`);
  };

  /**
   * Toggle dropdown
   */
  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    setActiveSubmenu('none');
    if (nextOpen) {
      recalculate();
    }
  }, [isOpen, recalculate]);

  /**
   * Show toast message
   */
  const showToastMessage = useCallback((message: string) => {
    setToastMessage(message);
    setShowToast(true);
    setTimeout(() => {
      setShowToast(false);
    }, 1500);
  }, []);

  const requestCodexQuota = useCallback(() => {
    setQuotaLoading(true);
    fetchCodexSubscriptionQuota();
  }, []);

  useEffect(() => {
    const unsubscribe = subscribeCodexSubscriptionQuota((snapshot) => {
      setCodexQuota(snapshot);
      setQuotaLoading(false);
    });
    return unsubscribe;
  }, []);

  /**
   * Select provider
   */
  const handleSelect = useCallback((providerId: string) => {
    const provider = AVAILABLE_PROVIDERS.find(p => p.id === providerId);

    if (!provider) return;

    if (!provider.enabled) {
      // If provider is unavailable, show toast
      showToastMessage(t('settings.provider.featureComingSoon'));
      setIsOpen(false);
      return;
    }

    // Provider available, perform switch
    onChange?.(providerId);
    setIsOpen(false);
  }, [onChange, showToastMessage]);

  /**
   * Close on outside click
   */
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    // Delay adding event listener to prevent immediate trigger
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || activeSubmenu !== 'codexQuota') return;
    requestCodexQuota();
  }, [activeSubmenu, isOpen, requestCodexQuota]);

  useLayoutEffect(() => {
    if (isOpen) {
      recalculate();
    }
  }, [isOpen, recalculate]);

  const renderCodexQuotaSubmenu = () => {
    const fiveHour = codexQuota?.windows.fiveHour;
    const weekly = codexQuota?.windows.weekly;
    // API-key providers are billed per token and have no subscription quota,
    // so the window rows would only ever show "Unavailable" noise.
    const isApiKeyMode = codexQuota?.reasonCode === 'api_key_mode';

    const renderWindowRow = (
      label: string,
      window: CodexSubscriptionQuotaSnapshot['windows']['fiveHour'] | undefined,
      isLast: boolean,
    ) => {
      const hasLimit = typeof window?.limitTokens === 'number' && Number.isFinite(window.limitTokens);
      const hasRemaining = typeof window?.remainingTokens === 'number' && Number.isFinite(window.remainingTokens);
      const limitTokens = typeof window?.limitTokens === 'number' ? window.limitTokens : undefined;
      const remainingTokens = typeof window?.remainingTokens === 'number' ? window.remainingTokens : undefined;
      const remainingPercentFromApi = typeof window?.remainingPercent === 'number' && Number.isFinite(window.remainingPercent)
        ? window.remainingPercent
        : null;
      const remainingPercent = remainingPercentFromApi !== null
        ? Math.max(0, Math.min(100, Math.round(remainingPercentFromApi)))
        : hasLimit && hasRemaining && (limitTokens ?? 0) > 0
          ? Math.max(0, Math.min(100, Math.round(((remainingTokens ?? 0) / (limitTokens ?? 1)) * 100)))
          : null;
      const hasUsedTokens = typeof window?.usedTokens === 'number' && Number.isFinite(window.usedTokens) && window.usedTokens > 0;
      const resetsAt = typeof window?.resetsAt === 'number' && Number.isFinite(window.resetsAt)
        ? new Date(window.resetsAt).toLocaleString()
        : null;
      return (
        <div style={SUBMENU_SECTION_STYLE}>
          <div className="selector-option" style={SUBMENU_ROW_STYLE}>
            <span>{label}</span>
            <span className="model-description">
              {window
                ? remainingPercent !== null
                  ? resetsAt
                    ? t('config.codexQuota.windowRemainingPercentWithReset', {
                        percent: remainingPercent,
                        value: resetsAt,
                        defaultValue: '{{percent}}% remaining · Resets {{value}}',
                      })
                    : t('config.codexQuota.windowRemainingPercent', {
                      percent: remainingPercent,
                      defaultValue: '{{percent}}% remaining',
                    })
                  : hasUsedTokens
                    ? t('config.codexQuota.windowUsedOnly', {
                      used: formatTokens(window.usedTokens),
                      defaultValue: '{{used}} used',
                    })
                    : t('config.codexQuota.windowUnavailable', { defaultValue: 'Unavailable' })
                : t('config.codexQuota.windowUnavailable', { defaultValue: 'Unavailable' })}
            </span>
          </div>
          {!isLast && <div style={SUBMENU_DIVIDER_STYLE} />}
        </div>
      );
    };

    return (
      <div
        className="selector-dropdown"
        style={{ ...SUBMENU_STYLE, bottom: `${submenuBottom}px` }}
        onClick={(e) => e.stopPropagation()}
        onMouseEnter={(e) => {
          e.stopPropagation();
          setActiveSubmenu('codexQuota');
        }}
      >
        <div className="selector-option disabled" style={{ cursor: 'default' }}>
          <span className="codicon codicon-dashboard" />
          <div style={SUBMENU_ROW_STYLE}>
            <span>{t('config.codexQuota.title', { defaultValue: 'Codex quota' })}</span>
            <span className="model-description">
              {isApiKeyMode
                ? t('config.codexQuota.apiKeyMode', { defaultValue: 'API key mode has no subscription quota' })
                : codexQuota?.status === 'ok'
                  ? t('config.codexQuota.lastUpdated', {
                      value: new Date(codexQuota.fetchedAt).toLocaleString(),
                      defaultValue: 'Updated {{value}}',
                    })
                  : quotaLoading
                    ? t('config.codexQuota.loading', { defaultValue: 'Loading...' })
                    : t('config.codexQuota.unavailable', { defaultValue: 'Unavailable' })}
              </span>
          </div>
        </div>
        {!isApiKeyMode && (
          <>
            <div style={SUBMENU_DIVIDER_STYLE} />
            {renderWindowRow(t('config.codexQuota.fiveHour', { defaultValue: '5h usage' }), fiveHour, false)}
            {renderWindowRow(t('config.codexQuota.weekly', { defaultValue: 'Weekly usage' }), weekly, true)}
          </>
        )}
      </div>
    );
  };

  return (
    <>
      <div style={RELATIVE_INLINE_BLOCK_STYLE}>
        <button
          ref={buttonRef}
          className={`selector-button${compact ? ' provider-compact' : ''}`}
          onClick={handleToggle}
          title={`${t('config.switchProvider')}: ${getProviderLabel(currentProvider.id)}`}
        >
          <ProviderModelIcon providerId={currentProvider.id} size={compact ? 16 : 12} colored={compact} />
          {!compact && (
            <>
              <span>{getProviderLabel(currentProvider.id)}</span>
              <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
            </>
          )}
        </button>

        {isOpen && (
          <div
            ref={dropdownRef}
            className="selector-dropdown"
            style={{ ...DROPDOWN_STYLE, ...positionedStyle }}
          >
            {AVAILABLE_PROVIDERS.map((provider) => (
              <div
                key={provider.id}
                className={`selector-option ${provider.id === value ? 'selected' : ''} ${!provider.enabled ? 'disabled' : ''}`}
                onClick={() => handleSelect(provider.id)}
                style={{
                  ...getProviderOptionStyle(!!provider.enabled),
                  ...(provider.id === 'codex' ? { position: 'relative' } : {}),
                }}
                data-provider-id={provider.id}
                onMouseEnter={(e) => {
                  if (provider.id === 'codex') {
                    // Float the quota panel just above the entire dropdown so it
                    // never overlaps the provider rows, regardless of panel width.
                    const rowRect = e.currentTarget.getBoundingClientRect();
                    const dropdownRect = dropdownRef.current?.getBoundingClientRect();
                    const bottomOffset = dropdownRect
                      ? rowRect.bottom - dropdownRect.top + SUBMENU_GAP_PX
                      : rowRect.height + SUBMENU_GAP_PX;
                    setSubmenuBottom(Math.round(bottomOffset));
                    setActiveSubmenu('codexQuota');
                  } else {
                    setActiveSubmenu('none');
                  }
                }}
                onMouseLeave={() => {
                  if (provider.id === 'codex') {
                    setActiveSubmenu('none');
                  }
                }}
              >
                <ProviderModelIcon providerId={provider.id} size={16} colored />
                <span>{getProviderLabel(provider.id)}</span>
                {provider.id === value && (
                  <span className="codicon codicon-check check-mark" />
                )}
                {provider.id === 'codex' && (
                  <span
                    className="codicon codicon-chevron-right"
                    style={{ fontSize: '10px', marginLeft: provider.id === value ? '2px' : 'auto' }}
                  />
                )}
                {provider.id === 'codex' && activeSubmenu === 'codexQuota' && (
                  renderCodexQuotaSubmenu()
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Toast message */}
      {showToast && createPortal(
        <div className="selector-toast" style={TOAST_STYLE}>
          {toastMessage}
        </div>,
        document.body
      )}
    </>
  );
};

export default ProviderSelect;
