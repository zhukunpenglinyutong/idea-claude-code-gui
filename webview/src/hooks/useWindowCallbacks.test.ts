import { act, renderHook } from '@testing-library/react';
import { useWindowCallbacks } from './useWindowCallbacks.js';
import type { UseWindowCallbacksOptions } from './useWindowCallbacks.js';
import type { ClaudeMessage } from '../types/index.js';
import { forceWebviewRepaint } from '../utils/forceWebviewRepaint.js';

// Mock the repaint util so we can assert the session-transition path triggers it
// without touching the real DOM (there is no #app element under jsdom).
vi.mock('../utils/forceWebviewRepaint.js', () => ({ forceWebviewRepaint: vi.fn() }));

/**
 * Integration tests for useWindowCallbacks — verifies the real window callback
 * chain (historyLoadComplete, addErrorMessage, updateMessages guard, clearMessages,
 * setSessionId) rather than simulating state bits.
 */
describe('useWindowCallbacks integration', () => {
  const t = ((key: string) => key) as any;

  /** Build the full options object with vi.fn() stubs for every field. */
  const createOptions = (overrides?: Partial<UseWindowCallbacksOptions>): UseWindowCallbacksOptions => ({
    t,
    addToast: vi.fn(),
    clearToasts: vi.fn(),

    // State setters
    setMessages: vi.fn(),
    setStatus: vi.fn(),
    setLoading: vi.fn(),
    setLoadingStartTime: vi.fn(),
    setIsThinking: vi.fn(),
    setExpandedThinking: vi.fn(),
    setStreamingActive: vi.fn(),
    setHistoryData: vi.fn(),
    setCurrentSessionId: vi.fn(),
    setCustomSessionTitle: vi.fn(),
    setUsagePercentage: vi.fn(),
    setUsageUsedTokens: vi.fn(),
    setUsageMaxTokens: vi.fn(),
    setSubagentHistories: vi.fn(),
    setPermissionMode: vi.fn(),
    setClaudePermissionMode: vi.fn(),
    setCodexPermissionMode: vi.fn(),
    setSelectedClaudeModel: vi.fn(),
    setSelectedCodexModel: vi.fn(),
    setProviderConfigVersion: vi.fn(),
    setActiveProviderConfig: vi.fn(),
    setClaudeSettingsAlwaysThinkingEnabled: vi.fn(),
    setStreamingEnabledSetting: vi.fn(),
    setSendShortcut: vi.fn(),
    setAutoOpenFileEnabled: vi.fn(),
    setPermissionDialogTimeoutSeconds: vi.fn(),
    setSdkStatus: vi.fn(),
    setSdkStatusLoaded: vi.fn(),
    setIsRewinding: vi.fn(),
    setRewindDialogOpen: vi.fn(),
    setCurrentRewindRequest: vi.fn(),
    setContextInfo: vi.fn(),
    setSelectedAgent: vi.fn(),

    // Refs
    currentProviderRef: { current: 'claude' },
    messagesContainerRef: { current: null },
    isUserAtBottomRef: { current: true },
    userPausedRef: { current: false },
    suppressNextStatusToastRef: { current: false },
    streamingContentRef: { current: '' },
    streamingThinkingRef: { current: '' },
    isStreamingRef: { current: false },
    useBackendStreamingRenderRef: { current: false },
    autoExpandedThinkingKeysRef: { current: new Set<string>() },
    streamingMessageIndexRef: { current: -1 },
    streamingTurnIdRef: { current: -1 },
    turnIdCounterRef: { current: 0 },
    lastContentUpdateRef: { current: 0 },
    contentUpdateTimeoutRef: { current: null } as { current: number | null },
    lastThinkingUpdateRef: { current: 0 },
    thinkingUpdateTimeoutRef: { current: null } as { current: number | null },

    // Functions
    findLastAssistantIndex: (msgs: ClaudeMessage[]) =>
      msgs.reduce((acc, m, i) => (m.type === 'assistant' ? i : acc), -1),
    extractRawBlocks: () => [],
    getOrCreateStreamingAssistantIndex: () => 0,
    patchAssistantForStreaming: (msg: ClaudeMessage) => msg,
    syncActiveProviderModelMapping: vi.fn(),
    openPermissionDialog: vi.fn(),
    openAskUserQuestionDialog: vi.fn(),
    openPlanApprovalDialog: vi.fn(),
    forceClosePermissionDialog: vi.fn(),
    forceCloseAskUserQuestionDialog: vi.fn(),
    forceClosePlanApprovalDialog: vi.fn(),
    openContextUsageDialog: vi.fn(),
    updateContextUsageData: vi.fn(),
    closeContextUsageDialog: vi.fn(),

    // B-011
    customSessionTitleRef: { current: null },
    currentSessionIdRef: { current: null },
    updateHistoryTitle: vi.fn(),
    applyHistoryTitleLocal: vi.fn(),

    ...overrides,
  });

  beforeEach(() => {
    window.__sessionTransitioning = false;
    window.__sessionTransitionToken = null;
    window.__pendingSessionTransitionToast = undefined;
    window.__deniedToolIds = new Set();
    window.sendToJava = vi.fn();
    // The drain test inspects this slot; if a prior test (or earlier suite run)
    // leaked a value onto window we'd see a false-positive drain. Wipe it here
    // so each test starts from a clean pending state.
    delete (window as unknown as Record<string, unknown>).__pendingPermissionDialogTimeout;
  });

  /** Stub timer/rAF globals to execute synchronously for streaming tests. */
  const stubSynchronousTimers = () => {
    vi.stubGlobal('setTimeout', (callback: () => void) => {
      callback();
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    vi.stubGlobal('clearTimeout', vi.fn());
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Builds opts whose setMessages mock actually runs the updater against a shared
   * messages buffer, so the production reducer logic is exercised end to end.
   * Shared by the "marks unresolved tool_use as interrupted" and Issue #1315 suites.
   */
  const createOptsWithMessages = (messages: ClaudeMessage[]) => {
    const buffer = { current: messages };
    const setMessages = vi.fn((value: ClaudeMessage[] | ((prev: ClaudeMessage[]) => ClaudeMessage[])) => {
      buffer.current = typeof value === 'function'
        ? (value as (prev: ClaudeMessage[]) => ClaudeMessage[])(buffer.current)
        : value;
    });
    const opts = createOptions({ setMessages: setMessages as never });
    return { opts, buffer };
  };

  // ===== historyLoadComplete releases transition guard =====

  it('historyLoadComplete releases __sessionTransitioning guard', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    // Simulate: beginSessionTransition sets guard
    window.__sessionTransitioning = true;
    window.__sessionTransitionToken = 'transition-1';

    // Simulate: Java calls historyLoadComplete on success
    act(() => {
      window.historyLoadComplete!();
    });

    expect(window.__sessionTransitioning).toBe(false);
    expect(window.__sessionTransitionToken).toBeNull();
  });

  it('historyLoadComplete shows pending session transition toast', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    window.__pendingSessionTransitionToast = {
      message: 'history.sessionDeleted',
      type: 'success',
    };

    act(() => {
      window.historyLoadComplete!();
    });

    expect(opts.addToast).toHaveBeenCalledWith('history.sessionDeleted', 'success');
    expect(window.__pendingSessionTransitionToast).toBeUndefined();
  });

  // ===== historyLoadComplete triggers full message re-render =====

  it('historyLoadComplete creates new object references for all messages', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    const originalMessages: ClaudeMessage[] = [
      { type: 'user', content: 'question', timestamp: '2024-01-01T00:00:00Z' },
      { type: 'assistant', content: 'answer', timestamp: '2024-01-01T00:01:00Z' },
    ];

    act(() => {
      window.historyLoadComplete!();
    });

    expect(opts.setMessages).toHaveBeenCalledTimes(1);
    const updater = (opts.setMessages as any).mock.calls[0][0] as (prev: ClaudeMessage[]) => ClaudeMessage[];
    const result = updater(originalMessages);

    // Verify full shallow copy: array is new, each message object is new
    expect(result).not.toBe(originalMessages);
    expect(result.length).toBe(originalMessages.length);
    for (let i = 0; i < result.length; i++) {
      expect(result[i]).not.toBe(originalMessages[i]);
      expect(result[i].content).toBe(originalMessages[i].content);
      expect(result[i].type).toBe(originalMessages[i].type);
    }
  });

  it('historyLoadComplete returns unchanged array when messages are empty', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      window.historyLoadComplete!();
    });

    expect(opts.setMessages).toHaveBeenCalledTimes(1);
    const updater = (opts.setMessages as any).mock.calls[0][0] as (prev: ClaudeMessage[]) => ClaudeMessage[];
    const emptyArray: ClaudeMessage[] = [];
    const result = updater(emptyArray);

    // Returns the same empty array reference (no unnecessary copy)
    expect(result).toBe(emptyArray);
    expect(result.length).toBe(0);
  });

  // ===== setSessionId releases transition guard =====

  it('setSessionId releases __sessionTransitioning guard', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    window.__sessionTransitioning = true;
    window.__sessionTransitionToken = 'transition-2';

    act(() => {
      window.setSessionId!('new-session-123');
    });

    expect(window.__sessionTransitioning).toBe(false);
    expect(window.__sessionTransitionToken).toBeNull();
    expect(opts.setCurrentSessionId).toHaveBeenCalledWith('new-session-123');
  });

  // ===== AI title path uses applyHistoryTitleLocal (no backend round-trip) =====

  it('updateSessionTitle routes AI titles through applyHistoryTitleLocal, not updateHistoryTitle', () => {
    const opts = createOptions({
      currentSessionIdRef: { current: 'sess-123' },
    });
    renderHook(() => useWindowCallbacks(opts));

    const longAiTitle = 'A very long AI-generated session title that exceeds fifty characters easily';

    act(() => {
      window.updateSessionTitle!('sess-123', longAiTitle);
    });

    expect(opts.applyHistoryTitleLocal).toHaveBeenCalledWith('sess-123', longAiTitle);
    expect(opts.updateHistoryTitle).not.toHaveBeenCalled();
    expect(opts.setCustomSessionTitle).toHaveBeenCalledWith(longAiTitle);
  });

  it('updateSessionTitle skips when sessionId does not match currentSessionIdRef (stale event)', () => {
    const opts = createOptions({
      currentSessionIdRef: { current: 'sess-current' },
    });
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      window.updateSessionTitle!('sess-stale', 'Stale AI title');
    });

    expect(opts.applyHistoryTitleLocal).not.toHaveBeenCalled();
    expect(opts.updateHistoryTitle).not.toHaveBeenCalled();
    expect(opts.setCustomSessionTitle).not.toHaveBeenCalled();
  });

  it('updateSessionTitle skips empty / whitespace-only titles', () => {
    const opts = createOptions({
      currentSessionIdRef: { current: 'sess-123' },
    });
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      window.updateSessionTitle!('sess-123', '   ');
    });

    expect(opts.applyHistoryTitleLocal).not.toHaveBeenCalled();
    expect(opts.updateHistoryTitle).not.toHaveBeenCalled();
  });

  // ===== Codex thread transition: route long titles to local-only =====

  it('setSessionId with title > 50 chars uses applyHistoryTitleLocal to avoid backend 50-char limit', () => {
    const longTitle = 'A very long AI-generated session title that exceeds fifty characters easily';
    const opts = createOptions({
      customSessionTitleRef: { current: longTitle },
      currentSessionIdRef: { current: 'sess-old' },
    });
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      window.setSessionId!('sess-new');
    });

    expect(opts.applyHistoryTitleLocal).toHaveBeenCalledWith('sess-new', longTitle);
    expect(opts.updateHistoryTitle).not.toHaveBeenCalled();
  });

  it('setSessionId with title <= 50 chars uses updateHistoryTitle for backend persistence', () => {
    const shortTitle = 'Short user-set title';
    const opts = createOptions({
      customSessionTitleRef: { current: shortTitle },
      currentSessionIdRef: { current: 'sess-old' },
    });
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      window.setSessionId!('sess-new');
    });

    expect(opts.updateHistoryTitle).toHaveBeenCalledWith('sess-new', shortTitle);
    expect(opts.applyHistoryTitleLocal).not.toHaveBeenCalled();
  });

  // ===== updateMessages is blocked during transition =====

  it('updateMessages is silently dropped while __sessionTransitioning is true', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    window.__sessionTransitioning = true;

    const staleMessages: ClaudeMessage[] = [
      { type: 'assistant', content: 'stale content', timestamp: new Date().toISOString() },
    ];

    act(() => {
      window.updateMessages!(JSON.stringify(staleMessages));
    });

    // setMessages should NOT be called because guard is active
    expect(opts.setMessages).not.toHaveBeenCalled();
  });

  it('updateMessages works normally after guard is released', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    // Guard is NOT set
    expect(window.__sessionTransitioning).toBe(false);

    const freshMessages: ClaudeMessage[] = [
      { type: 'user', content: 'hello', timestamp: new Date().toISOString() },
    ];

    act(() => {
      window.updateMessages!(JSON.stringify(freshMessages));
    });

    // setMessages SHOULD be called
    expect(opts.setMessages).toHaveBeenCalled();
  });

  it('patchMessageUuid updates the latest unresolved user message using raw text fallback', () => {
    const opts = createOptions({
      extractRawBlocks: (raw) => {
        if (!raw || typeof raw !== 'object') return [];
        const content = (raw as any).message?.content;
        return Array.isArray(content) ? content : [];
      },
    });
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      window.patchMessageUuid?.('Generated attachment summary', 'uuid-123');
    });

    expect(opts.setMessages).toHaveBeenCalledTimes(1);
    const updater = (opts.setMessages as any).mock.calls[0][0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const previous: ClaudeMessage[] = [
      {
        type: 'user',
        content: 'older',
        timestamp: new Date().toISOString(),
        raw: {},
      },
      {
        type: 'user',
        content: '',
        timestamp: new Date().toISOString(),
        raw: {
          message: {
            content: [
              { type: 'attachment', fileName: 'trace.log' },
              { type: 'text', text: 'Generated attachment summary' },
            ],
          },
        } as any,
      },
    ];

    const next = updater(previous);

    expect((next[0].raw as any)?.uuid).toBeUndefined();
    expect((next[1].raw as any)?.uuid).toBe('uuid-123');
  });

  it('patchMessageUuid is ignored while __sessionTransitioning is true', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    window.__sessionTransitioning = true;

    act(() => {
      window.patchMessageUuid?.('hello', 'uuid-guarded');
    });

    expect(opts.setMessages).not.toHaveBeenCalled();
  });

  it('updateStatus does not release an active transition token', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    window.__sessionTransitioning = true;
    window.__sessionTransitionToken = 'transition-status';

    act(() => {
      window.updateStatus!('warming runtime');
    });

    expect(window.__sessionTransitioning).toBe(true);
    expect(window.__sessionTransitionToken).toBe('transition-status');
    expect(opts.setStatus).toHaveBeenCalledWith('warming runtime');
  });

  // ===== addErrorMessage only shows toast (no status) =====

  it('updatePermissionDialogTimeout sets timeout from JSON', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));
    act(() => {
      window.updatePermissionDialogTimeout!(JSON.stringify({ permissionDialogTimeoutSeconds: 120 }));
    });
    expect(opts.setPermissionDialogTimeoutSeconds).toHaveBeenCalledWith(120);
  });

  it('updatePermissionDialogTimeout ignores invalid JSON', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));
    act(() => {
      window.updatePermissionDialogTimeout!('not-json');
    });
    expect(opts.setPermissionDialogTimeoutSeconds).not.toHaveBeenCalled();
  });

  it('updatePermissionDialogTimeout clamps values from JSON', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      window.updatePermissionDialogTimeout!(JSON.stringify({ permissionDialogTimeoutSeconds: 1 }));
    });
    expect(opts.setPermissionDialogTimeoutSeconds).toHaveBeenLastCalledWith(30);

    act(() => {
      window.updatePermissionDialogTimeout!(JSON.stringify({ permissionDialogTimeoutSeconds: 99999 }));
    });
    expect(opts.setPermissionDialogTimeoutSeconds).toHaveBeenLastCalledWith(3600);
  });

  it('updatePermissionDialogTimeout falls back to 300 when field is missing or invalid', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      window.updatePermissionDialogTimeout!(JSON.stringify({ otherField: 123 }));
    });
    expect(opts.setPermissionDialogTimeoutSeconds).toHaveBeenLastCalledWith(300);

    act(() => {
      window.updatePermissionDialogTimeout!(JSON.stringify({ permissionDialogTimeoutSeconds: 'bad' }));
    });
    expect(opts.setPermissionDialogTimeoutSeconds).toHaveBeenLastCalledWith(300);
  });

  // ===== Bootstrap drain for permission dialog timeout =====
  //
  // main.tsx may receive `updatePermissionDialogTimeout` from Java before React has
  // mounted and registered the real callback. To avoid losing that payload it stashes
  // the raw JSON onto `window.__pendingPermissionDialogTimeout`. After registration,
  // `drainPendingSettings()` must replay it into the now-installed callback exactly
  // once and clear the slot so a later re-mount doesn't replay stale data.

  it('drains __pendingPermissionDialogTimeout into the setter on registration', () => {
    const w = window as unknown as Record<string, unknown>;
    w.__pendingPermissionDialogTimeout = JSON.stringify({ permissionDialogTimeoutSeconds: 900 });

    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    expect(opts.setPermissionDialogTimeoutSeconds).toHaveBeenCalledWith(900);
    // Pending slot is consumed exactly once — leaving it around would let a remount
    // re-fire the same value and clobber any later edits the user made in between.
    expect(w.__pendingPermissionDialogTimeout).toBeUndefined();
  });

  it('drained payload goes through the same clamp/validation as live updates', () => {
    const w = window as unknown as Record<string, unknown>;
    w.__pendingPermissionDialogTimeout = JSON.stringify({ permissionDialogTimeoutSeconds: 99999 });

    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    expect(opts.setPermissionDialogTimeoutSeconds).toHaveBeenCalledWith(3600);
    expect(w.__pendingPermissionDialogTimeout).toBeUndefined();
  });

  it('does not call setPermissionDialogTimeoutSeconds when no pending payload exists', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    expect(opts.setPermissionDialogTimeoutSeconds).not.toHaveBeenCalled();
  });

  it('addErrorMessage shows toast but does not set status', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      window.addErrorMessage!('Something went wrong');
    });

    expect(opts.addToast).toHaveBeenCalledWith('Something went wrong', 'error');
    expect(opts.setStatus).not.toHaveBeenCalled();
  });

  // ===== clearMessages resets all transient UI state =====

  it('clearMessages resets streaming refs, loading, thinking, and status', () => {
    const isStreamingRef = { current: true };
    const streamingContentRef = { current: 'partial content' };
    const streamingMessageIndexRef = { current: 3 };
    const opts = createOptions({
      isStreamingRef,
      streamingContentRef,
      streamingMessageIndexRef,
    });
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      window.clearMessages!();
    });

    expect(opts.setMessages).toHaveBeenCalledWith([]);
    expect(opts.clearToasts).toHaveBeenCalled();
    expect(opts.setStatus).toHaveBeenCalledWith('');
    expect(opts.setLoading).toHaveBeenCalledWith(false);
    expect(opts.setIsThinking).toHaveBeenCalledWith(false);
    expect(opts.setStreamingActive).toHaveBeenCalledWith(false);
    expect(isStreamingRef.current).toBe(false);
    expect(streamingContentRef.current).toBe('');
    expect(streamingMessageIndexRef.current).toBe(-1);
  });

  // ===== clearMessages forces a webview repaint to clear JCEF ghosting =====

  it('clearMessages triggers forceWebviewRepaint to clear leftover ghosting', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));
    vi.mocked(forceWebviewRepaint).mockClear();

    act(() => {
      window.clearMessages!();
    });

    expect(forceWebviewRepaint).toHaveBeenCalled();
  });

  // ===== clearMessages resets turn tracking refs =====

  it('clearMessages resets streamingTurnIdRef but preserves turnIdCounterRef', () => {
    const streamingTurnIdRef = { current: 5 };
    const turnIdCounterRef = { current: 10 };
    const opts = createOptions({
      streamingTurnIdRef,
      turnIdCounterRef,
    });
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      window.clearMessages!();
    });

    // Turn ID should be reset to -1 (no active streaming turn)
    expect(streamingTurnIdRef.current).toBe(-1);
    // Counter stays monotonically increasing (NOT reset) so React keys stay unique across sessions
    expect(turnIdCounterRef.current).toBe(10);
  });

  // ===== Full failure scenario: load history fails, guard is released, new messages work =====

  it('full flow: history load failure releases guard so new messages can arrive', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    // Step 1: Frontend begins session transition
    window.__sessionTransitioning = true;

    // Step 2: During transition, stale messages are blocked
    act(() => {
      window.updateMessages!(JSON.stringify([{ type: 'assistant', content: 'stale' }]));
    });
    expect(opts.setMessages).not.toHaveBeenCalled();

    // Step 3: Java calls historyLoadComplete (failure path also calls this before addErrorMessage)
    act(() => {
      window.historyLoadComplete!();
    });
    expect(window.__sessionTransitioning).toBe(false);

    // Step 4: Java calls addErrorMessage
    act(() => {
      window.addErrorMessage!('Failed to load session: network error');
    });
    expect(opts.addToast).toHaveBeenCalledWith('Failed to load session: network error', 'error');

    // Step 5: After guard release, new messages work
    act(() => {
      window.updateMessages!(
        JSON.stringify([{ type: 'user', content: 'new message' }])
      );
    });
    expect(opts.setMessages).toHaveBeenCalled();
  });

  it('ignores stale updateMessages snapshots that arrive after stream end', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      window.onStreamStart?.();
    });

    act(() => {
      window.onStreamEnd?.('10');
    });

    opts.isStreamingRef.current = false;
    (opts.setMessages as any).mockClear();

    act(() => {
      window.updateMessages!(
        JSON.stringify([{ type: 'assistant', content: 'stale backlog', timestamp: new Date().toISOString() }]),
        '9',
      );
    });

    expect(opts.setMessages).not.toHaveBeenCalled();

    act(() => {
      window.updateMessages!(
        JSON.stringify([{ type: 'assistant', content: 'final snapshot', timestamp: new Date().toISOString() }]),
        '10',
      );
    });

    expect(opts.setMessages).toHaveBeenCalledTimes(1);
  });

  it('accepts streaming updateMessages when assistant raw blocks gain spawn_agent tool_use', () => {
    stubSynchronousTimers();

    const patchAssistantForStreaming = vi.fn((msg: ClaudeMessage) => ({
      ...msg,
      isStreaming: true,
    }));
    const extractRawBlocks = (raw: unknown) => {
      if (!raw || typeof raw !== 'object') return [];
      const rawObj = raw as { content?: unknown; message?: { content?: unknown } };
      const blocks = rawObj.content ?? rawObj.message?.content;
      return Array.isArray(blocks) ? blocks : [];
    };

    const opts = createOptions({
      currentProviderRef: { current: 'codex' },
      isStreamingRef: { current: true },
      streamingTurnIdRef: { current: 7 },
      patchAssistantForStreaming,
      extractRawBlocks,
    });
    renderHook(() => useWindowCallbacks(opts));

    const previousMessages: ClaudeMessage[] = [
      {
        type: 'assistant',
        content: 'Working',
        timestamp: '2026-04-02T10:00:00.000Z',
        __turnId: 7,
        isStreaming: true,
        raw: {
          message: {
            content: [{ type: 'text', text: 'Working' }],
          },
        } as any,
      },
    ];

    act(() => {
      window.updateMessages!(JSON.stringify([
        {
          type: 'assistant',
          content: 'Working',
          timestamp: '2026-04-02T10:00:00.000Z',
          raw: {
            message: {
              content: [
                { type: 'tool_use', id: 'spawn-1', name: 'spawn_agent', input: { agent_type: 'Explore', message: 'Inspect renderer' } },
                { type: 'text', text: 'Working' },
              ],
            },
          },
        },
      ]));
    });

    expect(opts.setMessages).toHaveBeenCalledTimes(1);
    const updater = (opts.setMessages as any).mock.calls[0][0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const nextMessages = updater(previousMessages);

    expect(nextMessages).not.toBe(previousMessages);
    expect(patchAssistantForStreaming).toHaveBeenCalled();
    expect((nextMessages[0].raw as any).message.content[0]).toMatchObject({
      type: 'tool_use',
      name: 'spawn_agent',
      id: 'spawn-1',
    });
    expect(nextMessages[0].__turnId).toBe(7);
  });

  it('reuses replayed in-progress assistant when stream restarts after webview reload', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      window.onStreamStart?.('replay');
    });

    expect(opts.setMessages).toHaveBeenCalledTimes(1);
    const updater = (opts.setMessages as any).mock.calls[0][0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const replayedMessages: ClaudeMessage[] = [
      { type: 'user', content: 'question', timestamp: '2026-04-27T00:00:00.000Z' },
      { type: 'assistant', content: 'partial answer', timestamp: '2026-04-27T00:00:01.000Z' },
    ];

    const nextMessages = updater(replayedMessages);

    expect(nextMessages).toHaveLength(2);
    expect(nextMessages[1]).toMatchObject({
      type: 'assistant',
      content: 'partial answer',
      isStreaming: true,
      __turnId: 1,
    });
  });

  it('starts a fresh assistant message for a new turn instead of reusing the previous completed assistant', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    act(() => {
      window.onStreamStart?.();
    });

    expect(opts.setMessages).toHaveBeenCalledTimes(1);
    const updater = (opts.setMessages as any).mock.calls[0][0] as (messages: ClaudeMessage[]) => ClaudeMessage[];
    const previousMessages: ClaudeMessage[] = [
      { type: 'user', content: 'previous question', timestamp: '2026-04-27T00:00:00.000Z' },
      {
        type: 'assistant',
        content: 'previous answer',
        timestamp: '2026-04-27T00:00:01.000Z',
        durationMs: 1200,
      },
    ];

    const nextMessages = updater(previousMessages);

    expect(nextMessages).toHaveLength(3);
    expect(nextMessages[1]).toMatchObject({
      type: 'assistant',
      content: 'previous answer',
    });
    expect(nextMessages[1]?.isStreaming).not.toBe(true);
    expect(nextMessages[2]).toMatchObject({
      type: 'assistant',
      content: '',
      isStreaming: true,
      __turnId: 1,
    });
  });

  it('onSubagentHistoryLoaded skips updates only when history payload is truly unchanged', () => {
    const opts = createOptions();
    renderHook(() => useWindowCallbacks(opts));

    const firstPayload = {
      success: true,
      toolUseId: 'task-1',
      sessionId: 'session-1',
      messages: [{ type: 'assistant', content: [{ type: 'text', text: 'draft result' }] }],
    };

    act(() => {
      window.onSubagentHistoryLoaded?.(JSON.stringify(firstPayload));
    });

    expect(opts.setSubagentHistories).toHaveBeenCalledTimes(1);
    const firstUpdater = (opts.setSubagentHistories as any).mock.calls[0][0] as (prev: Record<string, unknown>) => Record<string, unknown>;
    const initialState = firstUpdater({});

    act(() => {
      window.onSubagentHistoryLoaded?.(JSON.stringify(firstPayload));
    });

    const secondUpdater = (opts.setSubagentHistories as any).mock.calls[1][0] as (prev: Record<string, unknown>) => Record<string, unknown>;
    expect(secondUpdater(initialState)).toBe(initialState);

    act(() => {
      window.onSubagentHistoryLoaded?.(JSON.stringify({
        ...firstPayload,
        messages: [{ type: 'assistant', content: [{ type: 'text', text: 'final result' }] }],
      }));
    });

    const thirdUpdater = (opts.setSubagentHistories as any).mock.calls[2][0] as (prev: Record<string, any>) => Record<string, any>;
    const updatedState = thirdUpdater(initialState);
    expect(updatedState).not.toBe(initialState);
    expect(updatedState['task-1'].messages[0].content[0].text).toBe('final result');
  });

  // ===== onStreamEnd idempotency (dual-path delivery) =====

  describe('onStreamEnd idempotency', () => {
    it('second onStreamEnd for same turn is ignored', () => {
      const opts = createOptions();
      // Simulate streaming state
      opts.streamingTurnIdRef.current = 5;
      opts.isStreamingRef.current = true;
      opts.streamingMessageIndexRef.current = 0;
      opts.turnIdCounterRef.current = 5;

      renderHook(() => useWindowCallbacks(opts));

      // Simulate onStreamStart to set up streaming state
      act(() => {
        window.onStreamStart!();
      });

      const turnId = opts.streamingTurnIdRef.current;

      // First onStreamEnd — should process
      act(() => {
        window.onStreamEnd!('10');
      });
      expect(window.__streamEndProcessedTurnId).toBe(turnId);

      // Record call count after first onStreamEnd
      const callsAfterFirstEnd = (opts.setStreamingActive as any).mock.calls.length;

      // Second onStreamEnd with same turn — should be no-op
      act(() => {
        window.onStreamEnd!('10');
      });

      // setStreamingActive should not have been called again (idempotency)
      expect((opts.setStreamingActive as any).mock.calls.length).toBe(callsAfterFirstEnd);
    });

    it('onStreamStart clears __streamEndProcessedTurnId for next turn', () => {
      const opts = createOptions();
      renderHook(() => useWindowCallbacks(opts));

      // Simulate a completed turn
      window.__streamEndProcessedTurnId = 3;

      // New turn starts
      act(() => {
        window.onStreamStart!();
      });

      expect(window.__streamEndProcessedTurnId).toBeUndefined();
    });
  });

  // ===== Interrupted tool_use cleanup on stream end =====
  describe('onStreamEnd marks unresolved tool_use as interrupted', () => {
    it('adds tool_use IDs without matching tool_result to __deniedToolIds', () => {
      // Setup: last assistant has 3 tool_use blocks, but the following user
      // message only carries the first one's tool_result. This mirrors the
      // <turn_aborted> scenario where Codex interrupted mid-batch.
      const assistantWithThreeTools: ClaudeMessage = {
        type: 'assistant',
        content: 'running batch',
        raw: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'bash', input: { command: 'echo a' } },
            { type: 'tool_use', id: 'tool-2', name: 'bash', input: { command: 'echo b' } },
            { type: 'tool_use', id: 'tool-3', name: 'bash', input: { command: 'echo c' } },
          ],
        } as never,
        timestamp: new Date().toISOString(),
      };
      const userWithOneResult: ClaudeMessage = {
        type: 'user',
        content: '',
        raw: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
        } as never,
        timestamp: new Date().toISOString(),
      };
      const { opts } = createOptsWithMessages([assistantWithThreeTools, userWithOneResult]);
      renderHook(() => useWindowCallbacks(opts));

      act(() => { window.onStreamStart!(); });
      act(() => { window.onStreamEnd!('5'); });

      expect(window.__deniedToolIds?.has('tool-1')).toBe(false);
      expect(window.__deniedToolIds?.has('tool-2')).toBe(true);
      expect(window.__deniedToolIds?.has('tool-3')).toBe(true);
    });

    it('does not pollute __deniedToolIds when every tool_use has a tool_result', () => {
      const assistant: ClaudeMessage = {
        type: 'assistant',
        content: '',
        raw: {
          content: [
            { type: 'tool_use', id: 'tool-x', name: 'bash', input: { command: 'ls' } },
          ],
        } as never,
        timestamp: new Date().toISOString(),
      };
      const user: ClaudeMessage = {
        type: 'user',
        content: '',
        raw: {
          content: [{ type: 'tool_result', tool_use_id: 'tool-x', content: 'done' }],
        } as never,
        timestamp: new Date().toISOString(),
      };
      const { opts } = createOptsWithMessages([assistant, user]);
      renderHook(() => useWindowCallbacks(opts));

      act(() => { window.onStreamStart!(); });
      act(() => { window.onStreamEnd!('5'); });

      expect(window.__deniedToolIds?.has('tool-x')).toBe(false);
    });

    it('REGRESSION: parallel tool_use with SEPARATE tool_result user messages are not falsely denied', () => {
      // Backend (ClaudeMessageHandler.handleToolResult) creates ONE user message
      // per tool_result — so 3 parallel tool_use produce 3 consecutive user
      // messages, each carrying a single tool_result. collectUnresolvedToolUseIds
      // 'lastTurn' only inspects messages[i+1]; if it does not look beyond the
      // first result message it will falsely flag tool-2 / tool-3 as interrupted.
      const assistant: ClaudeMessage = {
        type: 'assistant',
        content: 'running parallel batch',
        raw: {
          content: [
            { type: 'tool_use', id: 'tool-1', name: 'bash', input: { command: 'echo a' } },
            { type: 'tool_use', id: 'tool-2', name: 'bash', input: { command: 'echo b' } },
            { type: 'tool_use', id: 'tool-3', name: 'bash', input: { command: 'echo c' } },
          ],
        } as never,
        timestamp: new Date().toISOString(),
      };
      const resultFor = (id: string): ClaudeMessage => ({
        type: 'user',
        content: '',
        raw: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } as never,
        timestamp: new Date().toISOString(),
      });
      const { opts } = createOptsWithMessages([assistant, resultFor('tool-1'), resultFor('tool-2'), resultFor('tool-3')]);
      renderHook(() => useWindowCallbacks(opts));

      act(() => { window.onStreamStart!(); });
      act(() => { window.onStreamEnd!('5'); });

      expect(window.__deniedToolIds?.has('tool-1')).toBe(false);
      expect(window.__deniedToolIds?.has('tool-2')).toBe(false);
      expect(window.__deniedToolIds?.has('tool-3')).toBe(false);
    });

    it('historyLoadComplete scans ALL turns and marks orphan tool_use as denied', () => {
      // Simulates loading a Codex history with two aborted batches across
      // separate turns. The "lastTurn" heuristic used by onStreamEnd would
      // miss the first batch — historyLoadComplete must use scope='all'.
      const turnA: ClaudeMessage = {
        type: 'assistant',
        content: 'batch A',
        raw: {
          content: [
            { type: 'tool_use', id: 'A-1', name: 'bash', input: { command: 'a1' } },
            { type: 'tool_use', id: 'A-2', name: 'bash', input: { command: 'a2' } },
          ],
        } as never,
        timestamp: new Date().toISOString(),
      };
      const turnAResults: ClaudeMessage = {
        type: 'user',
        content: '',
        raw: { content: [{ type: 'tool_result', tool_use_id: 'A-1', content: 'ok' }] } as never,
        timestamp: new Date().toISOString(),
      };
      const turnB: ClaudeMessage = {
        type: 'assistant',
        content: 'batch B',
        raw: {
          content: [
            { type: 'tool_use', id: 'B-1', name: 'bash', input: { command: 'b1' } },
          ],
        } as never,
        timestamp: new Date().toISOString(),
      };
      // No tool_result for B-1 either.

      const buffer = { current: [turnA, turnAResults, turnB] as ClaudeMessage[] };
      const setMessages = vi.fn((value: ClaudeMessage[] | ((prev: ClaudeMessage[]) => ClaudeMessage[])) => {
        buffer.current = typeof value === 'function'
          ? (value as (prev: ClaudeMessage[]) => ClaudeMessage[])(buffer.current)
          : value;
      });
      const opts = createOptions({ setMessages: setMessages as never });
      renderHook(() => useWindowCallbacks(opts));

      act(() => { window.historyLoadComplete!(); });

      // A-1 is resolved (has tool_result), A-2 and B-1 are orphans from two turns
      expect(window.__deniedToolIds?.has('A-1')).toBe(false);
      expect(window.__deniedToolIds?.has('A-2')).toBe(true);
      expect(window.__deniedToolIds?.has('B-1')).toBe(true);
    });

    it('onStreamEnd only scans the LAST turn, leaving earlier-turn orphans alone', () => {
      // Design contract (NOT a bug): during a LIVE stream only the active turn can
      // have stragglers — every earlier turn already received its tool_results
      // before the next turn began. onStreamEnd therefore uses scope='lastTurn'
      // as a hot-path optimization (see streamingCallbacks.ts). This test pins
      // that behavior so a future "just switch it to 'all'" change is caught:
      // 'all' would re-scan the whole conversation on every normal turn end.
      // Multi-turn orphan cleanup is the job of historyLoadComplete (scope='all').
      const turnA: ClaudeMessage = {
        type: 'assistant',
        content: 'batch A',
        raw: {
          content: [
            { type: 'tool_use', id: 'old-A', name: 'bash', input: { command: 'a' } },
          ],
        } as never,
        timestamp: new Date().toISOString(),
      };
      // No tool_result for old-A — but it belongs to an earlier turn.
      const turnB: ClaudeMessage = {
        type: 'assistant',
        content: 'batch B',
        raw: {
          content: [
            { type: 'tool_use', id: 'last-B', name: 'bash', input: { command: 'b' } },
          ],
        } as never,
        timestamp: new Date().toISOString(),
      };
      const { opts } = createOptsWithMessages([turnA, turnB]);
      renderHook(() => useWindowCallbacks(opts));

      act(() => { window.onStreamStart!(); });
      act(() => { window.onStreamEnd!('5'); });

      // last-B (most recent turn) is flagged; old-A (earlier turn) is intentionally NOT.
      expect(window.__deniedToolIds?.has('last-B')).toBe(true);
      expect(window.__deniedToolIds?.has('old-A')).toBe(false);
    });

    // NOTE: The legacy `onPermissionDenied still marks unresolved tool_use`
    // test was removed. It asserted that onPermissionDenied works in isolation,
    // but the backend (ClaudeChatWindow.interruptDueToPermissionDenial) ALWAYS
    // calls onStreamEnd immediately after onPermissionDenied in the same EDT
    // block, so the isolated scenario never happens in production. The real
    // sequence is now covered by the integration test in the
    // "onPermissionDenied → onStreamEnd integration" describe block below.

    it('stale backend snapshot during streaming must not redirect streamingMessageIndexRef to prior-turn assistant', () => {
      stubSynchronousTimers();

      const assistant1: ClaudeMessage = {
        type: 'assistant',
        content: 'Using tool',
        timestamp: '2026-01-01T00:00:01Z',
        __turnId: 1,
        isStreaming: false,
        raw: {
          message: {
            content: [
              { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } },
              { type: 'text', text: 'Using tool' },
            ],
          },
        } as never,
      };
      const userToolResult: ClaudeMessage = {
        type: 'user', content: '', timestamp: '2026-01-01T00:00:02Z',
        raw: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } as never,
      };

      const initialMessages: ClaudeMessage[] = [
        { type: 'user', content: 'question', timestamp: '2026-01-01T00:00:00Z' },
        assistant1,
        userToolResult,
      ];

      const { opts, buffer } = createOptsWithMessages(initialMessages);
      // Simulate that turn 1 already completed
      opts.turnIdCounterRef.current = 1;

      renderHook(() => useWindowCallbacks(opts));

      // --- Turn 2: onStreamStart creates new assistant at the end ---
      act(() => { window.onStreamStart!(); });

      // Verify the updater appended the new assistant with __turnId=2
      expect(buffer.current.length).toBe(4);
      expect(buffer.current[3]).toMatchObject({
        type: 'assistant',
        isStreaming: true,
        __turnId: 2,
      });

      const correctStreamingIdx = opts.streamingMessageIndexRef.current;
      expect(correctStreamingIdx).toBe(3);

      // --- Stale backend snapshot arrives (still only has assistant1) ---
      const staleSnapshot = [
        { type: 'user', content: 'question', timestamp: '2026-01-01T00:00:00Z' },
        {
          type: 'assistant',
          content: 'Using tool',
          timestamp: '2026-01-01T00:00:01Z',
          __turnId: 1,
          raw: {
            message: {
              content: [
                { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } },
                { type: 'text', text: 'Using tool' },
              ],
            },
          },
        },
        { type: 'user', content: '', timestamp: '2026-01-01T00:00:02Z',
          raw: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      ];

      act(() => {
        window.updateMessages!(JSON.stringify(staleSnapshot));
      });

      // streamingMessageIndexRef must NOT be redirected to index 1 (assistant1)
      expect(opts.streamingMessageIndexRef.current).toBe(correctStreamingIdx);
    });

    it('guard branch: stale snapshot with equal length bypasses preserveLatestMessagesOnShrink and still preserves index', () => {
      stubSynchronousTimers();

      const assistant1: ClaudeMessage = {
        type: 'assistant',
        content: 'First reply',
        timestamp: '2026-01-01T00:00:01Z',
        __turnId: 1,
        isStreaming: false,
        raw: {
          message: {
            content: [{ type: 'text', text: 'First reply' }],
          },
        } as never,
      };

      const initialMessages: ClaudeMessage[] = [
        { type: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00Z' },
        assistant1,
      ];

      const { opts, buffer } = createOptsWithMessages(initialMessages);
      opts.turnIdCounterRef.current = 1;

      renderHook(() => useWindowCallbacks(opts));

      // --- Turn 2: onStreamStart creates new assistant at the end ---
      act(() => { window.onStreamStart!(); });

      expect(buffer.current.length).toBe(3);
      expect(buffer.current[2]).toMatchObject({
        type: 'assistant',
        isStreaming: true,
        __turnId: 2,
      });

      const correctStreamingIdx = opts.streamingMessageIndexRef.current;
      expect(correctStreamingIdx).toBe(2);

      // --- Stale backend snapshot with SAME length as prev (3 messages) ---
      // preserveLatestMessagesOnShrink sees patched.length(3) >= prev.length(3)
      // and returns early, so findLastAssistantIndex finds assistant1 (__turnId=1).
      // The guard must block the stale redirect.
      const staleSnapshot = [
        { type: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00Z' },
        {
          type: 'assistant',
          content: 'First reply',
          timestamp: '2026-01-01T00:00:01Z',
          __turnId: 1,
          raw: { message: { content: [{ type: 'text', text: 'First reply' }] } },
        },
        // Extra user message makes the snapshot length (3) >= prev length (3),
        // preventing preserveLatestMessagesOnShrink from re-appending the streaming assistant.
        { type: 'user', content: 'extra', timestamp: '2026-01-01T00:00:02Z' },
      ];

      act(() => {
        window.updateMessages!(JSON.stringify(staleSnapshot));
      });

      // streamingMessageIndexRef must NOT be redirected to index 1 (assistant1)
      expect(opts.streamingMessageIndexRef.current).not.toBe(1);
      // It must point to the correct streaming assistant (__turnId=2)
      const finalIdx = opts.streamingMessageIndexRef.current;
      expect(buffer.current[finalIdx]).toMatchObject({
        type: 'assistant',
        __turnId: 2,
      });
    });

    it('onBlockReset keeps streaming refs cumulative across turns (single assistant message)', () => {
      stubSynchronousTimers();

      const opts = createOptions();
      renderHook(() => useWindowCallbacks(opts));

      // Start streaming
      act(() => { window.onStreamStart!(); });
      expect(opts.isStreamingRef.current).toBe(true);

      // Simulate first turn's thinking + content deltas
      act(() => { window.onThinkingDelta!('Turn1Thinking'); });
      act(() => { window.onContentDelta!('Turn1Content'); });

      // Block reset signal arrives (a new assistant turn within the same
      // stream). The Java layer keeps ONE assistant message for the whole
      // turn and appends each turn's text/thinking as additional raw blocks,
      // so the frontend must keep accumulating to preserve the prefix earlier
      // turns contributed. Clearing here would break prefix reconciliation.
      act(() => { window.onBlockReset!(); });

      // Refs are intentionally retained, NOT cleared.
      expect(opts.streamingThinkingRef.current).toBe('Turn1Thinking');
      expect(opts.streamingContentRef.current).toBe('Turn1Content');
      expect(opts.isStreamingRef.current).toBe(true);

      // Second turn's deltas append to the cumulative buffer.
      act(() => { window.onThinkingDelta!('Turn2Thinking'); });
      expect(opts.streamingThinkingRef.current).toBe('Turn1ThinkingTurn2Thinking');

      act(() => { window.onContentDelta!('Turn2Content'); });
      expect(opts.streamingContentRef.current).toBe('Turn1ContentTurn2Content');

      // Cross-turn separation is enforced downstream by the sync functions'
      // trailing-block guard (see useStreamingMessages.test.ts: "does not
      // overwrite a finalized thinking block when the new turn's own block has
      // not arrived yet"), NOT by clearing the buffers here.
    });

    it('onBlockReset is ignored when stream is not active', () => {
      vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
      vi.stubGlobal('cancelAnimationFrame', vi.fn());

      const opts = createOptions();
      renderHook(() => useWindowCallbacks(opts));

      // Stream is NOT active
      expect(opts.isStreamingRef.current).toBe(false);

      // Pre-populate refs (simulating stale state)
      opts.streamingThinkingRef.current = 'StaleThinking';
      opts.streamingContentRef.current = 'StaleContent';

      // Block reset arrives when stream is not active
      act(() => { window.onBlockReset!(); });

      // Refs should NOT be cleared (stale signal ignored)
      expect(opts.streamingThinkingRef.current).toBe('StaleThinking');
      expect(opts.streamingContentRef.current).toBe('StaleContent');
    });
  });

  // ===== onStreamEnd preserves completed tool_result on rAF cancel (PR #1211) =====

  describe('onStreamEnd preserves pending tool_result (PR #1211)', () => {
    beforeEach(() => {
      delete (window as unknown as Record<string, unknown>).__pendingUpdateJson;
      window.__streamEndProcessedTurnId = undefined;
    });

    /** Drive onStreamEnd with a backend snapshot, then return its flush updater. */
    const runStreamEndAndGetUpdater = (
      opts: UseWindowCallbacksOptions,
      pendingSnapshot: unknown[],
    ): ((prev: ClaudeMessage[]) => ClaudeMessage[]) => {
      window.__pendingUpdateJson = JSON.stringify(pendingSnapshot);
      act(() => {
        window.onStreamEnd!('10');
      });
      delete (window as unknown as Record<string, unknown>).__pendingUpdateJson;
      return (opts.setMessages as any).mock.calls[0][0];
    };

    it('re-appends a tool_result dropped from the cancelled rAF snapshot', () => {
      const opts = createOptions({
        isStreamingRef: { current: true },
        streamingTurnIdRef: { current: 7 },
        streamingMessageIndexRef: { current: 0 },
      });
      renderHook(() => useWindowCallbacks(opts));

      const updater = runStreamEndAndGetUpdater(opts, [
        { type: 'assistant', content: 'running', raw: { message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash' }] } } },
        { type: 'user', content: '[tool_result]', raw: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'build ok' }] } },
      ]);

      // Live state lost the tool_result when the rAF was cancelled.
      const prev: ClaudeMessage[] = [
        {
          type: 'assistant',
          content: 'running',
          timestamp: '2026-05-25T10:00:00.000Z',
          raw: { message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash' }] } } as any,
        },
      ];
      const next = updater(prev);

      expect(next).not.toBe(prev);
      expect(next).toHaveLength(2);
      expect(next[1]).toMatchObject({ type: 'user', content: '[tool_result]' });
      expect((next[1].raw as any).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'tool-1' });
    });

    it('re-appends tool_result even when no streaming assistant exists to finalize (idx < 0)', () => {
      // Regression guard: the merge must NOT be gated on the assistant-patch branch.
      const opts = createOptions({
        isStreamingRef: { current: true },
        streamingTurnIdRef: { current: 8 },
        streamingMessageIndexRef: { current: -1 },
      });
      renderHook(() => useWindowCallbacks(opts));

      const updater = runStreamEndAndGetUpdater(opts, [
        { type: 'user', content: '[tool_result]', raw: { content: [{ type: 'tool_result', tool_use_id: 'tool-9', content: 'done' }] } },
      ]);

      const prev: ClaudeMessage[] = [
        {
          type: 'assistant',
          content: 'done',
          timestamp: '2026-05-25T10:00:00.000Z',
          raw: { message: { content: [{ type: 'tool_use', id: 'tool-9', name: 'Bash' }] } } as any,
        },
      ];
      const next = updater(prev);

      expect(next).not.toBe(prev);               // immutability preserved even on this path
      expect(next).toHaveLength(2);
      expect((next[1].raw as any).content[0].tool_use_id).toBe('tool-9');
    });

    it('does not duplicate a tool_result already present in the live state', () => {
      const opts = createOptions({
        isStreamingRef: { current: true },
        streamingTurnIdRef: { current: 9 },
        streamingMessageIndexRef: { current: 0 },
      });
      renderHook(() => useWindowCallbacks(opts));

      const updater = runStreamEndAndGetUpdater(opts, [
        { type: 'user', content: '[tool_result]', raw: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } },
      ]);

      const prev: ClaudeMessage[] = [
        { type: 'assistant', content: 'x', timestamp: '2026-05-25T10:00:00.000Z', raw: { message: { content: [{ type: 'tool_use', id: 'tool-1' }] } } as any },
        { type: 'user', content: '[tool_result]', timestamp: '2026-05-25T10:00:01.000Z', raw: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } as any },
      ];
      const next = updater(prev);

      expect(next.filter((m) => m.content === '[tool_result]')).toHaveLength(1);
    });

    it('stamps the recovered tool_result with an ISO timestamp, not String(Date.now())', () => {
      const opts = createOptions({
        isStreamingRef: { current: true },
        streamingTurnIdRef: { current: 11 },
        streamingMessageIndexRef: { current: 0 },
      });
      renderHook(() => useWindowCallbacks(opts));

      const updater = runStreamEndAndGetUpdater(opts, [
        { type: 'user', content: '[tool_result]', raw: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } },
      ]);

      const prev: ClaudeMessage[] = [
        { type: 'assistant', content: 'x', timestamp: '2026-05-25T10:00:00.000Z', raw: { message: { content: [{ type: 'tool_use', id: 'tool-1' }] } } as any },
      ];
      const next = updater(prev);

      const recovered = next.find((m) => m.content === '[tool_result]');
      expect(recovered).toBeDefined();
      expect(recovered!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(Number.isNaN(Date.parse(recovered!.timestamp as string))).toBe(false);
    });
  });

  // ===== Issue #1315 regression test: React 18 batching fix =====
  //
  // These tests exercise the production code path with a REAL setMessages mock that
  // applies the updater (via createOptsWithMessages), so the side effects inside the
  // updater — including the __deniedToolIds mutation that must live INSIDE the updater
  // under React 18 batching — are exercised exactly as they run in production.

  describe('onStreamEnd React 18 batching fix (Issue #1315)', () => {
    it('should not lose assistant message when interrupted tools exist', () => {
      // Initial state: streaming assistant with an unresolved tool_use.
      const initialMessages: ClaudeMessage[] = [
        {
          type: 'assistant',
          content: 'Running command...',
          isStreaming: true,
          timestamp: '2026-06-14T10:00:00.000Z',
          raw: {
            message: {
              content: [
                { type: 'text', text: 'Running command...' },
                { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
              ],
            },
          } as never,
        },
      ];

      const { opts, buffer } = createOptsWithMessages(initialMessages);
      opts.isStreamingRef.current = true;
      opts.streamingMessageIndexRef.current = 0;
      opts.streamingTurnIdRef.current = 10;
      opts.turnIdCounterRef.current = 10;

      renderHook(() => useWindowCallbacks(opts));

      // Simulate: pending snapshot has final content but no tool_result (interrupted).
      window.__pendingUpdateJson = JSON.stringify([
        {
          type: 'assistant',
          content: 'Running command... [interrupted]',
          raw: {
            message: {
              content: [
                { type: 'text', text: 'Running command... [interrupted]' },
                { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
              ],
            },
          },
        },
      ]);

      act(() => {
        window.onStreamEnd!('20');
      });

      // The buffer holds the state React would have committed.
      const result = buffer.current;

      // Verify: assistant message should be finalized, not lost.
      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('interrupted');
      expect(result[0].isStreaming).toBe(false);

      // Verify: interrupted tool should be marked as denied.
      expect(window.__deniedToolIds?.has('tool-1')).toBe(true);

      // Cleanup
      delete window.__pendingUpdateJson;
    });

    it('should handle tool_result recovery and interrupted tool detection together', () => {
      // Initial state: streaming assistant with two tool_use blocks.
      const initialMessages: ClaudeMessage[] = [
        {
          type: 'assistant',
          content: 'Running commands...',
          isStreaming: true,
          timestamp: '2026-06-14T10:00:00.000Z',
          raw: {
            message: {
              content: [
                { type: 'text', text: 'Running commands...' },
                { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
                { type: 'tool_use', id: 'tool-2', name: 'Read', input: { path: 'file.txt' } },
              ],
            },
          } as never,
        },
      ];

      const { opts, buffer } = createOptsWithMessages(initialMessages);
      opts.isStreamingRef.current = true;
      opts.streamingMessageIndexRef.current = 0;
      opts.streamingTurnIdRef.current = 11;
      opts.turnIdCounterRef.current = 11;

      renderHook(() => useWindowCallbacks(opts));

      // Simulate: pending snapshot has final content with one tool_result, one interrupted.
      window.__pendingUpdateJson = JSON.stringify([
        {
          type: 'assistant',
          content: 'Running commands... Done',
          raw: {
            message: {
              content: [
                { type: 'text', text: 'Running commands... Done' },
                { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
                { type: 'tool_use', id: 'tool-2', name: 'Read', input: { path: 'file.txt' } },
              ],
            },
          },
        },
        {
          type: 'user',
          content: '[tool_result]',
          raw: {
            content: [
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'file1.txt\nfile2.js' },
            ],
          },
        },
      ]);

      act(() => {
        window.onStreamEnd!('30');
      });

      const result = buffer.current;

      // Verify: should have assistant + tool_result.
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result[0].isStreaming).toBe(false);

      // Verify: tool_result should be recovered.
      const toolResult = result.find((m: ClaudeMessage) => m.content === '[tool_result]');
      expect(toolResult).toBeDefined();

      // Verify: only tool-2 should be marked as interrupted (tool-1 has a result).
      expect(window.__deniedToolIds?.has('tool-1')).toBe(false);
      expect(window.__deniedToolIds?.has('tool-2')).toBe(true);

      // Cleanup
      delete window.__pendingUpdateJson;
    });

    it('should not mark tools as interrupted when all have results', () => {
      // Initial state already carries the tool_result (the normal-completion path:
      // the SDK delivers results before onStreamEnd).  We do NOT set
      // __pendingUpdateJson here because onStreamStart() clears it.
      const initialMessages: ClaudeMessage[] = [
        {
          type: 'assistant',
          content: 'Running command...',
          isStreaming: true,
          timestamp: '2026-06-14T10:00:00.000Z',
          raw: {
            message: {
              content: [
                { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
              ],
            },
          } as never,
        },
        {
          type: 'user',
          content: '[tool_result]',
          timestamp: '2026-06-14T10:00:01.000Z',
          raw: {
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }],
          } as never,
        },
      ];

      const { opts } = createOptsWithMessages(initialMessages);
      opts.streamingTurnIdRef.current = 12;
      opts.turnIdCounterRef.current = 12;

      renderHook(() => useWindowCallbacks(opts));

      act(() => {
        window.onStreamStart!();
        window.onStreamEnd!('40');
      });

      // Verify: no tools should be marked as interrupted.
      expect(window.__deniedToolIds?.has('tool-1')).toBe(false);
    });
  });

  // ===== onPermissionDenied → onStreamEnd integration =====
  //
  // The backend (ClaudeChatWindow.interruptDueToPermissionDenial) ALWAYS calls
  // onStreamEnd immediately after onPermissionDenied in the same EDT block.
  // onPermissionDenied is therefore a no-op in production; the interrupted-tool
  // scan is owned by onStreamEnd's merged updater. These tests simulate the real
  // backend sequence so the scan coverage is preserved.

  describe('onPermissionDenied → onStreamEnd integration', () => {
    it('marks denied tool ids and finalizes assistant when backend calls the real sequence', () => {
      // Initial state: streaming assistant with an unresolved tool_use that will
      // be interrupted by the permission denial.
      const initialMessages: ClaudeMessage[] = [
        {
          type: 'assistant',
          content: 'About to run...',
          isStreaming: true,
          timestamp: '2026-06-14T11:00:00.000Z',
          raw: {
            message: {
              content: [
                { type: 'text', text: 'About to run...' },
                { type: 'tool_use', id: 'perm-1', name: 'Bash', input: { command: 'rm -rf /' } },
              ],
            },
          } as never,
        },
      ];

      const { opts, buffer } = createOptsWithMessages(initialMessages);
      opts.isStreamingRef.current = true;
      opts.streamingMessageIndexRef.current = 0;
      opts.streamingTurnIdRef.current = 20;
      opts.turnIdCounterRef.current = 20;

      renderHook(() => useWindowCallbacks(opts));

      // The pending snapshot carries the final (interrupted) assistant content.
      window.__pendingUpdateJson = JSON.stringify([
        {
          type: 'assistant',
          content: 'About to run... [denied]',
          raw: {
            message: {
              content: [
                { type: 'text', text: 'About to run... [denied]' },
                { type: 'tool_use', id: 'perm-1', name: 'Bash', input: { command: 'rm -rf /' } },
              ],
            },
          },
        },
      ]);

      // Simulate the real backend sequence: onPermissionDenied THEN onStreamEnd
      // in the same synchronous EDT block (same React batch).
      act(() => {
        window.onPermissionDenied!();
        window.onStreamEnd!('50');
      });

      const result = buffer.current;

      // The denied tool id must be marked (onStreamEnd's scan owns this now).
      expect(window.__deniedToolIds?.has('perm-1')).toBe(true);

      // The assistant message must be finalized (last-writer = onStreamEnd wins
      // the batch and preserves the merged content).
      expect(result).toHaveLength(1);
      expect(result[0].content).toContain('denied');
      expect(result[0].isStreaming).toBe(false);

      delete window.__pendingUpdateJson;
    });

    it('onPermissionDenied alone does NOT mutate __deniedToolIds (no-op contract)', () => {
      // Guards the no-op refactor: without the follow-up onStreamEnd, the scan
      // must not run. (This mirrors a hypothetical future caller that fires
      // onPermissionDenied in isolation; today the backend never does this.)
      const initialMessages: ClaudeMessage[] = [
        {
          type: 'assistant',
          content: '',
          isStreaming: true,
          timestamp: '2026-06-14T11:00:00.000Z',
          raw: {
            message: {
              content: [
                { type: 'tool_use', id: 'solo-1', name: 'Bash', input: { command: 'ls' } },
              ],
            },
          } as never,
        },
      ];

      const { opts } = createOptsWithMessages(initialMessages);
      opts.isStreamingRef.current = true;
      opts.streamingMessageIndexRef.current = 0;
      opts.streamingTurnIdRef.current = 21;
      opts.turnIdCounterRef.current = 21;

      renderHook(() => useWindowCallbacks(opts));

      act(() => {
        window.onPermissionDenied!();
      });

      // No scan ran — the id is NOT marked.
      expect(window.__deniedToolIds?.has('solo-1')).toBe(false);
      // And setMessages was not called by onPermissionDenied (no wasted render).
      expect((opts.setMessages as any)).not.toHaveBeenCalled();
    });
  });

  // ===== onStreamEnd index-guard __turnId fallback (residual risk A) =====
  //
  // When an interleaved updateMessages reorders/shrinks the message list so the
  // snapshot index no longer points at the streaming assistant, onStreamEnd must
  // fall back to a __turnId re-scan to avoid silently dropping the final content.

  describe('onStreamEnd index-guard __turnId fallback', () => {
    it('finalizes the assistant found via __turnId when the snapshot index is stale', () => {
      // Initial state: prev[0] is a user message (simulating a reordered list),
      // and the streaming assistant (__turnId=30) sits at index 1.
      const initialMessages: ClaudeMessage[] = [
        { type: 'user', content: 'reordered question', timestamp: '2026-06-14T12:00:00.000Z' },
        {
          type: 'assistant',
          content: 'partial stream',
          isStreaming: true,
          timestamp: '2026-06-14T12:00:01.000Z',
          __turnId: 30,
          raw: {
            message: {
              content: [
                { type: 'text', text: 'partial stream' },
                { type: 'tool_use', id: 'fallback-1', name: 'Bash', input: { command: 'ls' } },
              ],
            },
          } as never,
        },
      ];

      const { opts, buffer } = createOptsWithMessages(initialMessages);
      opts.isStreamingRef.current = true;
      // Snapshot index points at the user message (index 0) — stale/wrong.
      opts.streamingMessageIndexRef.current = 0;
      opts.streamingTurnIdRef.current = 30;
      opts.turnIdCounterRef.current = 30;

      renderHook(() => useWindowCallbacks(opts));

      // Pending snapshot carries the final assistant content.
      window.__pendingUpdateJson = JSON.stringify([
        {
          type: 'assistant',
          content: 'partial stream [final]',
          raw: {
            message: {
              content: [
                { type: 'text', text: 'partial stream [final]' },
                { type: 'tool_use', id: 'fallback-1', name: 'Bash', input: { command: 'ls' } },
              ],
            },
          },
        },
      ]);

      act(() => {
        window.onStreamEnd!('60');
      });

      const result = buffer.current;

      // The __turnId=30 assistant at index 1 must be finalized — NOT silently dropped.
      const finalized = result.find(
        (m) => m.type === 'assistant' && m.__turnId === 30,
      );
      expect(finalized).toBeDefined();
      expect(finalized!.content).toContain('final');
      expect(finalized!.isStreaming).toBe(false);

      // The interrupted tool is still flagged by the scan.
      expect(window.__deniedToolIds?.has('fallback-1')).toBe(true);

      delete window.__pendingUpdateJson;
    });

    it('does not throw and preserves state when neither index nor __turnId matches', () => {
      // Snapshot index invalid AND no assistant carries the ended __turnId.
      // onStreamEnd must degrade gracefully (same no-op behavior as today).
      const initialMessages: ClaudeMessage[] = [
        { type: 'user', content: 'orphan state', timestamp: '2026-06-14T12:30:00.000Z' },
      ];

      const { opts, buffer } = createOptsWithMessages(initialMessages);
      opts.isStreamingRef.current = true;
      opts.streamingMessageIndexRef.current = 5; // out of range
      opts.streamingTurnIdRef.current = 31;
      opts.turnIdCounterRef.current = 31;

      renderHook(() => useWindowCallbacks(opts));

      // No pending snapshot — nothing to recover.
      window.__pendingUpdateJson = JSON.stringify([]);

      expect(() => {
        act(() => {
          window.onStreamEnd!('70');
        });
      }).not.toThrow();

      // No assistant was finalized/added (nothing matched).
      expect(buffer.current.every((m) => m.type !== 'assistant')).toBe(true);

      delete window.__pendingUpdateJson;
    });
  });
});
