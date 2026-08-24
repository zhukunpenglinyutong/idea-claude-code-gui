import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CodexContextWindowPreset, CodexContextWindowValue } from '../types';

const RELATIVE_INLINE_BLOCK_STYLE: React.CSSProperties = { position: 'relative', display: 'inline-block' };
const CHEVRON_ICON_STYLE: React.CSSProperties = { fontSize: '10px', marginLeft: '2px' };
const DROPDOWN_STYLE: React.CSSProperties = {
  position: 'absolute',
  bottom: '100%',
  left: 0,
  marginBottom: '4px',
  zIndex: 10000,
  minWidth: '230px',
};
const OPTION_INFO_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1 };

interface CodexContextWindowSelectProps {
  value: CodexContextWindowValue;
  contextWindowTokens?: number | null;
  loading?: boolean;
  saving?: boolean;
  onChange: (preset: CodexContextWindowPreset) => void;
  onRefresh?: () => void;
}

const CONTEXT_WINDOW_OPTIONS: Array<{
  id: CodexContextWindowPreset;
  label: string;
  description: string;
}> = [
  {
    id: 'default',
    label: 'Default 272K',
    description: 'Remove overrides and use the Codex default context window',
  },
  {
    id: '500k',
    label: '500K',
    description: 'Request 500K context with compaction around 450K',
  },
  {
    id: '1m',
    label: '1M',
    description: 'Request 1M context; the actual window depends on the model and Codex runtime',
  },
];

function formatTokenCount(tokens?: number | null): string {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) {
    return '';
  }
  if (tokens >= 1_000_000) {
    const value = tokens / 1_000_000;
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}M`;
  }
  const value = tokens / 1_000;
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/, '')}K`;
}

export const CodexContextWindowSelect = ({
  value,
  contextWindowTokens,
  loading = false,
  saving = false,
  onChange,
  onRefresh,
}: CodexContextWindowSelectProps) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const disabled = loading || saving;

  const getOptionText = useCallback((
    option: typeof CONTEXT_WINDOW_OPTIONS[number],
    field: 'label' | 'description',
  ) => t(`codexContextWindow.${option.id}.${field}`, { defaultValue: option[field] }), [t]);

  const getCurrentLabel = () => {
    if (loading) {
      return t('codexContextWindow.loading', { defaultValue: 'Context…' });
    }
    if (value === 'custom') {
      const formatted = formatTokenCount(contextWindowTokens);
      return t('codexContextWindow.customLabel', {
        value: formatted || '?',
        defaultValue: 'Custom {{value}}',
      });
    }
    const current = CONTEXT_WINDOW_OPTIONS.find(option => option.id === value)
      || CONTEXT_WINDOW_OPTIONS[0];
    return getOptionText(current, 'label');
  };

  const handleToggle = useCallback((event: React.MouseEvent) => {
    event.stopPropagation();
    if (disabled) return;
    setIsOpen(current => {
      const next = !current;
      if (next) onRefresh?.();
      return next;
    });
  }, [disabled, onRefresh]);

  const handleSelect = useCallback((preset: CodexContextWindowPreset) => {
    if (saving) return;
    onChange(preset);
    setIsOpen(false);
  }, [onChange, saving]);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        dropdownRef.current && !dropdownRef.current.contains(target)
        && buttonRef.current && !buttonRef.current.contains(target)
      ) {
        setIsOpen(false);
      }
    };

    const timer = setTimeout(() => document.addEventListener('mousedown', handleClickOutside), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  return (
    <div style={RELATIVE_INLINE_BLOCK_STYLE} data-testid="codex-context-window-select">
      <button
        ref={buttonRef}
        className="selector-button"
        onClick={handleToggle}
        disabled={disabled}
        title={t('codexContextWindow.title', { defaultValue: 'Select Codex context window' })}
      >
        <span className={`codicon ${saving || loading ? 'codicon-loading codicon-modifier-spin' : 'codicon-symbol-number'}`} />
        <span className="selector-button-text">{getCurrentLabel()}</span>
        <span className={`codicon codicon-chevron-${isOpen ? 'up' : 'down'}`} style={CHEVRON_ICON_STYLE} />
      </button>

      {isOpen ? (
        <div ref={dropdownRef} className="selector-dropdown" style={DROPDOWN_STYLE} role="listbox">
          {CONTEXT_WINDOW_OPTIONS.map(option => (
            <div
              key={option.id}
              className={`selector-option ${option.id === value ? 'selected' : ''}`}
              onClick={() => handleSelect(option.id)}
              title={getOptionText(option, 'description')}
              role="option"
              aria-selected={option.id === value}
              data-testid={`codex-context-option-${option.id}`}
            >
              <span className="codicon codicon-symbol-number" />
              <div style={OPTION_INFO_STYLE}>
                <span>{getOptionText(option, 'label')}</span>
                <span className="mode-description">{getOptionText(option, 'description')}</span>
              </div>
              {option.id === value ? <span className="codicon codicon-check check-mark" /> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export default CodexContextWindowSelect;
