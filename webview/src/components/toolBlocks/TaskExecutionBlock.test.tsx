import { act, fireEvent, render } from '@testing-library/react';
import TaskExecutionBlock from './TaskExecutionBlock';

const mockSendBridgeEvent = vi.fn();
let mockHistories: Record<string, unknown> = {};
const mockUseSessionId = vi.fn<() => string | null>();
const mockGetToolResultRaw = vi.fn<(toolUseId: string) => Record<string, unknown> | null>();
const mockUseTaskEvent = vi.fn<(toolUseId: string | undefined) => unknown>();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => mockSendBridgeEvent(...args),
}));

vi.mock('../../contexts/SubagentContext', () => ({
  useSubagentHistories: () => mockHistories,
  useSessionId: () => mockUseSessionId(),
  useGetToolResultRaw: () => mockGetToolResultRaw,
  useTaskEvent: (toolUseId: string | undefined) => mockUseTaskEvent(toolUseId),
}));

describe('TaskExecutionBlock polling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockSendBridgeEvent.mockReset();
    mockGetToolResultRaw.mockReset();
    mockUseSessionId.mockReset();
    mockUseTaskEvent.mockReset();

    mockHistories = {};
    mockGetToolResultRaw.mockReturnValue(null);
    mockUseSessionId.mockReturnValue('session-1');
    mockUseTaskEvent.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('continues polling an unresolved agent after the main turn settles', () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');

    const { container } = render(
      <TaskExecutionBlock
        name="Agent"
        toolId="task-1"
        isStreaming={false}
        input={{
          description: 'Inspect render path',
          subagent_type: 'Explore',
          run_in_background: true,
        }}
      />,
    );

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    expect(setIntervalSpy).toHaveBeenCalled();
  });

  it('expands the task details when the header is clicked', () => {
    const { container } = render(
      <TaskExecutionBlock
        name="Task"
        toolId="task-1"
        input={{
          description: 'Inspect render path',
          subagent_type: 'Explore',
        }}
      />,
    );

    expect(container.querySelector('.task-details')).toBeNull();

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    expect(container.querySelector('.task-details')).toBeTruthy();
  });

  it('stops polling once a tool result marks the agent task completed', () => {
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

    const { container, rerender } = render(
      <TaskExecutionBlock
        name="Task"
        toolId="task-1"
        isStreaming={true}
        input={{
          description: 'Inspect render path',
          subagent_type: 'Explore',
        }}
      />,
    );

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(mockSendBridgeEvent).toHaveBeenCalledWith(
      'load_subagent_session',
      expect.stringContaining('"toolUseId":"task-1"'),
    );

    rerender(
      <TaskExecutionBlock
        name="Task"
        toolId="task-1"
        isStreaming={true}
        result={{ type: 'tool_result', tool_use_id: 'task-1', content: 'done' } as any}
        input={{
          description: 'Inspect render path',
          subagent_type: 'Explore',
        }}
      />,
    );

    expect(clearIntervalSpy).toHaveBeenCalled();

    mockSendBridgeEvent.mockClear();
    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(mockSendBridgeEvent).not.toHaveBeenCalled();
  });

  it('keeps an async agent pending until its task_notification lands', () => {
    mockUseTaskEvent.mockReturnValue(undefined);

    const { container } = render(
      <TaskExecutionBlock
        name="Agent"
        toolId="agent-async"
        isStreaming={true}
        input={{
          description: 'background research',
          subagent_type: 'research',
          run_in_background: true,
        } as any}
      />,
    );

    // Launch ack tool_result is present, but async agents must NOT flip to
    // completed on it alone.
    const indicator = container.querySelector('.tool-status-indicator');
    expect(indicator?.className).toContain('pending');
    expect(indicator?.className).not.toContain('completed');
  });

  it('keeps an unfinished async agent pending after history reload', () => {
    mockUseTaskEvent.mockReturnValue(undefined);
    mockHistories = { 'agent-async': { success: true, completed: false, messages: [] } };

    const { container } = render(
      <TaskExecutionBlock
        name="Agent"
        toolId="agent-async"
        isStreaming={false}
        input={{
          description: 'background research',
          subagent_type: 'research',
          run_in_background: true,
        } as any}
      />,
    );

    const indicator = container.querySelector('.tool-status-indicator');
    expect(indicator?.className).toContain('pending');
    expect(indicator?.className).not.toContain('completed');
  });

  it('marks an async agent completed when sidechain history ends normally', () => {
    mockUseTaskEvent.mockReturnValue(undefined);
    mockHistories = { 'agent-async': { success: true, completed: true, messages: [] } };

    const { container } = render(
      <TaskExecutionBlock
        name="Agent"
        toolId="agent-async"
        isStreaming={false}
        input={{
          description: 'background research',
          subagent_type: 'research',
          run_in_background: true,
        } as any}
      />,
    );

    const indicator = container.querySelector('.tool-status-indicator');
    expect(indicator?.className).toContain('completed');
    expect(indicator?.className).not.toContain('pending');
  });

  it('flips an async agent to completed when a task_notification arrives', () => {
    mockUseTaskEvent.mockReturnValue({
      toolUseId: 'agent-async',
      status: 'completed',
    } as any);

    const { container } = render(
      <TaskExecutionBlock
        name="Agent"
        toolId="agent-async"
        isStreaming={true}
        input={{
          description: 'background research',
          subagent_type: 'research',
          run_in_background: true,
        } as any}
      />,
    );

    const indicator = container.querySelector('.tool-status-indicator');
    expect(indicator?.className).toContain('completed');
  });

  it('shows the error indicator when a task_notification reports failure', () => {
    mockUseTaskEvent.mockReturnValue({
      toolUseId: 'agent-fail',
      status: 'failed',
    } as any);

    const { container } = render(
      <TaskExecutionBlock
        name="Agent"
        toolId="agent-fail"
        isStreaming={true}
        input={{
          description: 'background research',
          subagent_type: 'research',
          run_in_background: true,
        } as any}
      />,
    );

    const indicator = container.querySelector('.tool-status-indicator');
    expect(indicator?.className).toContain('error');
  });

  it('marks an async agent as errored when the launch tool_result reports is_error', () => {
    // A failed launch (validation error before the background task was
    // registered) returns an is_error tool_result and never emits a
    // task_notification - the card must show error, not stay "pending".
    mockUseTaskEvent.mockReturnValue(undefined);

    const { container } = render(
      <TaskExecutionBlock
        name="Agent"
        toolId="agent-launch-fail"
        isStreaming={true}
        result={{ type: 'tool_result', tool_use_id: 'agent-launch-fail', content: 'Agent Teams is not available', is_error: true } as any}
        input={{
          description: 'background research',
          subagent_type: 'research',
          run_in_background: true,
        } as any}
      />,
    );

    const indicator = container.querySelector('.tool-status-indicator');
    expect(indicator?.className).toContain('error');
    expect(indicator?.className).not.toContain('pending');
  });

  it('stops polling when an async agent fails', () => {
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

    // Start with no task_event: the card is pending and begins polling.
    mockUseTaskEvent.mockReturnValue(undefined);

    const { container, rerender } = render(
      <TaskExecutionBlock
        name="Agent"
        toolId="agent-poll-fail"
        isStreaming={true}
        input={{
          description: 'background research',
          subagent_type: 'research',
          run_in_background: true,
        } as any}
      />,
    );

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(mockSendBridgeEvent).toHaveBeenCalledWith(
      'load_subagent_session',
      expect.stringContaining('"toolUseId":"agent-poll-fail"'),
    );

    // A failure notification arrives - the card must stop polling.
    mockUseTaskEvent.mockReturnValue({
      toolUseId: 'agent-poll-fail',
      status: 'failed',
    } as any);

    rerender(
      <TaskExecutionBlock
        name="Agent"
        toolId="agent-poll-fail"
        isStreaming={true}
        input={{
          description: 'background research',
          subagent_type: 'research',
          run_in_background: true,
        } as any}
      />,
    );

    expect(clearIntervalSpy).toHaveBeenCalled();

    mockSendBridgeEvent.mockClear();
    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    expect(mockSendBridgeEvent).not.toHaveBeenCalled();
  });

  it('renders task_event usage in SubagentProcessDetails for a completed async agent', () => {
    mockUseTaskEvent.mockReturnValue({
      toolUseId: 'agent-usage',
      status: 'completed',
      totalTokens: 4200,
      totalToolUseCount: 7,
      totalDurationMs: 18000,
      summary: '调研完成',
    } as any);

    const { container } = render(
      <TaskExecutionBlock
        name="Agent"
        toolId="agent-usage"
        isStreaming={false}
        input={{
          description: 'background research',
          subagent_type: 'research',
          run_in_background: true,
        } as any}
      />,
    );

    fireEvent.click(container.querySelector('.task-header') as HTMLElement);

    const stats = container.querySelector('.subagent-process-stats');
    expect(stats).toBeTruthy();
    expect(stats?.textContent).toContain('7');
    expect(stats?.textContent).toContain('4,200');
    expect(container.querySelector('.subagent-result-card')?.textContent).toContain('调研完成');
  });

  it('parses spawn_agent meta (nickname, model, reasoning effort) from result text', () => {
    mockUseTaskEvent.mockReturnValue(undefined);
    mockGetToolResultRaw.mockReturnValue(null);

    const result = {
      type: 'tool_result',
      tool_use_id: 'spawn-1',
      content: '{"agent_id":"af5a83aa","nickname":"researcher","model":"claude-sonnet-4-6","reasoning_effort":"high"}',
    } as any;

    const { container } = render(
      <TaskExecutionBlock
        name="spawn_agent"
        toolId="spawn-1"
        result={result}
        input={{ prompt: 'do research' } as any}
      />,
    );

    const summaries = container.querySelectorAll('.tool-title-summary');
    const text = Array.from(summaries).map((el) => el.textContent).join(' ');
    expect(text).toContain('researcher');
    expect(text).toContain('claude-sonnet-4-6');
    expect(text).toContain('high');
  });
});
