import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SETTINGS_BOOTSTRAP_BRIDGE_MESSAGES,
  useSettingsWindowCallbacks,
  type SettingsWindowCallbacksDeps,
} from './useSettingsWindowCallbacks';
import type { CommitAiConfig } from '../../../types/aiFeatureConfig';
import type { PromptEnhancerConfig } from '../../../types/promptEnhancer';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe('useSettingsWindowCallbacks', () => {
  const createDeps = (): SettingsWindowCallbacksDeps => ({
    setNodePath: vi.fn(),
    setNodeVersion: vi.fn(),
    setMinNodeVersion: vi.fn(),
    setSavingNodePath: vi.fn(),
    setClaudeCliPath: vi.fn(),
    setSavingClaudeCliPath: vi.fn(),
    setWorkingDirectory: vi.fn(),
    setSavingWorkingDirectory: vi.fn(),
    setCommitPrompt: vi.fn(),
    setSavingCommitPrompt: vi.fn(),
    setCommitAiConfig: vi.fn(),
    setPromptEnhancerConfig: vi.fn(),
    setProjectCommitPrompt: vi.fn(),
    setSavingProjectCommitPrompt: vi.fn(),
    setEditorFontConfig: vi.fn(),
    setUiFontConfig: vi.fn(),
    setCodeFontConfig: vi.fn(),
    setIdeTheme: vi.fn(),
    setLocalStreamingEnabled: vi.fn(),
    setCodexSandboxMode: vi.fn(),
    setLocalSendShortcut: vi.fn(),
    setLoading: vi.fn(),
    setCodexLoading: vi.fn(),
    setCodexConfigLoading: vi.fn(),
    setSoundNotificationEnabled: vi.fn(),
    setSoundOnlyWhenUnfocused: vi.fn(),
    setSelectedSound: vi.fn(),
    setCustomSoundPath: vi.fn(),
    setSystemNotificationOnlyWhenUnfocused: vi.fn(),
    setAskUserQuestionSoundNotificationEnabled: vi.fn(),
    updateProviders: vi.fn(),
    updateActiveProvider: vi.fn(),
    loadProviders: vi.fn(),
    loadCodexProviders: vi.fn(),
    loadAgents: vi.fn(),
    updateAgents: vi.fn(),
    handleAgentOperationResult: vi.fn(),
    handleAgentImportPreviewResult: vi.fn(),
    handleAgentImportResult: vi.fn(),
    updateCodexProviders: vi.fn(),
    updateActiveCodexProvider: vi.fn(),
    updateCurrentCodexConfig: vi.fn(),
    cleanupAgentsTimeout: vi.fn(),
    showAlert: vi.fn(),
    addToast: vi.fn(),
  });

  beforeEach(() => {
    vi.useFakeTimers();
    // Force setTimeout path so fake timers control deferred batches. Asserting
    // to a plain optional-field type keeps delete legal: intersecting with
    // Window re-introduces lib.dom's required requestIdleCallback signature.
    delete (window as { requestIdleCallback?: unknown }).requestIdleCallback;
    delete (window as { cancelIdleCallback?: unknown }).cancelIdleCallback;
    window.sendToJava = vi.fn();
    window.applyUiFontConfig = vi.fn();
    window.applyCodeFontConfig = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads basic settings in batches without stamping providers/agents or CLI-probe configs', () => {
    const deps = createDeps();

    renderHook(() => useSettingsWindowCallbacks(deps));

    // Heavy list fetches are deferred until their settings tabs open.
    expect(deps.loadProviders).not.toHaveBeenCalled();
    expect(deps.loadCodexProviders).not.toHaveBeenCalled();
    expect(deps.loadAgents).not.toHaveBeenCalled();
    expect(window.sendToJava).not.toHaveBeenCalledWith('get_current_claude_config:');

    // First batch only (batchSize = 5), priority fields for first paint.
    const firstBatch = SETTINGS_BOOTSTRAP_BRIDGE_MESSAGES.slice(0, 5);
    expect((window.sendToJava as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toEqual([
      ...firstBatch,
    ]);

    // Drain deferred batches.
    vi.runAllTimers();
    const allMessages = (window.sendToJava as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    for (const message of SETTINGS_BOOTSTRAP_BRIDGE_MESSAGES) {
      expect(allMessages).toContain(message);
    }

    // CLI availability probes freeze JCEF when done on open — keep off bootstrap.
    expect(allMessages).not.toContain('get_commit_prompt:');
    expect(allMessages).not.toContain('get_commit_ai_config:');
    expect(allMessages).not.toContain('get_prompt_enhancer_config:');
  });

  it('registers prompt enhancer callback and updates state from backend payload', () => {
    const deps = createDeps();

    renderHook(() => useSettingsWindowCallbacks(deps));

    const payload: PromptEnhancerConfig = {
      provider: null,
      effectiveProvider: 'codex',
      resolutionSource: 'auto',
      models: {
        claude: 'claude-sonnet-4-6',
        codex: 'gpt-5.5',
        grok: 'grok',
        kimi: 'auto',
        opencode: 'opencode-default',
        pi: 'auto',
        omp: 'auto',
        minimax: 'auto',
      },
      availability: {
        claude: true,
        codex: true,
        grok: false,
        kimi: false,
        opencode: false,
        pi: false,
        omp: false,
        minimax: false,
      },
    };

    window.updatePromptEnhancerConfig?.(JSON.stringify(payload));

    expect(deps.setPromptEnhancerConfig).toHaveBeenCalledWith(payload);
  });

  it('registers commit AI callback and updates only commit AI state from backend payload', () => {
    const deps = createDeps();

    renderHook(() => useSettingsWindowCallbacks(deps));

    const payload: CommitAiConfig = {
      provider: null,
      effectiveProvider: 'codex',
      resolutionSource: 'auto',
      models: {
        claude: 'claude-sonnet-4-6',
        codex: 'gpt-5.5',
        grok: 'grok',
        kimi: 'auto',
        opencode: 'opencode-default',
        pi: 'auto',
        omp: 'auto',
        minimax: 'auto',
      },
      availability: {
        claude: true,
        codex: true,
        grok: false,
        kimi: false,
        opencode: false,
        pi: false,
        omp: false,
        minimax: false,
      },
    };

    window.updateCommitAiConfig?.(JSON.stringify(payload));

    expect(deps.setCommitAiConfig).toHaveBeenCalledWith(payload);
    expect(deps.setPromptEnhancerConfig).not.toHaveBeenCalled();
  });

  it('registers ui font callback and updates ui font state from backend payload', () => {
    const deps = createDeps();

    renderHook(() => useSettingsWindowCallbacks(deps));

    window.onUiFontConfigReceived?.(JSON.stringify({
      mode: 'customFile',
      effectiveMode: 'customFile',
      customFontPath: '/tmp/MapleMono.ttf',
      fontFamily: 'CC GUI Custom',
      fontSize: 14,
      lineSpacing: 1.35,
    }));

    expect((deps as any).setUiFontConfig).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'customFile',
      customFontPath: '/tmp/MapleMono.ttf',
      fontFamily: 'CC GUI Custom',
    }));
  });

  it('registers code font callback and updates code font state from backend payload', () => {
    const deps = createDeps();

    renderHook(() => useSettingsWindowCallbacks(deps));

    window.onCodeFontConfigReceived?.(JSON.stringify({
      mode: 'customFile',
      effectiveMode: 'customFile',
      customFontPath: '/tmp/FiraCode.ttf',
      fontFamily: 'CC GUI Code Custom',
      fontSize: 14,
      lineSpacing: 1.35,
    }));

    expect((deps as any).setCodeFontConfig).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'customFile',
      customFontPath: '/tmp/FiraCode.ttf',
      fontFamily: 'CC GUI Code Custom',
    }));
  });

  it('applies ui font immediately when backend pushes updated config', () => {
    const deps = createDeps();

    renderHook(() => useSettingsWindowCallbacks(deps));

    const payload = {
      mode: 'customFile',
      effectiveMode: 'customFile',
      customFontPath: '/tmp/MapleMono.ttf',
      fontFamily: 'CC GUI Custom',
      fontSize: 14,
      lineSpacing: 1.35,
      fontBase64: 'AAECA',
      fontFormat: 'truetype',
    };

    window.onUiFontConfigReceived?.(JSON.stringify(payload));

    expect(window.applyUiFontConfig).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'customFile',
      customFontPath: '/tmp/MapleMono.ttf',
      fontBase64: 'AAECA',
      fontFormat: 'truetype',
    }));
  });

  it('applies code font immediately when backend pushes updated config', () => {
    const deps = createDeps();

    renderHook(() => useSettingsWindowCallbacks(deps));

    const payload = {
      mode: 'customFile',
      effectiveMode: 'customFile',
      customFontPath: '/tmp/FiraCode.ttf',
      fontFamily: 'CC GUI Code Custom',
      fontSize: 14,
      lineSpacing: 1.35,
      fontBase64: 'AAECA',
      fontFormat: 'truetype',
    };

    window.onCodeFontConfigReceived?.(JSON.stringify(payload));

    expect(window.applyCodeFontConfig).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'customFile',
      customFontPath: '/tmp/FiraCode.ttf',
      fontBase64: 'AAECA',
      fontFormat: 'truetype',
    }));
  });

  it('registers system notification focus gate callback and updates state from backend payload', () => {
    const deps = createDeps();

    renderHook(() => useSettingsWindowCallbacks(deps));

    window.updateSystemNotificationOnlyWhenUnfocused?.(JSON.stringify({
      systemNotificationOnlyWhenUnfocused: true,
    }));

    expect(deps.setSystemNotificationOnlyWhenUnfocused).toHaveBeenCalledWith(true);
  });
});
