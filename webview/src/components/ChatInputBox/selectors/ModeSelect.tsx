import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AVAILABLE_MODES, type ModeInfo, type ModelInfo, type PermissionMode } from '../types';
import { useOmpRoles } from '../../../hooks/providers/useCliModels';
import { useDropdownPosition } from '../../../hooks/useDropdownPosition';

const RELATIVE_INLINE_BLOCK_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };
const DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  marginBottom: '4px',
  zIndex: 10000,
  maxWidth: 'calc(100vw - 16px)',
  overflowX: 'hidden',
};
const MODE_INFO_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, overflow: 'hidden' };
const MODE_TEXT_STYLE: React.CSSProperties = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

/** Icons for the well-known omp roles; any other dynamic role gets a sparkle. */
const OMP_ROLE_ICONS: Record<string, string> = {
  smol: 'codicon-zap',
  slow: 'codicon-lightbulb',
  plan: 'codicon-tasklist',
};

/**
 * Maps a dynamic omp role (listModels payload) to a ModeInfo. Label is the
 * capitalized role id; description/tooltip carry the resolved model selector.
 * Roles with an ompModes.* i18n entry get translated text via getModeText.
 */
function roleToModeInfo(role: ModelInfo): ModeInfo {
  return {
    id: role.id,
    label: role.id.charAt(0).toUpperCase() + role.id.slice(1),
    icon: OMP_ROLE_ICONS[role.id] ?? 'codicon-sparkle',
    description: role.description,
    tooltip: role.description,
  };
}

function getModeOptionStyle(disabled: boolean): React.CSSProperties {
  return {
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

interface ModeSelectProps {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  provider?: string;
  codexNativeAutoReviewAvailable?: boolean;
}

/**
 * ModeSelect - Mode selector component
 * Supports switching between manual, agent, provider-native auto, plan, and Full Auto modes
 */
export const ModeSelect = ({
  value,
  onChange,
  provider,
  codexNativeAutoReviewAvailable = true,
}: ModeSelectProps) => {
  const { t, i18n } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Dynamic omp model roles (subscribed unconditionally per hook rules; only
  // consumed for provider 'omp'). Static smol/slow/plan until roles load.
  const ompRoles = useOmpRoles();
  const { positionedStyle, recalculate } = useDropdownPosition({
    buttonRef,
    dropdownRef,
    preferredAlignment: 'right',
  });

  const modeOptions = useMemo(() => {
    if (provider === 'omp') {
      // OMP model-role modes: [Default, ...roles]. Roles are dynamic from the
      // listModels payload, falling back to static smol/slow/plan.
      const defaultMode = AVAILABLE_MODES.find((mode) => mode.id === 'default');
      const roleModes = ompRoles.map(roleToModeInfo);
      return defaultMode ? [defaultMode, ...roleModes] : roleModes;
    }
    if (provider === 'codex') {
      return AVAILABLE_MODES.filter((mode) =>
        (mode.id !== 'auto' || codexNativeAutoReviewAvailable)
        && mode.id !== 'plan'
        && mode.id !== 'smol'
        && mode.id !== 'slow'
      );
    }
    if (provider === 'grok' || provider === 'kimi' || provider === 'minimax' || provider === 'opencode' || provider === 'pi' || provider === 'dsh' || provider === 'codebuddy') {
      // Headless CLI providers do not expose Claude/Codex native automatic reviewers.
      return AVAILABLE_MODES.filter((mode) => mode.id !== 'auto' && mode.id !== 'plan' && mode.id !== 'smol' && mode.id !== 'slow');
    }
    // smol/slow are OMP-only model roles; hide them everywhere else.
    return AVAILABLE_MODES.filter((mode) => mode.id !== 'smol' && mode.id !== 'slow');
  }, [provider, ompRoles, codexNativeAutoReviewAvailable]);

  const currentMode = modeOptions.find(m => m.id === value) || modeOptions[0];

  // Helper function to get translated mode text
  const getModeText = (modeId: PermissionMode, field: 'label' | 'shortLabel' | 'tooltip' | 'description') => {
    if (provider === 'codex') {
      const codexKey = `codexModes.${modeId}.${field}`;
      const fallbackKey = `modes.${modeId}.${field}`;
      if (field === 'shortLabel') {
        return t(codexKey, { defaultValue: t(fallbackKey, { defaultValue: t(`codexModes.${modeId}.label`) }) });
      }
      return t(codexKey, { defaultValue: t(fallbackKey) });
    }
    if (provider === 'omp') {
      const ompKey = `ompModes.${modeId}.${field}`;
      if (i18n.exists(ompKey)) return t(ompKey);
      const fallbackKey = `modes.${modeId}.${field}`;
      if (i18n.exists(fallbackKey)) return t(fallbackKey);
      if (field === 'shortLabel' && i18n.exists(`ompModes.${modeId}.label`)) return t(`ompModes.${modeId}.label`);
      if (field === 'shortLabel' && i18n.exists(`modes.${modeId}.label`)) return t(`modes.${modeId}.label`);
      // Dynamic role with no i18n entry: show the raw ModeInfo strings
      // (capitalized role id / resolved model selector).
      const info = modeOptions.find((mode) => mode.id === modeId);
      if (field === 'label' || field === 'shortLabel') return info?.label ?? modeId;
      return info?.[field] ?? info?.description ?? '';
    }
    if (provider === 'codebuddy' && modeId === 'bypassPermissions') {
      const codeBuddyKey = `codebuddyModes.${modeId}.${field}`;
      const fallbackKey = `modes.${modeId}.${field}`;
      return t(codeBuddyKey, { defaultValue: t(fallbackKey) });
    }

    if (field === 'shortLabel') {
      return t(`modes.${modeId}.shortLabel`, { defaultValue: t(`modes.${modeId}.label`) });
    }
    return t(`modes.${modeId}.${field}`);
  };

  /**
   * Toggle dropdown
   */
  const handleToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const nextOpen = !isOpen;
    setIsOpen(nextOpen);
    if (nextOpen) {
      recalculate();
    }
  }, [isOpen, recalculate]);

  /**
   * Select mode
   */
  const handleSelect = useCallback((mode: PermissionMode, disabled?: boolean) => {
    if (disabled) return; // Disabled options cannot be selected
    onChange(mode);
    setIsOpen(false);
  }, [onChange]);

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

  useLayoutEffect(() => {
    if (isOpen) {
      recalculate();
    }
  }, [isOpen, recalculate]);

  return (
    <div style={RELATIVE_INLINE_BLOCK_STYLE}>
      <button
        ref={buttonRef}
        className={`selector-button${value === 'bypassPermissions' ? ' mode-full-auto-active' : ''}`}
        onClick={handleToggle}
        title={getModeText(currentMode.id, 'tooltip') || `${t('chat.currentMode', { mode: getModeText(currentMode.id, 'label') })}`}
      >
        <span className={`codicon ${currentMode.icon}`} />
        <span className="selector-button-text">{getModeText(currentMode.id, 'shortLabel')}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen && (
        <div
          ref={dropdownRef}
          className="selector-dropdown"
          style={{ ...DROPDOWN_STYLE, ...positionedStyle }}
        >
          {modeOptions.map((mode) => (
            <div
              key={mode.id}
              data-testid={`mode-option-${mode.id}`}
              className={`selector-option ${mode.id === value ? 'selected' : ''} ${mode.disabled ? 'disabled' : ''}`}
              onClick={() => handleSelect(mode.id, mode.disabled)}
              title={getModeText(mode.id, 'tooltip')}
              style={getModeOptionStyle(!!mode.disabled)}
            >
              <span className={`codicon ${mode.icon}`} />
              <div style={MODE_INFO_STYLE}>
                <span style={MODE_TEXT_STYLE}>{getModeText(mode.id, 'label')}</span>
                <span className="mode-description" style={MODE_TEXT_STYLE}>{getModeText(mode.id, 'description')}</span>
              </div>
              {mode.id === value && (
                <span className="codicon codicon-check check-mark" />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ModeSelect;
