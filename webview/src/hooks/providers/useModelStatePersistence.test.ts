import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelStatePersistence, type UseModelStatePersistenceOptions } from './useModelStatePersistence';
import { DEFAULT_CLAUDE_MODEL_ID } from '../../components/ChatInputBox/types';
import type { PermissionMode } from '../../components/ChatInputBox/types';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => sendBridgeEventMock(...args),
}));

function makeOptions(overrides: Partial<UseModelStatePersistenceOptions> = {}): UseModelStatePersistenceOptions {
  return {
    setCurrentProvider: vi.fn(),
    setSelectedClaudeModel: vi.fn(),
    setSelectedCodexModel: vi.fn(),
    setClaudePermissionMode: vi.fn(),
    setCodexPermissionMode: vi.fn(),
    setSelectedGrokModel: vi.fn(),
    setSelectedKimiModel: vi.fn(),
    setSelectedOpenCodeModel: vi.fn(),
    setSelectedPiModel: vi.fn(),
    setSelectedOmpModel: vi.fn(),
    setSelectedDshModel: vi.fn(),
    setSelectedMimoModel: vi.fn(),
    setGrokPermissionMode: vi.fn(),
    setKimiPermissionMode: vi.fn(),
    setOpenCodePermissionMode: vi.fn(),
    setPiPermissionMode: vi.fn(),
    setOmpPermissionMode: vi.fn(),
    setDshPermissionMode: vi.fn(),
    setMimoPermissionMode: vi.fn(),
    setPermissionMode: vi.fn(),
    setLongContextEnabled: vi.fn(),
    setReasoningEffort: vi.fn(),
    setCodexFastMode: vi.fn(),
    setDshPreset: vi.fn(),
    currentProvider: 'claude',
    selectedClaudeModel: 'claude-sonnet-4-5',
    selectedCodexModel: 'gpt-5-codex',
    claudePermissionMode: 'default' as PermissionMode,
    codexPermissionMode: 'default' as PermissionMode,
    selectedGrokModel: 'grok-4.6',
    selectedKimiModel: 'auto',
    selectedOpenCodeModel: 'opencode-default',
    selectedPiModel: 'auto',
    selectedOmpModel: 'auto',
    selectedDshModel: 'auto',
    selectedMimoModel: 'auto',
    grokPermissionMode: 'default' as PermissionMode,
    kimiPermissionMode: 'default' as PermissionMode,
    openCodePermissionMode: 'default' as PermissionMode,
    piPermissionMode: 'default' as PermissionMode,
    ompPermissionMode: 'default' as PermissionMode,
    dshPermissionMode: 'default' as PermissionMode,
    mimoPermissionMode: 'default' as PermissionMode,
    longContextEnabled: false,
    reasoningEffort: 'medium',
    codexFastMode: 'normal',
    dshPreset: '',
    ...overrides,
  };
}

function bridgeEventsFor(name: string): unknown[][] {
  return sendBridgeEventMock.mock.calls.filter((c) => c[0] === name);
}

describe('useModelStatePersistence — boot sync does not clobber the persisted permission mode', () => {
  beforeEach(() => {
    localStorage.clear();
    sendBridgeEventMock.mockClear();
    (window as unknown as { sendToJava?: unknown }).sendToJava = () => {};
    window.__CCGUI_PAGE_CONTEXT_READY__ = true;
    window.__CCGUI_PAGE_LOAD_KIND__ = 'initial_load';
    window.__CCGUI_RECOVERY_RELOAD__ = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
    delete window.__CCGUI_PAGE_CONTEXT_READY__;
    delete window.__CCGUI_PAGE_LOAD_KIND__;
    delete window.__CCGUI_RECOVERY_RELOAD__;
    delete window.__CCGUI_RECOVERY_STATE_APPLIED__;
    delete window.__INITIAL_TAB_PROVIDER__;
    delete window.__INITIAL_TAB_MODEL__;
  });

  it('does NOT send set_mode on boot when localStorage was wiped (reinstall)', () => {
    // Reinstall wipes JCEF localStorage → the hook would fall back to 'default'.
    // Pushing that to Java on boot would clobber the app-level PropertiesComponent
    // value (e.g. bypassPermissions) that survives the reinstall — the reported
    // "reinstall forgets Auto" bug. Java is the source of truth via get_mode.
    renderHook(() => useModelStatePersistence(makeOptions()));
    vi.advanceTimersByTime(200); // fire the deferred syncToBackend

    expect(bridgeEventsFor('set_mode')).toHaveLength(0);
    // Provider/model/codex-fast are webview-owned and must still sync.
    expect(bridgeEventsFor('set_provider')).toHaveLength(1);
    expect(bridgeEventsFor('set_model')).toHaveLength(1);
    expect(bridgeEventsFor('set_codex_fast_mode')).toHaveLength(1);
  });

  it('does NOT send set_mode on boot even when localStorage carries a non-default mode', () => {
    // Even when the webview snapshot has a valid mode, Java is authoritative on
    // boot (it may hold a newer value); the webview seeds itself from Java via
    // get_mode → onModeReceived, so the boot path must never push the mode down.
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudePermissionMode: 'bypassPermissions',
      permissionMode: 'bypassPermissions',
    }));

    renderHook(() => useModelStatePersistence(makeOptions()));
    vi.advanceTimersByTime(200);

    expect(bridgeEventsFor('set_mode')).toHaveLength(0);
  });

  it('retries the boot sync until the JCEF bridge is ready, still without set_mode', () => {
    // Bridge not ready yet → the hook retries every 100ms. Mode must never leak
    // into any of the retried sync attempts either.
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
    renderHook(() => useModelStatePersistence(makeOptions()));

    vi.advanceTimersByTime(200); // first attempt: bridge missing → schedules retry
    expect(sendBridgeEventMock).not.toHaveBeenCalled();

    (window as unknown as { sendToJava?: unknown }).sendToJava = () => {};
    vi.advanceTimersByTime(100); // retry now succeeds

    expect(bridgeEventsFor('set_provider')).toHaveLength(1);
    expect(bridgeEventsFor('set_mode')).toHaveLength(0);
  });

  it('keeps frontend boot synchronization enabled for a pre-ready startup retry', () => {
    window.__CCGUI_PAGE_LOAD_KIND__ = 'startup_retry';
    window.__CCGUI_RECOVERY_RELOAD__ = false;

    renderHook(() => useModelStatePersistence(makeOptions()));
    vi.advanceTimersByTime(200);

    expect(bridgeEventsFor('set_provider')).toHaveLength(1);
    expect(bridgeEventsFor('set_model')).toHaveLength(1);
    expect(bridgeEventsFor('set_codex_fast_mode')).toHaveLength(1);
  });

  it('does not echo the stale HTML provider or model during watchdog recovery', () => {
    window.__CCGUI_RECOVERY_RELOAD__ = true;
    window.__CCGUI_RECOVERY_STATE_APPLIED__ = false;
    window.__INITIAL_TAB_PROVIDER__ = 'codex';
    window.__INITIAL_TAB_MODEL__ = 'gpt-5.6-sol';

    renderHook(() => useModelStatePersistence(makeOptions()));
    vi.advanceTimersByTime(200);

    expect(bridgeEventsFor('set_provider')).toHaveLength(0);
    expect(bridgeEventsFor('set_model')).toHaveLength(0);
    expect(bridgeEventsFor('set_codex_fast_mode')).toHaveLength(0);
    expect(localStorage.getItem('model-selection-state')).toBeNull();
  });

  it('waits for runtime page context and authoritative recovery state before persisting', () => {
    window.__CCGUI_PAGE_CONTEXT_READY__ = false;
    delete window.__CCGUI_RECOVERY_RELOAD__;

    renderHook(() => useModelStatePersistence(makeOptions()));
    expect(localStorage.getItem('model-selection-state')).toBeNull();

    act(() => vi.advanceTimersByTime(100));
    expect(localStorage.getItem('model-selection-state')).toBeNull();

    window.__CCGUI_PAGE_CONTEXT_READY__ = true;
    window.__CCGUI_RECOVERY_RELOAD__ = true;
    act(() => vi.advanceTimersByTime(100));
    expect(localStorage.getItem('model-selection-state')).toBeNull();

    window.__CCGUI_RECOVERY_STATE_APPLIED__ = true;
    act(() => vi.advanceTimersByTime(100));
    expect(JSON.parse(localStorage.getItem('model-selection-state') || '{}').provider).toBe('claude');
  });
});

describe('useModelStatePersistence — retired model migration', () => {
  beforeEach(() => {
    localStorage.clear();
    sendBridgeEventMock.mockClear();
    (window as unknown as { sendToJava?: unknown }).sendToJava = () => {};
    window.__CCGUI_PAGE_CONTEXT_READY__ = true;
    window.__CCGUI_PAGE_LOAD_KIND__ = 'initial_load';
    window.__CCGUI_RECOVERY_RELOAD__ = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
    delete window.__CCGUI_PAGE_CONTEXT_READY__;
    delete window.__CCGUI_PAGE_LOAD_KIND__;
    delete window.__CCGUI_RECOVERY_RELOAD__;
    delete window.__CCGUI_RECOVERY_STATE_APPLIED__;
    delete (window as unknown as { __INITIAL_TAB_PROVIDER__?: unknown }).__INITIAL_TAB_PROVIDER__;
    delete (window as unknown as { __INITIAL_TAB_MODEL__?: unknown }).__INITIAL_TAB_MODEL__;
  });

  it('migrates a saved retired model (sonnet-4-6) to its replacement instead of the list head', () => {
    // Regression: v0.4.8 removed claude-sonnet-4-6 from CLAUDE_MODELS and put
    // claude-fable-5 first. Saved sonnet-4-6 failed validation and the fallback
    // CLAUDE_MODELS[0] silently reset users to fable-5, which API relays without
    // a fable-5 channel rejected ("No available channel for model claude-fable-5").
    const setSelectedClaudeModel = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeModel: 'claude-sonnet-4-6',
      longContextEnabled: false,
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedClaudeModel })));
    vi.advanceTimersByTime(200);

    expect(setSelectedClaudeModel).toHaveBeenCalledWith('claude-sonnet-5');
    expect(setSelectedClaudeModel).not.toHaveBeenCalledWith('claude-fable-5');
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'claude-sonnet-5']]);
  });

  it('migrates a backend-supplied retired model via __INITIAL_TAB_MODEL__', () => {
    const setSelectedClaudeModel = vi.fn();
    (window as unknown as { __INITIAL_TAB_PROVIDER__?: unknown }).__INITIAL_TAB_PROVIDER__ = 'claude';
    (window as unknown as { __INITIAL_TAB_MODEL__?: unknown }).__INITIAL_TAB_MODEL__ = 'claude-sonnet-4-6';
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeModel: 'claude-sonnet-4-6',
      longContextEnabled: false,
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedClaudeModel })));
    vi.advanceTimersByTime(200);

    expect(setSelectedClaudeModel).toHaveBeenCalledWith('claude-sonnet-5');
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'claude-sonnet-5']]);
  });

  it('falls back to the default model (not the list head) for unrecognized saved models', () => {
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeModel: 'claude-no-such-model',
      longContextEnabled: false,
    }));

    renderHook(() => useModelStatePersistence(makeOptions()));
    vi.advanceTimersByTime(200);

    expect(bridgeEventsFor('set_model')).toEqual([['set_model', DEFAULT_CLAUDE_MODEL_ID]]);
    expect(DEFAULT_CLAUDE_MODEL_ID).not.toBe('claude-fable-5');
  });
});

describe('useModelStatePersistence — CLI provider persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    sendBridgeEventMock.mockClear();
    (window as unknown as { sendToJava?: unknown }).sendToJava = () => {};
    window.__CCGUI_PAGE_CONTEXT_READY__ = true;
    window.__CCGUI_PAGE_LOAD_KIND__ = 'initial_load';
    window.__CCGUI_RECOVERY_RELOAD__ = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
    delete window.__CCGUI_PAGE_CONTEXT_READY__;
    delete window.__CCGUI_PAGE_LOAD_KIND__;
    delete window.__CCGUI_RECOVERY_RELOAD__;
    delete window.__CCGUI_RECOVERY_STATE_APPLIED__;
    delete (window as unknown as { __INITIAL_TAB_PROVIDER__?: unknown }).__INITIAL_TAB_PROVIDER__;
    delete (window as unknown as { __INITIAL_TAB_MODEL__?: unknown }).__INITIAL_TAB_MODEL__;
  });

  it('restores a saved CLI provider instead of silently falling back to claude', () => {
    // Regression: the hydration allowlist was ['claude','codex'], so a saved
    // grok/kimi/opencode provider was dropped and syncToBackend then pushed
    // set_provider claude, clobbering the CLI session on restart.
    const setCurrentProvider = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'kimi',
      kimiModel: 'kimi-k3',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setCurrentProvider })));
    vi.advanceTimersByTime(200);

    expect(setCurrentProvider).toHaveBeenCalledWith('kimi');
    expect(bridgeEventsFor('set_provider')).toEqual([['set_provider', 'kimi']]);
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'kimi-k3']]);
  });

  it('migrates a stale sentinel grok model id to grok-4.6', () => {
    // Versions before the ACP model-id fix persisted the profile name 'grok';
    // the ACP CLI rejects it ("unknown model id"), so it must be upgraded.
    const setSelectedGrokModel = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'grok',
      grokModel: 'grok',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedGrokModel })));
    vi.advanceTimersByTime(200);

    expect(setSelectedGrokModel).toHaveBeenCalledWith('grok-4.6');
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'grok-4.6']]);
  });

  it('honors a backend-supplied CLI provider via __INITIAL_TAB_PROVIDER__', () => {
    const setCurrentProvider = vi.fn();
    (window as unknown as { __INITIAL_TAB_PROVIDER__?: unknown }).__INITIAL_TAB_PROVIDER__ = 'grok';
    (window as unknown as { __INITIAL_TAB_MODEL__?: unknown }).__INITIAL_TAB_MODEL__ = 'grok-4.6';

    renderHook(() => useModelStatePersistence(makeOptions({ setCurrentProvider })));
    vi.advanceTimersByTime(200);

    expect(setCurrentProvider).toHaveBeenCalledWith('grok');
    expect(bridgeEventsFor('set_provider')).toEqual([['set_provider', 'grok']]);
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'grok-4.6']]);
  });

  it('persists CLI model and permission selections in the snapshot', () => {
    renderHook(() => useModelStatePersistence(makeOptions({
      currentProvider: 'opencode',
      selectedOpenCodeModel: 'openai/gpt-5',
      openCodePermissionMode: 'acceptEdits',
    })));

    const saved = JSON.parse(localStorage.getItem('model-selection-state') ?? '{}');
    expect(saved.provider).toBe('opencode');
    expect(saved.openCodeModel).toBe('openai/gpt-5');
    expect(saved.openCodePermissionMode).toBe('acceptEdits');
  });

  it('restores a saved omp model and permission selection', () => {
    const setSelectedOmpModel = vi.fn();
    const setOmpPermissionMode = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'omp',
      ompModel: 'openai/gpt-5',
      ompPermissionMode: 'acceptEdits',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedOmpModel, setOmpPermissionMode })));
    vi.advanceTimersByTime(200);

    expect(setSelectedOmpModel).toHaveBeenCalledWith('openai/gpt-5');
    expect(setOmpPermissionMode).toHaveBeenCalledWith('acceptEdits');
    expect(bridgeEventsFor('set_provider')).toEqual([['set_provider', 'omp']]);
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'openai/gpt-5']]);
  });

  it('reconciles a stale omp pair saved before mode⇔model unification (role mode + auto model)', () => {
    const setSelectedOmpModel = vi.fn();
    const setOmpPermissionMode = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'omp',
      ompModel: 'auto',
      ompPermissionMode: 'smol',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedOmpModel, setOmpPermissionMode })));
    vi.advanceTimersByTime(200);

    // Role mode wins: the model is forced to the role id and synced to Java.
    expect(setSelectedOmpModel).toHaveBeenLastCalledWith('smol');
    expect(setOmpPermissionMode).toHaveBeenCalledWith('smol');
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'smol']]);
  });

  it('falls back to omp defaults when the snapshot has no omp keys', () => {
    const setSelectedOmpModel = vi.fn();
    const setOmpPermissionMode = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'claude',
      claudeModel: 'claude-sonnet-4-5',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedOmpModel, setOmpPermissionMode })));
    vi.advanceTimersByTime(200);

    expect(setSelectedOmpModel).not.toHaveBeenCalled();
    expect(setOmpPermissionMode).toHaveBeenCalledWith('default');
  });

  it('restores a dynamic omp role mode (designer) that is outside the static whitelist', () => {
    const setSelectedOmpModel = vi.fn();
    const setOmpPermissionMode = vi.fn();
    const setPermissionMode = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'omp',
      ompModel: 'designer',
      ompPermissionMode: 'designer',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedOmpModel, setOmpPermissionMode, setPermissionMode })));
    vi.advanceTimersByTime(200);

    expect(setSelectedOmpModel).toHaveBeenCalledWith('designer');
    expect(setOmpPermissionMode).toHaveBeenCalledWith('designer');
    expect(setPermissionMode).toHaveBeenCalledWith('designer');
    expect(bridgeEventsFor('set_provider')).toEqual([['set_provider', 'omp']]);
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'designer']]);
  });

  it('drops a malformed omp permission mode from the snapshot', () => {
    const setOmpPermissionMode = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'omp',
      ompModel: 'designer',
      ompPermissionMode: '!!not-a-role',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setOmpPermissionMode })));
    vi.advanceTimersByTime(200);

    expect(setOmpPermissionMode).toHaveBeenCalledWith('default');
  });
});

describe('useModelStatePersistence — codex dynamic catalog models', () => {
  beforeEach(() => {
    localStorage.clear();
    sendBridgeEventMock.mockClear();
    (window as unknown as { sendToJava?: unknown }).sendToJava = () => {};
    window.__CCGUI_PAGE_CONTEXT_READY__ = true;
    window.__CCGUI_PAGE_LOAD_KIND__ = 'initial_load';
    window.__CCGUI_RECOVERY_RELOAD__ = false;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
    delete window.__CCGUI_PAGE_CONTEXT_READY__;
    delete window.__CCGUI_PAGE_LOAD_KIND__;
    delete window.__CCGUI_RECOVERY_RELOAD__;
    delete window.__CCGUI_RECOVERY_STATE_APPLIED__;
    delete (window as unknown as { __INITIAL_TAB_PROVIDER__?: unknown }).__INITIAL_TAB_PROVIDER__;
    delete (window as unknown as { __INITIAL_TAB_MODEL__?: unknown }).__INITIAL_TAB_MODEL__;
  });

  it('restores a saved codex model that only exists in the dynamic catalog', () => {
    // The codex model list is dynamic (config.toml `model` + model_catalog_json),
    // so a catalog-only id like kimi-k3 must survive restart instead of being
    // reset to CODEX_MODELS[0] before the catalog fetch lands.
    const setSelectedCodexModel = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'codex',
      codexModel: 'kimi-k3',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedCodexModel })));
    vi.advanceTimersByTime(200);

    expect(setSelectedCodexModel).toHaveBeenCalledWith('kimi-k3');
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'kimi-k3']]);
  });

  it('honors a backend-supplied dynamic codex model via __INITIAL_TAB_MODEL__', () => {
    const setSelectedCodexModel = vi.fn();
    (window as unknown as { __INITIAL_TAB_PROVIDER__?: unknown }).__INITIAL_TAB_PROVIDER__ = 'codex';
    (window as unknown as { __INITIAL_TAB_MODEL__?: unknown }).__INITIAL_TAB_MODEL__ = 'kimi-k3';

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedCodexModel })));
    vi.advanceTimersByTime(200);

    expect(setSelectedCodexModel).toHaveBeenCalledWith('kimi-k3');
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'kimi-k3']]);
  });

  it('ignores an empty saved codex model and keeps the default', () => {
    const setSelectedCodexModel = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'codex',
      codexModel: '   ',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setSelectedCodexModel })));
    vi.advanceTimersByTime(200);

    expect(setSelectedCodexModel).not.toHaveBeenCalled();
    expect(bridgeEventsFor('set_model')).toHaveLength(1);
  });
});
