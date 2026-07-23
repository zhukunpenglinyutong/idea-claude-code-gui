import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  petBridge,
  BUBBLE_EVENTS,
  DEFAULT_BUBBLE_TEMPLATES,
  type CodexPetBubbleEvent,
  type CodexPetBubbleSize,
  type CodexPetScope,
  type CatalogColumnCount,
  type CatalogPageSize,
  type CatalogSort,
  type CodexPetConfig,
  type HatchPetStatus,
  type LocalCodexPet,
  type PetdexCatalogPet,
} from '../../codexPet/petBridge';
import { useUIState } from '../../../contexts/UIStateContext';
import styles from './style.module.less';

interface PetSettingsSectionProps {
  addToast: (message: string, type?: 'success' | 'error' | 'warning' | 'info') => void;
}

const DEFAULT_CONFIG: CodexPetConfig = {
  enabled: true,
  selectedPetId: 'builtin',
  size: 96,
  opacity: 1,
  positionX: 0.88,
  positionY: 0.78,
  petdexConnectTimeoutSeconds: 30,
  petdexRequestTimeoutSeconds: 60,
  petdexRetryAttempts: 3,
  catalogColumns: 4,
  catalogPageSize: 12,
  catalogSort: 'default',
  showStatusIndicator: false,
  bubbleEnabled: true,
  bubbleDurationSeconds: 4,
  bubbleSize: 'medium',
  bubbleShowForBackgroundTabs: false,
  bubbleTemplates: DEFAULT_BUBBLE_TEMPLATES,
  scope: 'project',
};
const CATALOG_COLUMN_OPTIONS: CatalogColumnCount[] = [3, 4, 5, 6];
const CATALOG_PAGE_SIZE_OPTIONS: CatalogPageSize[] = [12, 24, 36, 48];
const MAX_CATALOG_QUERY_LENGTH = 100;
const BUBBLE_SIZE_OPTIONS: CodexPetBubbleSize[] = ['small', 'medium', 'large', 'xlarge'];
const CATALOG_SORT_OPTIONS: CatalogSort[] = [
  'default',
  'name_asc',
  'name_desc',
  'author_asc',
  'kind_asc',
  'slug_asc',
];
const SCOPE_OPTIONS: CodexPetScope[] = ['project', 'global'];
type PendingPetOperation = {
  operation: 'install' | 'uninstall' | 'alias';
  slug: string;
};
type PetSettingsTab = 'basic' | 'bubble' | 'local' | 'petdex';
const PET_TABS: Array<{ key: PetSettingsTab; labelKey: string; icon: string }> = [
  { key: 'basic', labelKey: 'settings.pet.tabs.basic', icon: 'codicon-hubot' },
  { key: 'bubble', labelKey: 'settings.pet.tabs.bubble', icon: 'codicon-comment-discussion' },
  { key: 'local', labelKey: 'settings.pet.tabs.local', icon: 'codicon-folder-opened' },
  { key: 'petdex', labelKey: 'settings.pet.tabs.petdex', icon: 'codicon-globe' },
];
const PET_ERROR_TRANSLATIONS: Record<string, string> = {
  PETDEX_CONNECT_TIMEOUT: 'settings.pet.connectTimeoutError',
  PETDEX_REQUEST_TIMEOUT: 'settings.pet.requestTimeoutError',
  PETDEX_NETWORK_ERROR: 'settings.pet.networkError',
  PET_NOT_FOUND: 'settings.pet.petNotFound',
  PET_NOT_INSTALLED: 'settings.pet.petNotFound',
  PET_ALREADY_INSTALLED: 'settings.pet.alreadyInstalled',
  PETDEX_RESPONSE_TOO_LARGE: 'settings.pet.resourceTooLarge',
  INVALID_PET_JSON: 'settings.pet.invalidPackage',
  INVALID_PET_SLUG: 'settings.pet.invalidPackage',
  PET_PATH_OUTSIDE_ROOT: 'settings.pet.invalidPackage',
  PET_NOT_MANAGED_BY_PLUGIN: 'settings.pet.invalidPackage',
  PET_ALIAS_TOO_LONG: 'settings.pet.aliasTooLong',
  INVALID_PET_ALIAS: 'settings.pet.invalidAlias',
  PET_ALIAS_UPDATE_FAILED: 'settings.pet.aliasUpdateFailed',
  LOCAL_PET_OPERATION_FAILED: 'settings.pet.localPetOperationFailed',
  PET_DIRECTORY_UNAVAILABLE: 'settings.pet.petDirectoryUnavailable',
  INVALID_HATCH_PET_ACTION: 'settings.pet.hatchCommandFailed',
  HATCH_PET_SKILL_NOT_READY: 'settings.pet.hatchSkillNotReady',
  HATCH_PET_INPUT_REQUIRED: 'settings.pet.hatchInputRequired',
  HATCH_PET_REQUIRES_CODEX: 'settings.pet.hatchRequiresCodex',
  HATCH_PET_COMMAND_INSERT_FAILED: 'settings.pet.hatchCommandFailed',
  PETDEX_URL_NOT_ALLOWED: 'settings.pet.invalidPackage',
  PETDEX_REDIRECT_WITHOUT_LOCATION: 'settings.pet.networkError',
  PETDEX_TOO_MANY_REDIRECTS: 'settings.pet.networkError',
  INVALID_PETDEX_MANIFEST: 'settings.pet.invalidPackage',
  EMPTY_PETDEX_MANIFEST: 'settings.pet.invalidPackage',
  INVALID_PETDEX_SPRITESHEET: 'settings.pet.invalidPackage',
  UNDECODABLE_PETDEX_SPRITESHEET: 'settings.pet.invalidPackage',
  UNSUPPORTED_PETDEX_IMAGE: 'settings.pet.invalidPackage',
  PETDEX_PREVIEW_ENCODING_FAILED: 'settings.pet.invalidPackage',
};

function petErrorDescriptor(error: string): { key: string; params?: Record<string, string> } {
  const translationKey = PET_ERROR_TRANSLATIONS[error];
  if (translationKey) return { key: translationKey };
  if (error.startsWith('PETDEX_HTTP_')) {
    return { key: 'settings.pet.httpError', params: { status: error.slice('PETDEX_HTTP_'.length) } };
  }
  return { key: 'settings.pet.unknownError', params: { code: error } };
}

function normalizeAliasDraft(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeCatalogQuery(value: string): string {
  return value.trim().toLowerCase().slice(0, MAX_CATALOG_QUERY_LENGTH);
}

function SpritePreview({ src, spriteSheet }: { src: string; spriteSheet: boolean }) {
  if (spriteSheet) {
    return <span className={styles.spritePreview} style={{ backgroundImage: `url("${src}")` }} />;
  }
  return <img className={styles.staticPreview} src={src} alt="" draggable={false} />;
}

function LocalPetPreview({ pet }: { pet: LocalCodexPet }) {
  const [preview, setPreview] = useState(() => pet.dataUrl
    ? { dataUrl: pet.dataUrl, spriteSheet: pet.spriteSheet }
    : null);
  const [loading, setLoading] = useState(!pet.dataUrl);

  useEffect(() => {
    if (pet.dataUrl) {
      setPreview({ dataUrl: pet.dataUrl, spriteSheet: pet.spriteSheet });
      setLoading(false);
      return undefined;
    }
    setPreview(null);
    setLoading(true);
    const unsubscribe = petBridge.subscribeLocalPreview((payload) => {
      if (payload.petId !== pet.id) return;
      setLoading(false);
      setPreview(payload.dataUrl
        ? { dataUrl: payload.dataUrl, spriteSheet: payload.spriteSheet }
        : null);
    });
    petBridge.getLocalPreview(pet.id);
    return unsubscribe;
  }, [pet.dataUrl, pet.id, pet.spriteSheet]);

  if (preview) {
    return <SpritePreview src={preview.dataUrl} spriteSheet={preview.spriteSheet} />;
  }
  return (
    <span
      className={`codicon ${loading ? `codicon-loading ${styles.spinning}` : 'codicon-warning'}`}
      aria-hidden="true"
    />
  );
}

function RemoteSpritePreview({
  slug,
  label,
  unavailableLabel,
}: {
  slug: string;
  label: string;
  unavailableLabel: string;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  useEffect(() => {
    setStatus('loading');
    setDataUrl(null);
    setErrorCode(null);
    const unsubscribe = petBridge.subscribePreview((preview) => {
      if (preview.slug !== slug) return;
      if (preview.dataUrl) {
        setDataUrl(preview.dataUrl);
        setStatus('loaded');
      } else {
        setErrorCode(preview.error ?? null);
        setStatus('error');
      }
    });
    petBridge.getPreview(slug);
    return unsubscribe;
  }, [slug]);

  const errorText = errorCode
    ? (() => {
        const descriptor = petErrorDescriptor(errorCode);
        return t(descriptor.key, descriptor.params);
      })()
    : unavailableLabel;

  return (
    <div
      className={`${styles.remotePreview}${status === 'loaded' ? ` ${styles.remotePreviewLoaded}` : ''}`}
      role="img"
      aria-label={label}
      style={status === 'loaded' && dataUrl
        ? { backgroundImage: `url(${JSON.stringify(dataUrl)})` }
        : undefined}
    >
      {status === 'loading' && (
        <span className={`codicon codicon-loading ${styles.spinning}`} aria-hidden="true" />
      )}
      {status === 'error' && (
        <span
          className={`codicon codicon-warning ${styles.previewError}`}
          title={errorText}
          aria-label={errorText}
        />
      )}
    </div>
  );
}

interface PetSelectOption {
  value: string;
  label: string;
  detail: string;
  searchText: string;
}

function SearchablePetSelect({
  value,
  options,
  ariaLabel,
  searchPlaceholder,
  emptyLabel,
  onChange,
}: {
  value: string;
  options: PetSelectOption[];
  ariaLabel: string;
  searchPlaceholder: string;
  emptyLabel: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredOptions = useMemo(() => normalizedQuery
    ? options.filter((option) => option.searchText.includes(normalizedQuery))
    : options, [normalizedQuery, options]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(Math.max(0, options.findIndex((option) => option.value === value)));
    inputRef.current?.focus();
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [open, options, value]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, open]);

  const selectOption = useCallback((option: PetSelectOption) => {
    onChange(option.value);
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, [onChange]);

  return (
    <div className={styles.petSelect} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={styles.petSelectTrigger}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls="codex-pet-select-options"
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{selected?.label ?? value}</span>
        <span className="codicon codicon-chevron-down" aria-hidden="true" />
      </button>
      {open && (
        <div className={styles.petSelectPopover}>
          <label className={styles.petSelectSearch}>
            <span className="codicon codicon-search" aria-hidden="true" />
            <input
              ref={inputRef}
              type="search"
              value={query}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              aria-activedescendant={filteredOptions[activeIndex]
                ? `codex-pet-option-${activeIndex}`
                : undefined}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setOpen(false);
                  window.requestAnimationFrame(() => triggerRef.current?.focus());
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  if (filteredOptions.length > 0) {
                    setActiveIndex((current) => Math.min(current + 1, filteredOptions.length - 1));
                  }
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setActiveIndex((current) => Math.max(0, current - 1));
                } else if (event.key === 'Enter' && filteredOptions[activeIndex]) {
                  event.preventDefault();
                  selectOption(filteredOptions[activeIndex]);
                }
              }}
            />
          </label>
          <div id="codex-pet-select-options" className={styles.petSelectOptions} role="listbox">
            {filteredOptions.map((option, index) => (
              <button
                type="button"
                id={`codex-pet-option-${index}`}
                ref={(element) => { optionRefs.current[index] = element; }}
                role="option"
                aria-selected={option.value === value}
                key={option.value}
                className={index === activeIndex ? styles.petSelectOptionActive : styles.petSelectOption}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => selectOption(option)}
              >
                <span>{option.label}</span>
                <small>{option.detail}</small>
              </button>
            ))}
            {filteredOptions.length === 0 && <div className={styles.petSelectEmpty}>{emptyLabel}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function PetSettingsSection({ addToast }: PetSettingsSectionProps) {
  const { t } = useTranslation();
  const { draftInput, setDraftInput, setCurrentView } = useUIState();
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [activeTab, setActiveTab] = useState<PetSettingsTab>('basic');
  const [localPets, setLocalPets] = useState<LocalCodexPet[]>([]);
  const [catalog, setCatalog] = useState<PetdexCatalogPet[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [pendingPetOperation, setPendingPetOperation] = useState<PendingPetOperation | null>(null);
  const [search, setSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [hatchStatus, setHatchStatus] = useState<HatchPetStatus | null>(null);
  const [hatchName, setHatchName] = useState('');
  const [hatchDescription, setHatchDescription] = useState('');
  const [hatchStyle, setHatchStyle] = useState('auto');
  const [hatchReference, setHatchReference] = useState('');
  const searchRef = useRef('');
  const currentPageRef = useRef(1);
  const catalogPageSizeRef = useRef(DEFAULT_CONFIG.catalogPageSize);
  const catalogSortRef = useRef(DEFAULT_CONFIG.catalogSort);
  const catalogRequestIdRef = useRef(0);

  const requestCatalog = useCallback((
    forceRefresh: boolean,
    query: string,
    offset: number,
    limit: CatalogPageSize,
    sort: CatalogSort,
  ) => {
    const normalizedQuery = normalizeCatalogQuery(query);
    const requestId = ++catalogRequestIdRef.current;
    petBridge.getCatalog(forceRefresh, normalizedQuery, offset, limit, sort, requestId);
  }, []);

  useEffect(() => {
    searchRef.current = normalizeCatalogQuery(search);
  }, [search]);

  useEffect(() => {
    catalogPageSizeRef.current = config.catalogPageSize;
    catalogSortRef.current = config.catalogSort;
  }, [config.catalogPageSize, config.catalogSort]);

  useEffect(() => {
    const unsubscribeConfig = petBridge.subscribeConfig(setConfig);
    const unsubscribeLocal = petBridge.subscribeLocalPets(setLocalPets);
    const unsubscribeAssets = petBridge.subscribeAssetChanges(() => {
      petBridge.getConfig();
      petBridge.getLocalPets();
      setCatalogLoading(true);
      setCatalogError(null);
      requestCatalog(
        false,
        searchRef.current,
        (currentPageRef.current - 1) * catalogPageSizeRef.current,
        catalogPageSizeRef.current,
        catalogSortRef.current,
      );
    });
    const unsubscribeCatalog = petBridge.subscribeCatalog((payload) => {
      if (payload.requestId !== undefined && payload.requestId !== catalogRequestIdRef.current) return;
      if (payload.query !== searchRef.current) return;
      if (payload.limit !== catalogPageSizeRef.current) return;
      if (payload.sort !== catalogSortRef.current) return;
      const responsePage = Math.floor(payload.offset / catalogPageSizeRef.current) + 1;
      setCatalog(payload.pets);
      setCurrentPage(responsePage);
      setPageInput(String(responsePage));
      currentPageRef.current = responsePage;
      setCatalogTotal(payload.total);
      setCatalogError(payload.error ?? null);
      setCatalogLoading(false);
    });
    const unsubscribeOperation = petBridge.subscribeOperation((operation) => {
      setPendingPetOperation((pending) => pending
        && pending.operation === operation.operation
        && pending.slug === operation.slug
        ? null
        : pending);
      if (operation.success) {
        const successKey = operation.operation === 'install'
          ? 'settings.pet.installSuccess'
          : operation.operation === 'uninstall'
            ? 'settings.pet.uninstallSuccess'
            : operation.operation === 'alias'
              ? 'settings.pet.aliasSuccess'
              : null;
        if (successKey) {
          addToast(t(successKey), 'success');
        }
        if (['install', 'uninstall', 'alias'].includes(operation.operation)) {
          setCatalogLoading(true);
          requestCatalog(
            operation.operation !== 'alias',
            searchRef.current,
            (currentPageRef.current - 1) * catalogPageSizeRef.current,
            catalogPageSizeRef.current,
            catalogSortRef.current,
          );
        }
      } else {
        const error = operation.error ?? 'UNKNOWN';
        const descriptor = petErrorDescriptor(error);
        addToast(t('settings.pet.operationFailed', {
          error: t(descriptor.key, descriptor.params),
        }), 'error');
      }
    });
    const unsubscribeHatchStatus = petBridge.subscribeHatchStatus(setHatchStatus);
    const unsubscribeHatchReference = petBridge.subscribeHatchReference(setHatchReference);
    const unsubscribeHatchCommand = petBridge.subscribeHatchCommand((command) => {
      setDraftInput(command);
      addToast(t('settings.pet.hatchCommandPrepared'), 'success');
      setCurrentView('chat');
    });
    petBridge.getConfig();
    petBridge.getLocalPets();
    petBridge.getHatchStatus();
    return () => {
      unsubscribeConfig();
      unsubscribeLocal();
      unsubscribeAssets();
      unsubscribeCatalog();
      unsubscribeOperation();
      unsubscribeHatchStatus();
      unsubscribeHatchReference();
      unsubscribeHatchCommand();
    };
  }, [addToast, requestCatalog, setCurrentView, setDraftInput, t]);

  useEffect(() => {
    setCurrentPage(1);
    setPageInput('1');
    currentPageRef.current = 1;
    setCatalog([]);
    setCatalogLoading(true);
    setCatalogError(null);
    const timer = window.setTimeout(() => {
      requestCatalog(false, search, 0, config.catalogPageSize, config.catalogSort);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [requestCatalog, search, config.catalogPageSize, config.catalogSort]);

  const updateConfig = useCallback((patch: Partial<CodexPetConfig>) => {
    setConfig((current) => ({ ...current, ...patch }));
    petBridge.setConfig(patch);
  }, []);
  const updateConfigDraft = useCallback((patch: Partial<CodexPetConfig>) => {
    setConfig((current) => ({ ...current, ...patch }));
  }, []);
  const parseTemplateLines = useCallback((value: string): string[] => value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10), []);
  const updateBubbleTemplates = useCallback((
    event: CodexPetBubbleEvent,
    value: string,
    persist: boolean,
  ) => {
    const templates = {
      ...config.bubbleTemplates,
      [event]: parseTemplateLines(value),
    };
    if (persist) {
      updateConfig({ bubbleTemplates: templates });
    } else {
      updateConfigDraft({ bubbleTemplates: templates });
    }
  }, [config.bubbleTemplates, parseTemplateLines, updateConfig, updateConfigDraft]);

  const currentPet = localPets.find((pet) => pet.id === config.selectedPetId);
  const [aliasDraft, setAliasDraft] = useState('');
  useEffect(() => {
    setAliasDraft(currentPet?.alias ?? '');
  }, [currentPet?.alias, currentPet?.id]);
  const petOptions = useMemo<PetSelectOption[]>(() => {
    const options: PetSelectOption[] = [{
      value: 'builtin',
      label: 'Codex',
      detail: 'builtin',
      searchText: 'codex builtin',
    }];
    for (const pet of localPets) {
      const originalName = pet.originalName ?? pet.name;
      options.push({
        value: pet.id,
        label: pet.name,
        detail: pet.id,
        searchText: `${pet.name} ${originalName} ${pet.alias ?? ''} ${pet.id}`.toLocaleLowerCase(),
      });
    }
    if (config.selectedPetId !== 'builtin' && !localPets.some((pet) => pet.id === config.selectedPetId)) {
      options.push({
        value: config.selectedPetId,
        label: config.selectedPetId.split('/')[0],
        detail: config.selectedPetId,
        searchText: config.selectedPetId.toLocaleLowerCase(),
      });
    }
    return options;
  }, [config.selectedPetId, localPets]);
  const refreshCatalog = useCallback(() => {
    setCatalogLoading(true);
    setCatalogError(null);
    requestCatalog(
      true,
      search,
      (currentPageRef.current - 1) * config.catalogPageSize,
      config.catalogPageSize,
      config.catalogSort,
    );
  }, [requestCatalog, search, config.catalogPageSize, config.catalogSort]);

  const totalPages = Math.max(1, Math.ceil(catalogTotal / config.catalogPageSize));
  const catalogErrorDescriptor = catalogError ? petErrorDescriptor(catalogError) : null;
  const goToPage = useCallback((page: number) => {
    const nextPage = Math.max(1, Math.min(page, totalPages));
    currentPageRef.current = nextPage;
    setPageInput(String(nextPage));
    setCatalogLoading(true);
    setCatalogError(null);
    requestCatalog(
      false,
      search,
      (nextPage - 1) * config.catalogPageSize,
      config.catalogPageSize,
      config.catalogSort,
    );
  }, [requestCatalog, search, totalPages, config.catalogPageSize, config.catalogSort]);

  const commitPageInput = useCallback(() => {
    const parsedPage = Number.parseInt(pageInput, 10);
    if (!Number.isFinite(parsedPage)) {
      setPageInput(String(currentPage));
      return;
    }
    goToPage(parsedPage);
  }, [currentPage, goToPage, pageInput]);

  const installPet = useCallback((slug: string) => {
    setPendingPetOperation({ operation: 'install', slug });
    petBridge.install(slug);
  }, []);

  const uninstallPet = useCallback((slug: string) => {
    setPendingPetOperation({ operation: 'uninstall', slug });
    petBridge.uninstall(slug);
  }, []);

  const saveAlias = useCallback((alias: string) => {
    const normalizedAlias = normalizeAliasDraft(alias);
    if (!currentPet?.managed
      || !currentPet.slug
      || pendingPetOperation !== null
      || normalizedAlias === (currentPet.alias ?? '')) return;
    setPendingPetOperation({ operation: 'alias', slug: currentPet.slug });
    petBridge.setAlias(currentPet.slug, normalizedAlias);
  }, [currentPet, pendingPetOperation]);

  const prepareHatchCommand = useCallback((action: 'install' | 'create' | 'repair') => {
    if (draftInput.trim() && !window.confirm(t('settings.pet.hatchReplaceDraftConfirm'))) return;
    petBridge.prepareHatchCommand({
      action,
      name: hatchName,
      description: hatchDescription,
      style: hatchStyle,
      referencePath: hatchReference,
    });
  }, [draftInput, hatchDescription, hatchName, hatchReference, hatchStyle, t]);

  return (
    <div className={styles.section}>
      <h3 className={styles.title}>{t('settings.pet.title')}</h3>
      <p className={styles.description}>{t('settings.pet.description')}</p>

      <div className={styles.scopeBar} role="group" aria-label={t('settings.pet.scopeLabel')}>
        <div className={styles.scopeHeader}>
          <span className={styles.scopeTitle}>{t('settings.pet.scopeLabel')}</span>
          <div className={styles.segmentedControl}>
            {SCOPE_OPTIONS.map((scope) => (
              <button
                key={scope}
                type="button"
                className={config.scope === scope ? styles.segmentActive : styles.segment}
                aria-pressed={config.scope === scope}
                onClick={() => updateConfig({ scope })}
              >
                {t(`settings.pet.scopeOptions.${scope}`)}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.scopeCopy} aria-live="polite">
          <p className={styles.scopeDescription}>
            {t(`settings.pet.scopeDescriptions.${config.scope}`)}
          </p>
          <p className={styles.scopePositionHint}>{t('settings.pet.scopePositionHint')}</p>
        </div>
      </div>

      <div className={styles.tabbedGroup}>
        <div className={styles.sectionTabs} role="tablist" aria-label={t('settings.pet.title')}>
          {PET_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              id={`pet-tab-${tab.key}`}
              aria-selected={activeTab === tab.key}
              aria-controls="pet-tabpanel"
              className={activeTab === tab.key ? styles.sectionTabActive : styles.sectionTab}
              onClick={() => setActiveTab(tab.key)}
            >
              <span className={`codicon ${tab.icon}`} aria-hidden="true" />
              {t(tab.labelKey)}
            </button>
          ))}
        </div>
        <div
          className={styles.tabPanel}
          role="tabpanel"
          id="pet-tabpanel"
          aria-labelledby={`pet-tab-${activeTab}`}
        >
          {activeTab === 'basic' && (
            <section className={styles.controlSection}>
              <div className={styles.sectionHeader}>
                <div className={styles.basicHeaderContent}>
                  <h4>{t('settings.pet.floatingTitle')}</h4>
                  <p>{t('settings.pet.floatingDescription')}</p>
                  <div className={styles.basicActions} data-testid="pet-basic-actions">
                    <label className={styles.switchLabel}>
                      <input
                        type="checkbox"
                        checked={config.enabled}
                        onChange={(event) => updateConfig({ enabled: event.target.checked })}
                      />
                      <span>{config.enabled ? t('settings.pet.enabled') : t('settings.pet.disabled')}</span>
                    </label>
                    <label className={styles.switchLabel}>
                      <input
                        type="checkbox"
                        checked={config.showStatusIndicator}
                        onChange={(event) => updateConfig({ showStatusIndicator: event.target.checked })}
                      />
                      <span>{t('settings.pet.showStatusIndicator')}</span>
                    </label>
                    <button type="button" className={styles.secondaryButton} onClick={petBridge.resetPosition}>
                      <span className="codicon codicon-target" aria-hidden="true" />
                      {t('settings.pet.resetPosition')}
                    </button>
                  </div>
                </div>
              </div>

              <div className={styles.previewAndControls}>
                <div className={styles.previewStage} aria-label={t('settings.pet.preview')}>
                  {currentPet ? (
                    <LocalPetPreview pet={currentPet} />
                  ) : (
                    <span className={`codicon codicon-hubot ${styles.builtinPreview}`} aria-hidden="true" />
                  )}
                </div>

                <div className={styles.controls}>
                  <div className={styles.field}>
                    <span>{t('settings.pet.currentPet')}</span>
                    <SearchablePetSelect
                      value={config.selectedPetId}
                      options={petOptions}
                      ariaLabel={t('settings.pet.currentPet')}
                      searchPlaceholder={t('settings.pet.petSearchPlaceholder')}
                      emptyLabel={t('settings.pet.noMatchingLocalPets')}
                      onChange={(selectedPetId) => updateConfig({ selectedPetId })}
                    />
                  </div>

                  {currentPet?.managed && currentPet.slug && (
                    <div className={styles.aliasField}>
                      <div className={styles.field}>
                        <label htmlFor="codex-pet-alias"><span>{t('settings.pet.alias')}</span></label>
                        <div className={styles.aliasEditor}>
                          <input
                            id="codex-pet-alias"
                            type="text"
                            value={aliasDraft}
                            maxLength={60}
                            placeholder={t('settings.pet.aliasPlaceholder', {
                              name: currentPet.originalName ?? currentPet.name,
                            })}
                            onChange={(event) => setAliasDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                saveAlias(aliasDraft);
                              }
                            }}
                          />
                          <button
                            type="button"
                            className={styles.primaryButton}
                            onClick={() => saveAlias(aliasDraft)}
                            disabled={pendingPetOperation !== null
                              || normalizeAliasDraft(aliasDraft) === (currentPet.alias ?? '')}
                          >
                            <span className="codicon codicon-save" aria-hidden="true" />
                            {t('settings.pet.saveAlias')}
                          </button>
                          {(currentPet.alias ?? '').length > 0 && (
                            <button
                              type="button"
                              className={styles.iconButton}
                              title={t('settings.pet.clearAlias')}
                              aria-label={t('settings.pet.clearAlias')}
                              onClick={() => {
                                setAliasDraft('');
                                saveAlias('');
                              }}
                              disabled={pendingPetOperation !== null}
                            >
                              <span className="codicon codicon-discard" aria-hidden="true" />
                            </button>
                          )}
                        </div>
                      </div>
                      <p>{t('settings.pet.aliasDescription')}</p>
                    </div>
                  )}

                  <div className={styles.rangeGrid}>
                    <label className={styles.field}>
                      <span>{t('settings.pet.size')} <strong>{config.size}px</strong></span>
                      <input
                        type="range"
                        min="32"
                        max="512"
                        step="4"
                        value={config.size}
                        onChange={(event) => updateConfig({ size: Number(event.target.value) })}
                      />
                    </label>

                    <label className={styles.field}>
                      <span>{t('settings.pet.opacity')} <strong>{Math.round(config.opacity * 100)}%</strong></span>
                      <input
                        type="range"
                        min="0.3"
                        max="1"
                        step="0.05"
                        value={config.opacity}
                        onChange={(event) => updateConfig({ opacity: Number(event.target.value) })}
                      />
                    </label>
                  </div>

                </div>
              </div>
            </section>
          )}
          {activeTab === 'bubble' && (
            <section className={styles.controlSection}>
              <div className={styles.sectionHeader}>
                <div className={styles.bubbleHeaderContent}>
                  <h4>{t('settings.pet.bubbleTitle')}</h4>
                  <p>{t('settings.pet.bubbleDescription')}</p>
                  <div className={styles.bubbleActions} data-testid="pet-bubble-actions">
                    <label className={styles.switchLabel}>
                      <input
                        type="checkbox"
                        checked={config.bubbleEnabled}
                        onChange={(event) => updateConfig({ bubbleEnabled: event.target.checked })}
                      />
                      <span>{config.bubbleEnabled ? t('settings.pet.enabled') : t('settings.pet.disabled')}</span>
                    </label>
                    <label className={styles.switchLabel}>
                      <input
                        type="checkbox"
                        checked={config.bubbleShowForBackgroundTabs}
                        onChange={(event) => updateConfig({ bubbleShowForBackgroundTabs: event.target.checked })}
                      />
                      <span>{t('settings.pet.bubbleShowForBackgroundTabs')}</span>
                    </label>
                  </div>
                </div>
              </div>

              <div className={styles.bubbleSettings}>
                <label className={styles.field}>
                  <span>{t('settings.pet.bubbleDuration')}</span>
                  <input
                    type="number"
                    min="1"
                    max="20"
                    value={config.bubbleDurationSeconds}
                    onChange={(event) => updateConfigDraft({
                      bubbleDurationSeconds: Number(event.target.value),
                    })}
                    onBlur={(event) => updateConfig({
                      bubbleDurationSeconds: Number(event.currentTarget.value),
                    })}
                  />
                </label>
                <label className={styles.field}>
                  <span>{t('settings.pet.bubbleSize')}</span>
                  <select
                    value={config.bubbleSize}
                    onChange={(event) => updateConfig({ bubbleSize: event.target.value as CodexPetBubbleSize })}
                  >
                    {BUBBLE_SIZE_OPTIONS.map((size) => (
                      <option key={size} value={size}>
                        {t(`settings.pet.bubbleSizes.${size}`)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className={styles.placeholderHint}>
                <span className={styles.placeholderTitle}>{t('settings.pet.templateVariables')}</span>
                <div className={styles.placeholderTableWrap}>
                  <table className={styles.placeholderTable}>
                    <thead>
                      <tr>
                        <th>{t('settings.pet.templateVariableTable.variable')}</th>
                        <th>{t('settings.pet.templateVariableTable.content')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(['tabTitle', 'provider', 'model', 'duration'] as const).map((variable) => (
                        <tr key={variable}>
                          <td><code>{`{${variable}}`}</code></td>
                          <td>{t(`settings.pet.templateVariableTable.${variable}`)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className={styles.templateGrid}>
                {BUBBLE_EVENTS.map((event) => (
                  <label key={event} className={styles.templateField}>
                    <span>{t(`settings.pet.bubbleEvents.${event}`)}</span>
                    <textarea
                      rows={3}
                      value={(config.bubbleTemplates[event] ?? DEFAULT_BUBBLE_TEMPLATES[event]).join('\n')}
                      onChange={(changeEvent) => updateBubbleTemplates(event, changeEvent.target.value, false)}
                      onBlur={(blurEvent) => updateBubbleTemplates(event, blurEvent.currentTarget.value, true)}
                    />
                  </label>
                ))}
              </div>
            </section>
          )}
          {activeTab === 'local' && (
            <section className={styles.controlSection}>
                <div className={styles.hatchHeader}>
                  <div className={styles.hatchTitleRow}>
                    <h4>{t('settings.pet.hatchTitle')}</h4>
                    <span className={`${styles.skillStatus} ${styles[`skillStatus_${hatchStatus?.status ?? 'loading'}`]}`}>
                      {t(`settings.pet.hatchStatus.${hatchStatus?.status ?? 'loading'}`)}
                    </span>
                    <button
                      type="button"
                      className={styles.iconButton}
                      onClick={() => {
                        petBridge.refreshAssets();
                        petBridge.getHatchStatus();
                      }}
                      title={t('settings.pet.refreshLocalPets')}
                      aria-label={t('settings.pet.refreshLocalPets')}
                    >
                      <span className="codicon codicon-refresh" aria-hidden="true" />
                    </button>
                  </div>
                  <p>{t('settings.pet.hatchDescription')}</p>
                  <div className={styles.hatchDirectoryRow}>
                    <button type="button" className={styles.secondaryButton} onClick={petBridge.openPetDirectory}>
                      <span className="codicon codicon-folder-opened" aria-hidden="true" />
                      {t('settings.pet.openPetDirectory')}
                    </button>
                  </div>
                </div>
                {hatchStatus === null ? null : hatchStatus.status !== 'installed' ? (
                  <div className={styles.hatchActions}>
                    <span className={styles.pathText}>{hatchStatus.skillPath}</span>
                    <button type="button" className={styles.primaryButton}
                      onClick={() => prepareHatchCommand('install')}>
                      <span className={`codicon ${hatchStatus.status === 'broken' ? 'codicon-tools' : 'codicon-extensions'}`} aria-hidden="true" />
                      {t(hatchStatus.status === 'broken'
                        ? 'settings.pet.prepareRepairSkill'
                        : 'settings.pet.prepareInstallSkill')}
                    </button>
                    <button type="button" className={styles.secondaryButton} onClick={petBridge.openHatchWebsite}>
                      <span className="codicon codicon-link-external" aria-hidden="true" />
                      {t('settings.pet.hatchOfficialSource')}
                    </button>
                  </div>
                ) : (
                  <div className={styles.hatchForm}>
                    <label className={styles.field}>
                      <span>{t('settings.pet.hatchName')}</span>
                      <input type="text" maxLength={80} value={hatchName}
                        onChange={(event) => setHatchName(event.target.value)} />
                    </label>
                    <label className={styles.field}>
                      <span>{t('settings.pet.hatchStyle')}</span>
                      <select value={hatchStyle} onChange={(event) => setHatchStyle(event.target.value)}>
                        {['auto', 'pixel', 'plush', 'clay', 'sticker', 'flat-vector', '3d-toy', 'painterly', 'brand-inspired']
                          .map((style) => <option key={style} value={style}>{style}</option>)}
                      </select>
                    </label>
                    <label className={`${styles.field} ${styles.hatchDescriptionField}`}>
                      <span>{t('settings.pet.hatchPrompt')}</span>
                      <textarea rows={3} maxLength={500} value={hatchDescription}
                        onChange={(event) => setHatchDescription(event.target.value)} />
                    </label>
                    <div className={styles.referencePicker}>
                      <button type="button" className={styles.secondaryButton} onClick={petBridge.chooseHatchReference}>
                        <span className="codicon codicon-file-media" aria-hidden="true" />
                        {t('settings.pet.chooseReference')}
                      </button>
                      <span className={styles.pathText}>{hatchReference || t('settings.pet.noReference')}</span>
                      {hatchReference && (
                        <button type="button" className={styles.iconButton} onClick={() => setHatchReference('')}
                          title={t('settings.pet.clearReference')} aria-label={t('settings.pet.clearReference')}>
                          <span className="codicon codicon-close" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    <div className={styles.hatchActions}>
                      <button type="button" className={styles.primaryButton}
                        onClick={() => prepareHatchCommand('create')}>
                        <span className="codicon codicon-sparkle" aria-hidden="true" />
                        {t('settings.pet.prepareCreatePet')}
                      </button>
                      <button type="button" className={styles.secondaryButton}
                        onClick={() => prepareHatchCommand('repair')}>
                        <span className="codicon codicon-tools" aria-hidden="true" />
                        {t('settings.pet.prepareRepairPet')}
                      </button>
                    </div>
                  </div>
                )}
            </section>
          )}
          {activeTab === 'petdex' && (
            <section className={styles.catalogSection}>
              <div className={styles.catalogHeader}>
                <div>
                  <h4>{t('settings.pet.petdexTitle')}</h4>
                  <p>{t('settings.pet.petdexDescription')}</p>
                </div>
                <div className={styles.catalogActions}>
                  <button
                    type="button"
                    className={styles.iconButton}
                    onClick={refreshCatalog}
                    disabled={catalogLoading}
                    title={t('settings.pet.refreshCatalog')}
                    aria-label={t('settings.pet.refreshCatalog')}
                  >
                    <span className={`codicon codicon-refresh${catalogLoading ? ` ${styles.spinning}` : ''}`} />
                  </button>
                  <button type="button" className={styles.secondaryButton} onClick={petBridge.openWebsite}>
                    <span className="codicon codicon-link-external" aria-hidden="true" />
                    Petdex
                  </button>
                </div>
              </div>

              <div className={styles.repositorySettings}>
                <label className={styles.field}>
                  <span>{t('settings.pet.connectTimeout')}</span>
                  <input
                    type="number"
                    min="5"
                    max="300"
                    value={config.petdexConnectTimeoutSeconds}
                    onChange={(event) => updateConfigDraft({
                      petdexConnectTimeoutSeconds: Number(event.target.value),
                    })}
                    onBlur={(event) => updateConfig({
                      petdexConnectTimeoutSeconds: Number(event.currentTarget.value),
                    })}
                  />
                </label>
                <label className={styles.field}>
                  <span>{t('settings.pet.requestTimeout')}</span>
                  <input
                    type="number"
                    min="10"
                    max="300"
                    value={config.petdexRequestTimeoutSeconds}
                    onChange={(event) => updateConfigDraft({
                      petdexRequestTimeoutSeconds: Number(event.target.value),
                    })}
                    onBlur={(event) => updateConfig({
                      petdexRequestTimeoutSeconds: Number(event.currentTarget.value),
                    })}
                  />
                </label>
                <label className={styles.field}>
                  <span>{t('settings.pet.retryAttempts')}</span>
                  <input
                    type="number"
                    min="0"
                    max="10"
                    value={config.petdexRetryAttempts}
                    onChange={(event) => updateConfigDraft({
                      petdexRetryAttempts: Number(event.target.value),
                    })}
                    onBlur={(event) => updateConfig({
                      petdexRetryAttempts: Number(event.currentTarget.value),
                    })}
                  />
                </label>
                <label className={styles.field}>
                  <span>{t('settings.pet.catalogColumns')}</span>
                  <select
                    value={config.catalogColumns}
                    onChange={(event) => updateConfig({
                      catalogColumns: Number(event.target.value) as CatalogColumnCount,
                    })}
                  >
                    {CATALOG_COLUMN_OPTIONS.map((columns) => (
                      <option key={columns} value={columns}>
                        {t(`settings.pet.columns${columns}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span>{t('settings.pet.catalogPageSize')}</span>
                  <select
                    value={config.catalogPageSize}
                    onChange={(event) => updateConfig({
                      catalogPageSize: Number(event.target.value) as CatalogPageSize,
                    })}
                  >
                    {CATALOG_PAGE_SIZE_OPTIONS.map((pageSize) => (
                      <option key={pageSize} value={pageSize}>
                        {t('settings.pet.pageSizeOption', { count: pageSize })}
                      </option>
                    ))}
                  </select>
                </label>
                <label className={styles.field}>
                  <span>{t('settings.pet.catalogSort')}</span>
                  <select
                    value={config.catalogSort}
                    onChange={(event) => updateConfig({ catalogSort: event.target.value as CatalogSort })}
                  >
                    {CATALOG_SORT_OPTIONS.map((sort) => (
                      <option key={sort} value={sort}>
                        {t(`settings.pet.sort.${sort}`)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <label className={styles.searchBox}>
                <span className="codicon codicon-search" aria-hidden="true" />
                <input
                  type="search"
                  value={search}
                  maxLength={MAX_CATALOG_QUERY_LENGTH}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t('settings.pet.searchPlaceholder')}
                />
              </label>

              {catalogError && catalogErrorDescriptor && (
                <div className={styles.errorState}>
                  <span className="codicon codicon-warning" aria-hidden="true" />
                  <span>{t('settings.pet.catalogError', {
                    error: t(catalogErrorDescriptor.key, catalogErrorDescriptor.params),
                  })}</span>
                </div>
              )}

              {catalogLoading && !catalogError && catalog.length === 0 && (
                <div className={styles.loadingState}>
                  <span className={`codicon codicon-loading ${styles.spinning}`} aria-hidden="true" />
                  <span>{t('settings.pet.loadingCatalog')}</span>
                </div>
              )}

              {!catalogLoading && !catalogError && catalog.length === 0 && (
                <div className={styles.emptyState}>{t('settings.pet.noPets')}</div>
              )}

              <div
                className={styles.catalogGrid}
                data-testid="pet-catalog-grid"
                style={{ gridTemplateColumns: `repeat(${config.catalogColumns}, minmax(0, 1fr))` }}
              >
                {catalog.map((pet) => {
                  const pending = pendingPetOperation?.slug === pet.slug;
                  const displayName = pet.alias || pet.displayName;
                  return (
                    <article key={pet.slug} className={styles.petCard}>
                      <RemoteSpritePreview
                        slug={pet.slug}
                        label={displayName}
                        unavailableLabel={t('settings.pet.previewUnavailable')}
                      />
                      <div className={styles.petInfo}>
                        <strong title={pet.alias ? `${pet.alias} (${pet.displayName})` : pet.displayName}>
                          {displayName}
                        </strong>
                        <span>{pet.submittedBy || pet.kind || pet.slug}</span>
                      </div>
                      {pet.managed ? (
                        <button
                          type="button"
                          className={styles.dangerButton}
                          onClick={() => uninstallPet(pet.slug)}
                          disabled={pendingPetOperation !== null}
                        >
                          <span className="codicon codicon-trash" aria-hidden="true" />
                          {pending ? t('settings.pet.processing') : t('settings.pet.uninstall')}
                        </button>
                      ) : pet.installed ? (
                        <span className={styles.installedLabel}>{t('settings.pet.installedExternally')}</span>
                      ) : (
                        <button
                          type="button"
                          className={styles.primaryButton}
                          onClick={() => installPet(pet.slug)}
                          disabled={pendingPetOperation !== null}
                        >
                          <span className="codicon codicon-cloud-download" aria-hidden="true" />
                          {pending ? t('settings.pet.processing') : t('settings.pet.install')}
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
              {!catalogError && catalogTotal > 0 && (
                <nav className={styles.pagination} aria-label={t('settings.pet.pagination')}>
                  <button
                    type="button"
                    className={styles.pageButton}
                    onClick={() => goToPage(currentPage - 1)}
                    disabled={catalogLoading || currentPage <= 1}
                    title={t('settings.pet.previousPage')}
                    aria-label={t('settings.pet.previousPage')}
                  >
                    <span className="codicon codicon-chevron-left" aria-hidden="true" />
                  </button>
                  <span>{t('settings.pet.pageStatus', { current: currentPage, total: totalPages })}</span>
                  <label className={styles.pageJump}>
                    <span>{t('settings.pet.pageJump')}</span>
                    <input
                      type="number"
                      min="1"
                      max={totalPages}
                      value={pageInput}
                      onChange={(event) => setPageInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          commitPageInput();
                        }
                      }}
                      onBlur={commitPageInput}
                      aria-label={t('settings.pet.pageJump')}
                    />
                    <button
                      type="button"
                      className={styles.pageButton}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={commitPageInput}
                      disabled={catalogLoading}
                      title={t('settings.pet.goToPage')}
                      aria-label={t('settings.pet.goToPage')}
                    >
                      <span className="codicon codicon-arrow-right" aria-hidden="true" />
                    </button>
                  </label>
                  <button
                    type="button"
                    className={styles.pageButton}
                    onClick={() => goToPage(currentPage + 1)}
                    disabled={catalogLoading || currentPage >= totalPages}
                    title={t('settings.pet.nextPage')}
                    aria-label={t('settings.pet.nextPage')}
                  >
                    <span className="codicon codicon-chevron-right" aria-hidden="true" />
                  </button>
                </nav>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
