import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexPetStatusBridge } from './CodexPetStatusBridge';
import { petBridge } from './petBridge';

describe('CodexPetStatusBridge', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reports completion before returning to idle', () => {
    vi.useFakeTimers();
    const updateState = vi.spyOn(petBridge, 'updateState').mockImplementation(() => {});
    const showBubble = vi.spyOn(petBridge, 'showBubble').mockImplementation(() => {});
    const { rerender } = render(
      <CodexPetStatusBridge
        active
        loading
        streamingActive={false}
        isThinking={false}
        status="running"
      />,
    );

    rerender(
      <CodexPetStatusBridge
        active
        loading={false}
        streamingActive={false}
        isThinking={false}
        status="ready"
      />,
    );

    expect(updateState.mock.calls.at(-1)?.[1]).toBe('success');
    expect(showBubble).toHaveBeenCalledWith(expect.objectContaining({ event: 'task_started' }));
    expect(showBubble).toHaveBeenCalledWith(expect.objectContaining({ event: 'task_success' }));
    act(() => vi.advanceTimersByTime(2400));
    expect(updateState.mock.calls.at(-1)?.[1]).toBe('idle');
  });

  it('includes the current turn duration in the completion bubble', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T12:00:00.000Z'));
    vi.spyOn(petBridge, 'updateState').mockImplementation(() => {});
    const showBubble = vi.spyOn(petBridge, 'showBubble').mockImplementation(() => {});
    const { rerender } = render(
      <CodexPetStatusBridge
        active
        loading
        streamingActive={false}
        isThinking={false}
        status="running"
      />,
    );

    act(() => vi.advanceTimersByTime(12_800));
    rerender(
      <CodexPetStatusBridge
        active
        loading={false}
        streamingActive={false}
        isThinking={false}
        status="ready"
      />,
    );

    expect(showBubble).toHaveBeenCalledWith(expect.objectContaining({
      event: 'task_success',
      durationMs: 12_800,
    }));
  });

  it('reports success when a completed turn leaves non-status failure text behind', () => {
    const updateState = vi.spyOn(petBridge, 'updateState').mockImplementation(() => {});
    const showBubble = vi.spyOn(petBridge, 'showBubble').mockImplementation(() => {});
    const { rerender } = render(
      <CodexPetStatusBridge
        active
        loading
        streamingActive={false}
        isThinking={false}
        status="running"
      />,
    );

    rerender(
      <CodexPetStatusBridge
        active
        loading={false}
        streamingActive={false}
        isThinking={false}
        status="all completed, previous command failed but recovered"
      />,
    );

    expect(updateState.mock.calls.at(-1)?.[1]).toBe('success');
    expect(showBubble).toHaveBeenCalledWith(expect.objectContaining({ event: 'task_success' }));
    expect(showBubble).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'task_error' }));
  });

  it('does not reuse an explicit error status left by the previous turn', () => {
    const updateState = vi.spyOn(petBridge, 'updateState').mockImplementation(() => {});
    const showBubble = vi.spyOn(petBridge, 'showBubble').mockImplementation(() => {});
    const { rerender } = render(
      <CodexPetStatusBridge
        active
        loading
        streamingActive={false}
        isThinking={false}
        status="Error: previous turn failed"
        errorCount={1}
      />,
    );

    rerender(
      <CodexPetStatusBridge
        active
        loading={false}
        streamingActive={false}
        isThinking={false}
        status="Error: previous turn failed"
        errorCount={1}
      />,
    );

    expect(updateState.mock.calls.at(-1)?.[1]).toBe('success');
    expect(showBubble).toHaveBeenCalledWith(expect.objectContaining({ event: 'task_success' }));
    expect(showBubble).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'task_error' }));
  });

  it('replaces a premature success when the current turn error arrives later', () => {
    vi.useFakeTimers();
    const updateState = vi.spyOn(petBridge, 'updateState').mockImplementation(() => {});
    const showBubble = vi.spyOn(petBridge, 'showBubble').mockImplementation(() => {});
    const { rerender } = render(
      <CodexPetStatusBridge
        active
        loading
        streamingActive={false}
        isThinking={false}
        status="running"
        errorCount={0}
      />,
    );

    rerender(
      <CodexPetStatusBridge
        active
        loading={false}
        streamingActive={false}
        isThinking={false}
        status="ready"
        errorCount={0}
      />,
    );
    expect(updateState.mock.calls.at(-1)?.[1]).toBe('success');

    rerender(
      <CodexPetStatusBridge
        active
        loading={false}
        streamingActive={false}
        isThinking={false}
        status="Error: current turn failed"
        errorCount={1}
      />,
    );

    expect(updateState.mock.calls.at(-1)?.[1]).toBe('error');
    expect(showBubble).toHaveBeenCalledWith(expect.objectContaining({ event: 'task_error' }));
  });

  it('ignores stale explicit error status when no live turn is active', () => {
    const updateState = vi.spyOn(petBridge, 'updateState').mockImplementation(() => {});
    const showBubble = vi.spyOn(petBridge, 'showBubble').mockImplementation(() => {});

    render(
      <CodexPetStatusBridge
        active
        loading={false}
        streamingActive={false}
        isThinking={false}
        status="Error: previous turn failed"
      />,
    );

    expect(updateState.mock.calls.at(-1)?.[1]).toBe('idle');
    expect(showBubble).not.toHaveBeenCalled();
  });

  it('reports error for the active live turn', () => {
    vi.useFakeTimers();
    const updateState = vi.spyOn(petBridge, 'updateState').mockImplementation(() => {});
    const showBubble = vi.spyOn(petBridge, 'showBubble').mockImplementation(() => {});
    const { rerender } = render(
      <CodexPetStatusBridge
        active
        loading
        streamingActive={false}
        isThinking={false}
        status="running"
      />,
    );

    rerender(
      <CodexPetStatusBridge
        active
        loading={false}
        streamingActive={false}
        isThinking={false}
        status="Error: crashed"
      />,
    );

    expect(updateState.mock.calls.at(-1)?.[1]).toBe('error');
    expect(showBubble).toHaveBeenCalledWith(expect.objectContaining({ event: 'task_error' }));
    act(() => vi.advanceTimersByTime(5600));
    expect(updateState.mock.calls.at(-1)?.[1]).toBe('idle');
  });

  it('keeps the error state for five animation loops when status text changes', () => {
    vi.useFakeTimers();
    const updateState = vi.spyOn(petBridge, 'updateState').mockImplementation(() => {});
    vi.spyOn(petBridge, 'showBubble').mockImplementation(() => {});
    const { rerender } = render(
      <CodexPetStatusBridge
        active
        loading
        streamingActive={false}
        isThinking={false}
        status="running"
      />,
    );

    rerender(
      <CodexPetStatusBridge
        active
        loading={false}
        streamingActive={false}
        isThinking={false}
        status="Error: crashed"
      />,
    );
    rerender(
      <CodexPetStatusBridge
        active
        loading={false}
        streamingActive={false}
        isThinking={false}
        status="ready"
      />,
    );

    expect(updateState.mock.calls.at(-1)?.[1]).toBe('error');
    act(() => vi.advanceTimersByTime(5599));
    expect(updateState.mock.calls.at(-1)?.[1]).toBe('error');
    act(() => vi.advanceTimersByTime(1));
    expect(updateState.mock.calls.at(-1)?.[1]).toBe('idle');
  });

  it('removes its source when Codex mode is inactive', () => {
    const updateState = vi.spyOn(petBridge, 'updateState').mockImplementation(() => {});
    const showBubble = vi.spyOn(petBridge, 'showBubble').mockImplementation(() => {});
    render(
      <CodexPetStatusBridge
        active={false}
        loading={false}
        streamingActive={false}
        isThinking={false}
        status="ready"
      />,
    );

    expect(updateState.mock.calls.at(-1)?.[1]).toBe('disposed');
    expect(showBubble).not.toHaveBeenCalled();
  });

  it('does not show completion bubble for initial idle state', () => {
    const updateState = vi.spyOn(petBridge, 'updateState').mockImplementation(() => {});
    const showBubble = vi.spyOn(petBridge, 'showBubble').mockImplementation(() => {});
    render(
      <CodexPetStatusBridge
        active
        loading={false}
        streamingActive={false}
        isThinking={false}
        status="ready"
      />,
    );

    expect(updateState.mock.calls.at(-1)?.[1]).toBe('idle');
    expect(showBubble).not.toHaveBeenCalled();
  });

  it('reports running before the start bubble when stale status text still says failed', () => {
    const updateState = vi.spyOn(petBridge, 'updateState').mockImplementation(() => {});
    const showBubble = vi.spyOn(petBridge, 'showBubble').mockImplementation(() => {});

    render(
      <CodexPetStatusBridge
        active
        loading
        streamingActive={false}
        isThinking={false}
        status="previous turn failed"
      />,
    );

    expect(updateState).toHaveBeenCalledWith(expect.any(String), 'running');
    expect(showBubble).toHaveBeenCalledWith(expect.objectContaining({ event: 'task_started' }));
    expect(updateState.mock.invocationCallOrder[0]).toBeLessThan(showBubble.mock.invocationCallOrder[0]);
  });

  it('marks bubble events from hidden documents as background', () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    vi.spyOn(petBridge, 'updateState').mockImplementation(() => {});
    const showBubble = vi.spyOn(petBridge, 'showBubble').mockImplementation(() => {});

    render(
      <CodexPetStatusBridge
        active
        loading
        streamingActive={false}
        isThinking={false}
        status="running"
      />,
    );

    expect(showBubble).toHaveBeenCalledWith(expect.objectContaining({
      event: 'task_started',
      background: true,
    }));
  });

  it('forwards the displayed session title to bubble templates', () => {
    vi.spyOn(petBridge, 'updateState').mockImplementation(() => {});
    const showBubble = vi.spyOn(petBridge, 'showBubble').mockImplementation(() => {});

    render(
      <CodexPetStatusBridge
        active
        loading
        streamingActive={false}
        isThinking={false}
        status="running"
        tabTitle="?????????"
      />,
    );

    expect(showBubble).toHaveBeenCalledWith(expect.objectContaining({
      event: 'task_started',
      tabTitle: '?????????',
    }));
  });

  it('refreshes active state quickly so selected tabs win stale background state', () => {
    vi.useFakeTimers();
    const updateState = vi.spyOn(petBridge, 'updateState').mockImplementation(() => {});

    render(
      <CodexPetStatusBridge
        active
        loading
        streamingActive={false}
        isThinking={false}
        status="running"
      />,
    );

    const initialCalls = updateState.mock.calls.length;
    act(() => vi.advanceTimersByTime(1000));
    expect(updateState.mock.calls.length).toBeGreaterThan(initialCalls);
    expect(updateState.mock.calls.at(-1)?.[1]).toBe('running');
  });
});
