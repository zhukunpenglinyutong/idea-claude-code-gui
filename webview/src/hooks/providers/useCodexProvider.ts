import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import { sendBridgeEvent } from '../../utils/bridge';
import { CODEX_MODELS } from '../../components/ChatInputBox/types';
import type {
  CodexContextWindowPreset,
  CodexContextWindowValue,
  CodexFastMode,
  PermissionMode,
  ReasoningEffort,
} from '../../components/ChatInputBox/types';

const CONTEXT_CONFIG_RETRY_LIMIT = 30;
const CONTEXT_CONFIG_SAVE_TIMEOUT_MS = 10_000;

interface UseCodexProviderOptions {
  currentProvider: string;
  addToast: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  t: TFunction;
}

interface CodexContextWindowPayload {
  success?: boolean;
  preset?: unknown;
  contextWindow?: unknown;
  autoCompactTokenLimit?: unknown;
  custom?: unknown;
  error?: unknown;
}

interface ConfirmedContextWindowConfig {
  value: CodexContextWindowValue;
  contextWindowTokens: number | null;
  autoCompactTokenLimit: number | null;
}

const DEFAULT_CONTEXT_WINDOW_CONFIG: ConfirmedContextWindowConfig = {
  value: 'default',
  contextWindowTokens: 272_000,
  autoCompactTokenLimit: 244_800,
};

const isContextWindowValue = (value: unknown): value is CodexContextWindowValue =>
  value === 'default' || value === '500k' || value === '1m' || value === 'custom';

const readPositiveNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

const parseContextWindowPayload = (
  dataOrString: string | CodexContextWindowPayload,
): CodexContextWindowPayload | null => {
  if (typeof dataOrString === 'string') {
    try {
      return JSON.parse(dataOrString) as CodexContextWindowPayload;
    } catch {
      return null;
    }
  }
  return dataOrString && typeof dataOrString === 'object' ? dataOrString : null;
};

/**
 * Codex-specific selectable state. `reasoningEffort` lives here because the
 * value set is a Codex/OpenAI concept (low/medium/high/xhigh/max). The change
 * handler forwards directly to the backend via bridge event.
 */
export function useCodexProvider({ currentProvider, addToast, t }: UseCodexProviderOptions) {
  const [selectedCodexModel, setSelectedCodexModel] = useState(CODEX_MODELS[0].id);
  const [codexPermissionMode, setCodexPermissionMode] = useState<PermissionMode>('default');
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>('high');
  const [codexFastMode, setCodexFastMode] = useState<CodexFastMode>('normal');
  const [codexContextWindow, setCodexContextWindow] = useState<CodexContextWindowValue>('default');
  const [codexContextWindowTokens, setCodexContextWindowTokens] = useState<number | null>(272_000);
  const [codexAutoCompactTokenLimit, setCodexAutoCompactTokenLimit] = useState<number | null>(244_800);
  const [codexContextWindowLoading, setCodexContextWindowLoading] = useState(true);
  const [codexContextWindowSaving, setCodexContextWindowSaving] = useState(false);
  const lastConfirmedContextRef = useRef<ConfirmedContextWindowConfig>(DEFAULT_CONTEXT_WINDOW_CONFIG);
  const pendingPresetRef = useRef<CodexContextWindowPreset | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSaveTimeout = useCallback(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
  }, []);

  const applyConfirmedContext = useCallback((config: ConfirmedContextWindowConfig) => {
    lastConfirmedContextRef.current = config;
    setCodexContextWindow(config.value);
    setCodexContextWindowTokens(config.contextWindowTokens);
    setCodexAutoCompactTokenLimit(config.autoCompactTokenLimit);
  }, []);

  const refreshCodexContextWindow = useCallback(() => {
    return sendBridgeEvent('get_codex_context_window');
  }, []);

  useEffect(() => {
    const handleConfig = (dataOrString: string | CodexContextWindowPayload) => {
      const payload = parseContextWindowPayload(dataOrString);
      if (!payload) return;

      const value = isContextWindowValue(payload.preset) ? payload.preset : null;
      const authoritativeConfig = value ? {
        value,
        contextWindowTokens: readPositiveNumber(payload.contextWindow),
        autoCompactTokenLimit: readPositiveNumber(payload.autoCompactTokenLimit),
      } satisfies ConfirmedContextWindowConfig : null;

      if (payload.success === false) {
        if (authoritativeConfig) applyConfirmedContext(authoritativeConfig);
        else applyConfirmedContext(lastConfirmedContextRef.current);
        setCodexContextWindowLoading(false);
        setCodexContextWindowSaving(false);
        pendingPresetRef.current = null;
        clearSaveTimeout();
        const error = typeof payload.error === 'string' && payload.error.trim()
          ? payload.error.trim()
          : t('codexContextWindow.saveFailed', { defaultValue: 'Failed to update Codex context window' });
        addToast(error, 'error');
        return;
      }

      if (!authoritativeConfig) return;
      applyConfirmedContext(authoritativeConfig);
      setCodexContextWindowLoading(false);
      if (pendingPresetRef.current) {
        if (authoritativeConfig.value !== pendingPresetRef.current) {
          // Another open window may have written first. Keep this request pending
          // until its own authoritative broadcast arrives from the serialized backend.
          return;
        }
        pendingPresetRef.current = null;
        setCodexContextWindowSaving(false);
        clearSaveTimeout();
        addToast(
          t('codexContextWindow.saved', {
            value: authoritativeConfig.value,
            defaultValue: 'Codex context window updated; the next message will use it',
          }),
          'success',
        );
      } else {
        setCodexContextWindowSaving(false);
      }
    };

    window.updateCodexContextWindowConfig = handleConfig;
    if (window.__pendingCodexContextWindowConfig) {
      const pending = window.__pendingCodexContextWindowConfig;
      delete window.__pendingCodexContextWindowConfig;
      handleConfig(pending);
    }

    let retryCount = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const requestInitialConfig = () => {
      if (refreshCodexContextWindow()) return;
      retryCount += 1;
      if (retryCount < CONTEXT_CONFIG_RETRY_LIMIT) {
        retryTimer = setTimeout(requestInitialConfig, 100);
      } else {
        setCodexContextWindowLoading(false);
      }
    };
    retryTimer = setTimeout(requestInitialConfig, 200);

    return () => {
      if (retryTimer) clearTimeout(retryTimer);
      clearSaveTimeout();
      if (window.updateCodexContextWindowConfig === handleConfig) {
        delete window.updateCodexContextWindowConfig;
      }
    };
  }, [addToast, applyConfirmedContext, clearSaveTimeout, refreshCodexContextWindow, t]);

  useEffect(() => {
    if (currentProvider === 'codex') {
      refreshCodexContextWindow();
    }
  }, [currentProvider, refreshCodexContextWindow]);

  const handleReasoningChange = useCallback((effort: ReasoningEffort) => {
    setReasoningEffort(effort);
    sendBridgeEvent('set_reasoning_effort', effort);
  }, []);

  const handleCodexFastModeChange = useCallback((mode: CodexFastMode) => {
    setCodexFastMode(mode);
    sendBridgeEvent('set_codex_fast_mode', mode);
  }, []);

  const handleCodexContextWindowChange = useCallback((preset: CodexContextWindowPreset) => {
    if (codexContextWindowSaving) return;

    pendingPresetRef.current = preset;
    setCodexContextWindowSaving(true);
    setCodexContextWindow(preset);
    if (preset === 'default') setCodexContextWindowTokens(272_000);
    if (preset === '500k') setCodexContextWindowTokens(500_000);
    if (preset === '1m') setCodexContextWindowTokens(1_000_000);

    const sent = sendBridgeEvent('set_codex_context_window', JSON.stringify({ preset }));
    if (!sent) {
      pendingPresetRef.current = null;
      applyConfirmedContext(lastConfirmedContextRef.current);
      setCodexContextWindowSaving(false);
      clearSaveTimeout();
      addToast(
        t('codexContextWindow.bridgeUnavailable', {
          defaultValue: 'Codex context settings are not available yet',
        }),
        'error',
      );
      return;
    }

    clearSaveTimeout();
    saveTimeoutRef.current = setTimeout(() => {
      pendingPresetRef.current = null;
      saveTimeoutRef.current = null;
      applyConfirmedContext(lastConfirmedContextRef.current);
      setCodexContextWindowSaving(false);
      addToast(
        t('codexContextWindow.saveTimeout', {
          defaultValue: 'Timed out while saving the Codex context setting',
        }),
        'error',
      );
      refreshCodexContextWindow();
    }, CONTEXT_CONFIG_SAVE_TIMEOUT_MS);
  }, [
    addToast,
    applyConfirmedContext,
    clearSaveTimeout,
    codexContextWindowSaving,
    refreshCodexContextWindow,
    t,
  ]);

  return {
    selectedCodexModel,
    setSelectedCodexModel,
    codexPermissionMode,
    setCodexPermissionMode,
    reasoningEffort,
    setReasoningEffort,
    codexFastMode,
    setCodexFastMode,
    codexContextWindow,
    codexContextWindowTokens,
    codexAutoCompactTokenLimit,
    codexContextWindowLoading,
    codexContextWindowSaving,
    handleReasoningChange,
    handleCodexFastModeChange,
    handleCodexContextWindowChange,
    refreshCodexContextWindow,
  };
}

export type UseCodexProviderReturn = ReturnType<typeof useCodexProvider>;
