import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SPECIAL_PROVIDER_IDS, type CodexProviderConfig, type ProviderConfig } from '../../../types/provider';
import { sendBridgeEvent } from '../../../utils/bridge';
import {
  subscribeActiveCodexProvider,
  subscribeActiveProvider,
  subscribeCodexProviderList,
  subscribeProviderList,
} from '../../../utils/runtimeProviderCapabilities';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';

const DISABLED_OPTION_STYLE: React.CSSProperties = { cursor: 'default' };
const PROVIDER_INFO_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 };
const RELATIVE_INLINE_BLOCK_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };

interface RuntimeProviderSelectProps {
  currentProvider: string;
  embedded?: boolean;
  triggerRef?: React.RefObject<HTMLElement | null>;
  onClose?: () => void;
  onProviderSwitched?: (providerName: string) => void;
}

type RuntimeProvider = ProviderConfig | CodexProviderConfig;

type ProviderKind = 'claude' | 'codex';

const isProviderKind = (provider: string): provider is ProviderKind => provider === 'claude' || provider === 'codex';

const parseProviderList = (json: string): RuntimeProvider[] => {
  const parsed = JSON.parse(json);
  return Array.isArray(parsed) ? parsed : [];
};

/**
 * RuntimeProviderSelect - lightweight active-provider switcher for current engine.
 * Claude mode switches Claude Code providers; Codex mode switches Codex providers.
 */
export const RuntimeProviderSelect = ({ currentProvider, embedded = false, triggerRef, onClose, onProviderSwitched }: RuntimeProviderSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [providersByKind, setProvidersByKind] = useState<Record<ProviderKind, RuntimeProvider[]>>({
    claude: [],
    codex: [],
  });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { positionedStyle, maxHeight: viewportMaxHeight, recalculate } = useDropdownPosition({
    buttonRef: (embedded ? triggerRef : buttonRef) as React.RefObject<HTMLElement | null>,
    dropdownRef,
    submenu: embedded,
    minWidth: embedded ? 260 : 200,
  });

  const providerKind: ProviderKind = currentProvider === 'codex' ? 'codex' : 'claude';
  const visibleProviders = providersByKind[providerKind];
  const activeProvider = useMemo(
    () => visibleProviders.find((provider) => provider.isActive),
    [visibleProviders]
  );

  const getProviderDisplayName = useCallback((provider: RuntimeProvider, kind: ProviderKind) => {
    if (kind === 'claude') {
      if (provider.id === SPECIAL_PROVIDER_IDS.LOCAL_SETTINGS) {
        return t('settings.provider.localProviderName');
      }
      if (provider.id === SPECIAL_PROVIDER_IDS.CLI_LOGIN) {
        return t('settings.provider.cliLoginProviderName');
      }
      if (provider.id === SPECIAL_PROVIDER_IDS.DISABLED) {
        return t('settings.provider.disabled', { defaultValue: 'Disabled' });
      }
    }

    if (kind === 'codex' && provider.id === SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN) {
      return t('settings.codexProvider.dialog.cliLoginProviderName');
    }

    return provider.name || provider.id;
  }, [t]);

  const requestProviders = useCallback((kind: ProviderKind) => {
    setLoading(true);
    sendBridgeEvent(kind === 'codex' ? 'get_codex_providers' : 'get_providers');
  }, []);

  const handleToggle = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    if (!isProviderKind(currentProvider)) {
      return;
    }
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (nextOpen) {
      recalculate();
      requestProviders(providerKind);
    }
  }, [currentProvider, isOpen, providerKind, recalculate, requestProviders]);

  const handleSelect = useCallback((provider: RuntimeProvider) => {
    const eventName = providerKind === 'codex' ? 'switch_codex_provider' : 'switch_provider';
    sendBridgeEvent(eventName, JSON.stringify({ id: provider.id }));
    onProviderSwitched?.(getProviderDisplayName(provider, providerKind));
    setProvidersByKind((previous) => ({
      ...previous,
      [providerKind]: previous[providerKind].map((item) => ({
        ...item,
        isActive: item.id === provider.id,
      })),
    }));
    setIsOpen(false);
    onClose?.();
  }, [getProviderDisplayName, onClose, onProviderSwitched, providerKind]);

  useEffect(() => {
    const unsubscribeProviders = subscribeProviderList((json) => {
      try {
        const providers = parseProviderList(json);
        setProvidersByKind((previous) => ({ ...previous, claude: providers }));
        setLoading(false);
      } catch (error) {
        console.error('[RuntimeProviderSelect] Failed to parse Claude providers:', error);
        setLoading(false);
      }
    });

    const unsubscribeActiveProvider = subscribeActiveProvider((json) => {
      try {
        const activeProvider = JSON.parse(json) as RuntimeProvider;
        if (!activeProvider?.id) return;
        setProvidersByKind((previous) => ({
          ...previous,
          claude: previous.claude.map((provider) => ({
            ...provider,
            isActive: provider.id === activeProvider.id,
          })),
        }));
      } catch (error) {
        console.error('[RuntimeProviderSelect] Failed to parse active Claude provider:', error);
      }
    });

    const unsubscribeCodexProviders = subscribeCodexProviderList((json) => {
      try {
        const providers = parseProviderList(json);
        setProvidersByKind((previous) => ({ ...previous, codex: providers }));
        setLoading(false);
      } catch (error) {
        console.error('[RuntimeProviderSelect] Failed to parse Codex providers:', error);
        setLoading(false);
      }
    });

    const unsubscribeActiveCodexProvider = subscribeActiveCodexProvider((json) => {
      try {
        const activeProvider = JSON.parse(json) as RuntimeProvider;
        if (!activeProvider?.id) return;
        setProvidersByKind((previous) => ({
          ...previous,
          codex: previous.codex.map((provider) => ({
            ...provider,
            isActive: provider.id === activeProvider.id,
          })),
        }));
      } catch (error) {
        console.error('[RuntimeProviderSelect] Failed to parse active Codex provider:', error);
      }
    });

    return () => {
      unsubscribeProviders();
      unsubscribeActiveProvider();
      unsubscribeCodexProviders();
      unsubscribeActiveCodexProvider();
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!embedded) return;
    requestProviders(providerKind);
  }, [embedded, providerKind, requestProviders]);

  useLayoutEffect(() => {
    if (!embedded) return;
    recalculate();
  }, [embedded, recalculate, visibleProviders.length, loading]);

  useLayoutEffect(() => {
    if (embedded || !isOpen) return;
    recalculate();
  }, [embedded, isOpen, recalculate, visibleProviders.length, loading]);

  if (!isProviderKind(currentProvider)) {
    return null;
  }

  const activeName = activeProvider ? getProviderDisplayName(activeProvider, providerKind) : t('config.runtimeProvider.title');

  const dropdownMaxHeight = viewportMaxHeight ? `${Math.min(300, viewportMaxHeight)}px` : '300px';
  const dropdownStyle: React.CSSProperties = {
    minWidth: '260px',
    maxWidth: '360px',
    maxHeight: dropdownMaxHeight,
    overflowY: 'auto',
    ...positionedStyle,
  };

  const renderProviderDropdown = () => (
    <div
      ref={dropdownRef}
      role="listbox"
      className="selector-dropdown runtime-provider-dropdown"
      style={dropdownStyle}
      onMouseEnter={(event) => event.stopPropagation()}
    >
      {loading && visibleProviders.length === 0 ? (
        <div className="selector-option disabled" style={DISABLED_OPTION_STYLE}>
          <span className="codicon codicon-loading codicon-modifier-spin" />
          <span>{t('config.runtimeProvider.loading')}</span>
        </div>
      ) : visibleProviders.length === 0 ? (
        <div className="selector-option disabled" style={DISABLED_OPTION_STYLE}>
          <span className="codicon codicon-info" />
          <span>{t('config.runtimeProvider.empty')}</span>
        </div>
      ) : (
        visibleProviders.map((provider) => {
          const selected = !!provider.isActive;
          const description = provider.remark || ('websiteUrl' in provider ? provider.websiteUrl : undefined);
          return (
            <div
              key={provider.id}
              className={`selector-option ${selected ? 'selected' : ''}`}
              onClick={() => handleSelect(provider)}
              title={description || getProviderDisplayName(provider, providerKind)}
            >
              <span className="codicon codicon-key" />
              <div style={PROVIDER_INFO_STYLE}>
                <span className="runtime-provider-name">{getProviderDisplayName(provider, providerKind)}</span>
                {description ? <span className="model-description">{description}</span> : null}
              </div>
              {selected && <span className="codicon codicon-check check-mark" />}
            </div>
          );
        })
      )}
    </div>
  );

  if (embedded) {
    return renderProviderDropdown();
  }

  return (
    <div style={RELATIVE_INLINE_BLOCK_STYLE}>
      <button
        ref={buttonRef}
        type="button"
        className="selector-button runtime-provider-button"
        onClick={handleToggle}
        aria-label={t('config.runtimeProvider.title')}
        title={`${t('config.runtimeProvider.title')}: ${activeName}`}
      >
        <span className="codicon codicon-vm-connect" />
        <span className="selector-button-text runtime-provider-text">{activeName}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && renderProviderDropdown()}
    </div>
  );
};

export default RuntimeProviderSelect;
