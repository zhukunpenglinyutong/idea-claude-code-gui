/**
 * usageModeCallbacks.test.ts
 *
 * Gemini slot cross-provider guard: applyBackendTabState / onModelConfirmed
 * can carry a claude-era tab model with provider 'gemini' (JCEF tab state is
 * shared across chat tabs). A live claude-catalog id is not an agy model —
 * accepting it poisons selectedGeminiModel and the catalog re-push relays
 * set_model('claude-…') to agy, which rejects it at spawn
 * (--model "claude-sonnet-5" --effort ""). Retired claude ids that agy ships
 * live (claude-sonnet-4-6) must still pass.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerUsageModeCallbacks } from './usageModeCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';

vi.mock('../../../utils/bridge', () => ({
  sendBridgeEvent: vi.fn(),
}));
vi.mock('../settingsBootstrap', () => ({
  drainPendingSettings: vi.fn(),
  startInitialSettingsRequest: vi.fn(),
}));

function createHarness() {
  const setters = {
    setUsagePercentage: vi.fn(),
    setUsageUsedTokens: vi.fn(),
    setUsageMaxTokens: vi.fn(),
    setPermissionMode: vi.fn(),
    setCurrentProvider: vi.fn(),
    setClaudePermissionMode: vi.fn(),
    setCodexPermissionMode: vi.fn(),
    setGeminiPermissionMode: vi.fn(),
    setSelectedClaudeModel: vi.fn(),
    setSelectedCodexModel: vi.fn(),
    setSelectedGeminiModel: vi.fn(),
    setLongContextEnabled: vi.fn(),
    setReasoningEffort: vi.fn(),
    setCodexFastMode: vi.fn(),
    setProviderConfigVersion: vi.fn(),
    setActiveProviderConfig: vi.fn(),
    setClaudeSettingsAlwaysThinkingEnabled: vi.fn(),
    setStreamingEnabledSetting: vi.fn(),
    setSendShortcut: vi.fn(),
    setAutoOpenFileEnabled: vi.fn(),
    setPermissionDialogTimeoutSeconds: vi.fn(),
  };
  const currentProviderRef = { current: 'claude' };
  const resolveDefaultEffort = vi.fn(() => 'high');
  const syncActiveProviderModelMapping = vi.fn();

  registerUsageModeCallbacks({
    ...setters,
    currentProviderRef,
    resolveDefaultEffort,
    syncActiveProviderModelMapping,
  } as unknown as UseWindowCallbacksOptions);

  return { ...setters, currentProviderRef, resolveDefaultEffort };
}

describe('gemini slot cross-provider guard (backend pushes)', () => {
  beforeEach(() => {
    delete (window as unknown as { __pendingUsageUpdate?: unknown }).__pendingUsageUpdate;
    delete (window as unknown as { __pendingBackendTabState?: unknown }).__pendingBackendTabState;
  });

  afterEach(() => {
    delete window.__CCGUI_RECOVERY_STATE_APPLIED__;
  });

  it('applyBackendTabState does not poison the gemini slot with a claude-catalog id', () => {
    const h = createHarness();

    window.applyBackendTabState!(JSON.stringify({
      provider: 'gemini',
      model: 'claude-sonnet-5',
    }));

    expect(h.setSelectedGeminiModel).not.toHaveBeenCalledWith('claude-sonnet-5');
    // Provider switch itself must still land.
    expect(h.currentProviderRef.current).toBe('gemini');
    expect(h.setCurrentProvider).toHaveBeenCalledWith('gemini');
    expect(window.__CCGUI_RECOVERY_STATE_APPLIED__).toBe(true);
  });

  it('applyBackendTabState rejects a claude id with the [1m] context suffix', () => {
    // The poisoning tab had the 1M toggle on, so the pushed tab state carried
    // claude-sonnet-5[1m] — the suffix made it miss the live-claude catalog
    // and slip the guard.
    const h = createHarness();

    window.applyBackendTabState!(JSON.stringify({
      provider: 'gemini',
      model: 'claude-sonnet-5[1m]',
    }));

    expect(h.setSelectedGeminiModel).not.toHaveBeenCalledWith('claude-sonnet-5[1m]');
    expect(h.setSelectedGeminiModel).not.toHaveBeenCalledWith('claude-sonnet-5');
  });

  it('onModelConfirmed does not poison the gemini slot (suffixed claude ids included)', () => {
    const h = createHarness();

    window.onModelConfirmed!('claude-sonnet-5', 'gemini');
    window.onModelConfirmed!('claude-sonnet-5-high', 'gemini');

    expect(h.setSelectedGeminiModel).not.toHaveBeenCalled();
  });

  it('still applies live agy claude slugs (retired in the claude catalog)', () => {
    const h = createHarness();

    window.applyBackendTabState!(JSON.stringify({
      provider: 'gemini',
      model: 'claude-sonnet-4-6',
    }));

    expect(h.setSelectedGeminiModel).toHaveBeenCalledWith('claude-sonnet-4-6');
  });
});
