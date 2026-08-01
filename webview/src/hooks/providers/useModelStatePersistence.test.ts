import { renderHook } from '@testing-library/react';
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
    setPermissionMode: vi.fn(),
    setLongContextEnabled: vi.fn(),
    setReasoningEffort: vi.fn(),
    setCodexFastMode: vi.fn(),
    currentProvider: 'claude',
    selectedClaudeModel: 'claude-sonnet-4-5',
    selectedCodexModel: 'gpt-5-codex',
    claudePermissionMode: 'default' as PermissionMode,
    codexPermissionMode: 'default' as PermissionMode,
    longContextEnabled: false,
    reasoningEffort: 'medium',
    codexFastMode: 'normal',
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
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
    delete (window as unknown as { __INITIAL_TAB_REASONING_EFFORT__?: unknown }).__INITIAL_TAB_REASONING_EFFORT__;
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
});

describe('useModelStatePersistence — retired model migration', () => {
  beforeEach(() => {
    localStorage.clear();
    sendBridgeEventMock.mockClear();
    (window as unknown as { sendToJava?: unknown }).sendToJava = () => {};
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
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

    expect(setSelectedClaudeModel).toHaveBeenCalledWith('claude-sonnet-4-7');
    expect(setSelectedClaudeModel).not.toHaveBeenCalledWith('claude-fable-5');
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'claude-sonnet-4-7']]);
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

    expect(setSelectedClaudeModel).toHaveBeenCalledWith('claude-sonnet-4-7');
    expect(bridgeEventsFor('set_model')).toEqual([['set_model', 'claude-sonnet-4-7']]);
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

describe('useModelStatePersistence — Codex reasoning effort', () => {
  beforeEach(() => {
    localStorage.clear();
    sendBridgeEventMock.mockClear();
    (window as unknown as { sendToJava?: unknown }).sendToJava = () => {};
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (window as unknown as { sendToJava?: unknown }).sendToJava;
    delete (window as unknown as { __INITIAL_TAB_REASONING_EFFORT__?: unknown }).__INITIAL_TAB_REASONING_EFFORT__;
  });

  it('restores Ultra from the persisted model-selection state', () => {
    const setReasoningEffort = vi.fn();
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'codex',
      codexModel: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setReasoningEffort })));
    vi.advanceTimersByTime(200);

    expect(setReasoningEffort).toHaveBeenCalledWith('ultra');
  });

  it('prefers a restored tab effort over the shared localStorage effort', () => {
    const setReasoningEffort = vi.fn();
    (window as unknown as {
      __INITIAL_TAB_REASONING_EFFORT__?: unknown;
    }).__INITIAL_TAB_REASONING_EFFORT__ = 'high';
    localStorage.setItem('model-selection-state', JSON.stringify({
      provider: 'codex',
      codexModel: 'gpt-5.6-sol',
      reasoningEffort: 'ultra',
    }));

    renderHook(() => useModelStatePersistence(makeOptions({ setReasoningEffort })));
    vi.advanceTimersByTime(200);

    expect(setReasoningEffort).toHaveBeenCalledWith('high');
    expect(setReasoningEffort).not.toHaveBeenCalledWith('ultra');
  });
});
