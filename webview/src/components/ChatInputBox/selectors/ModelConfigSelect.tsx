import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Switch from 'antd/es/switch';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';
import { readClaudeModelMapping } from '../../../utils/claudeModelMapping';
import { ProviderModelIcon } from '../../shared/ProviderModelIcon';
import {
  MODEL_ID_TO_MAPPING_KEY,
  resolveModelDisplayLabel,
  resolveModelIdForIcon,
} from '../modelLabelUtils';
import { useReasoningEffortGuard } from '../reasoningUtils';
import {
  AVAILABLE_MODELS,
  DSH_PRESETS,
  REASONING_LEVELS,
  getUserDshPresetOptions,
  modelSupports1MContext,
  normalizeClaudeModelId,
  strip1MContextSuffix,
  type CodexFastMode,
  type ModelInfo,
  type ReasoningEffort,
} from '../types';
import { CodexFastModeSelect } from './CodexFastModeSelect';
import { DshPresetSelect } from './DshPresetSelect';
import { ModelSelect } from './ModelSelect';
import { ReasoningSelect } from './ReasoningSelect';

const WRAPPER_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };
const DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  zIndex: 10000,
  minWidth: '220px',
  maxWidth: 'calc(100vw - 16px)',
  overflow: 'visible',
};
const OPTION_RELATIVE_STYLE: React.CSSProperties = { position: 'relative', overflow: 'visible' };
const OPTION_LABEL_STYLE: React.CSSProperties = { flex: 1, minWidth: 0 };
const OPTION_VALUE_STYLE: React.CSSProperties = {
  marginLeft: 'auto',
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  color: 'var(--text-secondary)',
  flexShrink: 0,
};
const ARROW_ICON_STYLE: React.CSSProperties = { fontSize: '12px' };
const CONTEXT_SWITCH_STYLE: React.CSSProperties = {
  justifyContent: 'space-between',
  cursor: 'pointer',
};

/**
 * Delay before switching an already-open fly-out. The effort fly-out sits
 * beside its row, so the pointer may cross the 1M context / speed / preset
 * rows on the way; without a grace period those rows steal the submenu.
 */
export const SUBMENU_HOVER_DELAY_MS = 200;
/**
 * Delay before opening the first fly-out on hover. The function rows sit at
 * the popover's bottom edge — right where the pointer enters from the
 * trigger — so an instant open would fire on every pass-through.
 */
export const SUBMENU_TRIGGER_DELAY_MS = 500;

type ActiveSubmenu = 'none' | 'effort' | 'speed' | 'preset';

interface ModelConfigSelectProps {
  selectedModel: string;
  onModelSelect: (modelId: string) => void;
  models?: ModelInfo[];
  currentProvider?: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onAddModel?: () => void;
  longContextEnabled?: boolean;
  onLongContextChange?: (enabled: boolean) => void;
  reasoningEffort?: ReasoningEffort;
  onReasoningChange?: (effort: ReasoningEffort) => void;
  codexFastMode?: CodexFastMode;
  onCodexFastModeChange?: (mode: CodexFastMode) => void;
  dshPreset?: string;
  onDshPresetChange?: (preset: string) => void;
}

function getReasoningLabel(
  t: (key: string, options?: { defaultValue?: string }) => string,
  effort: ReasoningEffort,
): string {
  const fallback = REASONING_LEVELS.find((level) => level.id === effort)?.label || effort;
  return t(`reasoning.${effort}.label`, { defaultValue: fallback });
}

/**
 * Model-settings selector: one summary trigger whose popover keeps the model
 * list flat at the top; the function rows (1M context / Codex speed / DSH
 * preset / effort) sit below it, next to the trigger. Rows that offer a
 * choice open fly-out submenus beside them.
 */
export const ModelConfigSelect = ({
  selectedModel,
  onModelSelect,
  models = AVAILABLE_MODELS,
  currentProvider = 'claude',
  loading = false,
  error = null,
  onRetry,
  onAddModel,
  longContextEnabled = true,
  onLongContextChange,
  reasoningEffort = 'high',
  onReasoningChange,
  codexFastMode = 'normal',
  onCodexFastModeChange,
  dshPreset = '',
  onDshPresetChange,
}: ModelConfigSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [activeSubmenu, setActiveSubmenu] = useState<ActiveSubmenu>('none');
  const activeSubmenuRef = useRef<ActiveSubmenu>(activeSubmenu);
  activeSubmenuRef.current = activeSubmenu;
  const hoverTimerRef = useRef<number | undefined>(undefined);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const effortTriggerRef = useRef<HTMLDivElement>(null);
  const speedTriggerRef = useRef<HTMLDivElement>(null);
  const presetTriggerRef = useRef<HTMLDivElement>(null);
  const clearHoverTimer = useCallback(() => {
    if (hoverTimerRef.current !== undefined) {
      window.clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = undefined;
    }
  }, []);

  const openSubmenu = useCallback((submenu: ActiveSubmenu) => {
    clearHoverTimer();
    setActiveSubmenu(submenu);
  }, [clearHoverTimer]);

  const scheduleSubmenu = useCallback((submenu: ActiveSubmenu) => {
    if (activeSubmenuRef.current === submenu) {
      clearHoverTimer();
      return;
    }
    clearHoverTimer();
    // Opening the first fly-out waits longer than switching between open
    // fly-outs: the pointer may only be crossing a row on its way elsewhere.
    const delay = activeSubmenuRef.current === 'none'
      ? SUBMENU_TRIGGER_DELAY_MS
      : SUBMENU_HOVER_DELAY_MS;
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = undefined;
      setActiveSubmenu(submenu);
    }, delay);
  }, [clearHoverTimer]);

  const triggerRefFor = (submenu: ActiveSubmenu) => {
    if (submenu === 'preset') return presetTriggerRef.current;
    if (submenu === 'effort') return effortTriggerRef.current;
    if (submenu === 'speed') return speedTriggerRef.current;
    return null;
  };

  /**
   * Fly-outs stop mouseenter from bubbling. If the pointer crossed another
   * row on the way, that row armed a delayed switch — arriving inside the
   * already-open fly-out must cancel it.
   */
  const retainActiveSubmenu = useCallback((event: React.MouseEvent) => {
    const current = activeSubmenuRef.current;
    if (current === 'none') return;
    const trigger = triggerRefFor(current);
    if (trigger?.contains(event.target as Node)) {
      clearHoverTimer();
    }
  }, [clearHoverTimer]);

  const { positionedStyle: mainPositionedStyle, maxHeight: mainMaxHeight, recalculate: mainRecalculate } = useDropdownPosition({
    buttonRef,
    dropdownRef,
    preferredAlignment: 'right',
    minWidth: 220,
  });

  const handleReasoningChange = useCallback((effort: ReasoningEffort) => {
    onReasoningChange?.(effort);
  }, [onReasoningChange]);

  const { isVisible: showEffort, currentLevel } = useReasoningEffortGuard(
    reasoningEffort,
    handleReasoningChange,
    selectedModel,
    currentProvider,
  );

  const strippedValue = strip1MContextSuffix(selectedModel);
  const normalizedValue = currentProvider === 'claude' ? normalizeClaudeModelId(strippedValue) : strippedValue;
  const currentModel = models.find((model) => model.id === normalizedValue)
    || models.find((model) => model.id === strippedValue)
    || (strippedValue
      ? { id: strippedValue, label: strippedValue } as ModelInfo
      : models[0]);
  const modelMapping = readClaudeModelMapping();
  const show1MContext = currentProvider === 'claude'
    && modelSupports1MContext(selectedModel)
    && longContextEnabled;
  const showContextRow = currentProvider === 'claude' && !!onLongContextChange;
  const showEffortRow = showEffort && !!onReasoningChange;
  const showSpeed = currentProvider === 'codex' && !!onCodexFastModeChange;
  const showPreset = currentProvider === 'dsh' && !!onDshPresetChange;
  const contextSupported = modelSupports1MContext(selectedModel);
  const hasTrailingRows = showContextRow || showSpeed || showPreset;

  const modelLabel = currentModel
    ? resolveModelDisplayLabel(currentModel, {
        t,
        currentProvider,
        modelMapping: currentProvider === 'claude' ? modelMapping : {},
        show1MContext: false,
        longContextEnabled,
      })
    : selectedModel;

  const dshOptions = useMemo(
    () => [...DSH_PRESETS, ...getUserDshPresetOptions()],
    [],
  );
  const currentDshPreset = dshOptions.find((preset) => preset.id === dshPreset) || dshOptions[0];
  const dshPresetLabel = currentDshPreset?.label
    || (currentDshPreset?.labelKey ? t(currentDshPreset.labelKey, { defaultValue: currentDshPreset.id }) : '');
  const effortLabel = currentLevel ? getReasoningLabel(t, currentLevel.id) : '';
  const speedLabel = t(`codexFastMode.${codexFastMode}.label`, {
    defaultValue: codexFastMode === 'fast' ? 'Fast' : 'Standard',
  });
  const summaryParts = [
    modelLabel,
    show1MContext ? t('models.longContext.label', { defaultValue: '1M' }) : '',
    showEffortRow ? effortLabel : '',
    showSpeed && codexFastMode === 'fast' ? speedLabel : '',
    showPreset && dshPreset ? dshPresetLabel : '',
  ].filter(Boolean);
  const summaryText = summaryParts.join(' ');

  const closeMenu = useCallback(() => {
    clearHoverTimer();
    setIsOpen(false);
    setActiveSubmenu('none');
  }, [clearHoverTimer]);

  const handleToggle = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    clearHoverTimer();
    setActiveSubmenu('none');
    if (nextOpen) {
      mainRecalculate();
    }
  }, [clearHoverTimer, isOpen, mainRecalculate]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current
        && !dropdownRef.current.contains(event.target as Node)
        && buttonRef.current
        && !buttonRef.current.contains(event.target as Node)
      ) {
        closeMenu();
      }
    };

    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [closeMenu, isOpen]);

  useLayoutEffect(() => {
    if (isOpen) {
      mainRecalculate();
    }
  }, [isOpen, mainRecalculate, showEffortRow, showSpeed, showPreset, showContextRow]);
  useEffect(() => () => clearHoverTimer(), [clearHoverTimer]);

  return (
    <div style={WRAPPER_STYLE}>
      <button
        ref={buttonRef}
        type="button"
        className="selector-button model-config-button"
        onClick={handleToggle}
        title={summaryText}
        aria-label={t('modelConfig.title', { defaultValue: 'Model settings' })}
        data-testid="model-config-trigger"
      >
        {currentModel && (
          <ProviderModelIcon
            providerId={currentProvider}
            modelId={resolveModelIdForIcon(
              currentModel.id,
              currentProvider === 'claude' ? modelMapping : {},
              MODEL_ID_TO_MAPPING_KEY,
            )}
            size={12}
            colored
          />
        )}
        <span className="selector-button-text model-config-summary-text">{summaryText}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown model-config-dropdown"
          data-testid="model-config-dropdown"
          style={{ ...DROPDOWN_STYLE, ...mainPositionedStyle, maxHeight: mainMaxHeight, boxSizing: 'border-box' }}
          onMouseOverCapture={retainActiveSubmenu}
        >
          {/* The flat list has no hover row of its own; entering it must
              dismiss any open fly-out (effort / speed / preset). It sits at
              the top so model switching — the most frequent action — never
              crosses the submenu rows. */}
          <div className="model-config-models" onMouseEnter={() => scheduleSubmenu('none')}>
            <ModelSelect
              value={selectedModel}
              onChange={onModelSelect}
              models={models}
              currentProvider={currentProvider}
              loading={loading}
              error={error}
              onRetry={onRetry}
              onAddModel={onAddModel}
              longContextEnabled={longContextEnabled}
              onLongContextChange={onLongContextChange}
              inline
              hideLongContextToggle
              onClose={closeMenu}
            />
          </div>

          {(showEffortRow || hasTrailingRows) && <div className="selector-divider" />}

          {showContextRow && (
            <div
              className="selector-option"
              data-testid="model-config-option-context"
              onClick={(event) => {
                event.stopPropagation();
                if (!contextSupported) return;
                onLongContextChange?.(!longContextEnabled);
              }}
              onMouseEnter={() => scheduleSubmenu('none')}
              style={CONTEXT_SWITCH_STYLE}
              title={contextSupported
                ? t('models.longContext.tooltipEnabled')
                : t('models.longContext.tooltipDisabled')}
            >
              <span style={OPTION_LABEL_STYLE}>{t('modelConfig.context', { defaultValue: '1M Context' })}</span>
              <Switch
                size="small"
                checked={contextSupported ? longContextEnabled : false}
                disabled={!contextSupported}
                onClick={(checked, event) => {
                  event.stopPropagation();
                  onLongContextChange?.(checked);
                }}
              />
            </div>
          )}

          {showSpeed && onCodexFastModeChange && (
            <div
              ref={speedTriggerRef}
              className={`selector-option${activeSubmenu === 'speed' ? ' selected' : ''}`}
              data-testid="model-config-option-speed"
              onMouseEnter={() => scheduleSubmenu('speed')}
              onClick={(event) => {
                event.stopPropagation();
                openSubmenu('speed');
              }}
              style={OPTION_RELATIVE_STYLE}
            >
              <span style={OPTION_LABEL_STYLE}>{t('modelConfig.speed', { defaultValue: 'Speed' })}</span>
              <div style={OPTION_VALUE_STYLE}>
                <span>{speedLabel}</span>
                <span className="codicon codicon-chevron-right" style={ARROW_ICON_STYLE} />
              </div>
              {activeSubmenu === 'speed' && (
                <CodexFastModeSelect
                  value={codexFastMode}
                  onChange={onCodexFastModeChange}
                  embedded
                  triggerRef={speedTriggerRef}
                  onClose={closeMenu}
                />
              )}
            </div>
          )}

          {showPreset && onDshPresetChange && (
            <div
              ref={presetTriggerRef}
              className={`selector-option${activeSubmenu === 'preset' ? ' selected' : ''}`}
              data-testid="model-config-option-preset"
              onMouseEnter={() => scheduleSubmenu('preset')}
              onClick={(event) => {
                event.stopPropagation();
                openSubmenu('preset');
              }}
              style={OPTION_RELATIVE_STYLE}
            >
              <span style={OPTION_LABEL_STYLE}>{t('modelConfig.preset', { defaultValue: 'Preset' })}</span>
              <div style={OPTION_VALUE_STYLE}>
                <span>{dshPresetLabel}</span>
                <span className="codicon codicon-chevron-right" style={ARROW_ICON_STYLE} />
              </div>
              {activeSubmenu === 'preset' && (
                <DshPresetSelect
                  value={dshPreset}
                  onChange={onDshPresetChange}
                  embedded
                  triggerRef={presetTriggerRef}
                  onClose={closeMenu}
                />
              )}
            </div>
          )}

          {showEffortRow && (
            <div
              ref={effortTriggerRef}
              className={`selector-option${activeSubmenu === 'effort' ? ' selected' : ''}`}
              data-testid="model-config-option-effort"
              onMouseEnter={() => scheduleSubmenu('effort')}
              onClick={(event) => {
                event.stopPropagation();
                openSubmenu('effort');
              }}
              style={OPTION_RELATIVE_STYLE}
            >
              <span style={OPTION_LABEL_STYLE}>{t('modelConfig.effort', { defaultValue: 'Effort' })}</span>
              <div style={OPTION_VALUE_STYLE}>
                <span>{effortLabel}</span>
                <span className="codicon codicon-chevron-right" style={ARROW_ICON_STYLE} />
              </div>
              {activeSubmenu === 'effort' && (
                <ReasoningSelect
                  value={reasoningEffort}
                  onChange={handleReasoningChange}
                  selectedModel={selectedModel}
                  currentProvider={currentProvider}
                  embedded
                  triggerRef={effortTriggerRef}
                  onClose={closeMenu}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ModelConfigSelect;
