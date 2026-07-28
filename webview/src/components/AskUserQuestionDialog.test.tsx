import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AskUserQuestionDialog, {
  type AskUserQuestionRequest,
} from './AskUserQuestionDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string, _vars?: Record<string, unknown>) =>
      typeof fallback === 'string' ? fallback : _key,
  }),
}));

const buildRequest = (overrides: Partial<AskUserQuestionRequest> = {}): AskUserQuestionRequest => ({
  requestId: 'req-test-1',
  toolName: 'AskUserQuestion',
  questions: [
    {
      question: 'Pick a color',
      header: 'Color',
      multiSelect: false,
      options: [
        { label: 'Red', description: '' },
        { label: 'Blue', description: '' },
      ],
    },
  ],
  ...overrides,
});

describe('AskUserQuestionDialog provider label', () => {
  it('identifies Codex request_user_input requests', () => {
    render(
      <AskUserQuestionDialog
        isOpen
        request={buildRequest({ toolName: 'request_user_input', provider: 'codex' })}
        onSubmit={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText('Codex 有一些问题想问你')).toBeTruthy();
  });
});

describe('AskUserQuestionDialog countdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Drain any pending timers/microtasks scheduled by the dialog's effects
    // before swapping back to real timers, otherwise leftover intervals can
    // bleed into the next test and produce phantom onCancel calls.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // The countdown is the user-visible deadline. When it hits zero the dialog must
  // call onCancel with the same requestId exactly once — duplicate cancels would
  // make the backend receive contradictory IPC, and a missed cancel would leak
  // the pending future on the Java side until the safety net fires (much later).

  it('auto-cancels with the original requestId after timeoutSeconds elapses', () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();
    const request = buildRequest();

    render(
      <AskUserQuestionDialog
        isOpen
        request={request}
        onSubmit={onSubmit}
        onCancel={onCancel}
        timeoutSeconds={30}
      />,
    );

    expect(onCancel).not.toHaveBeenCalled();

    // Advance 30s + a tick to make sure the final setInterval iteration and the
    // subsequent auto-close effect both flush.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith('req-test-1');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not fire auto-cancel before the deadline', () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();

    render(
      <AskUserQuestionDialog
        isOpen
        request={buildRequest()}
        onSubmit={onSubmit}
        onCancel={onCancel}
        timeoutSeconds={30}
      />,
    );

    // 29 seconds = one second short of expiry.
    act(() => {
      vi.advanceTimersByTime(29_000);
    });

    expect(onCancel).not.toHaveBeenCalled();
  });

  it('manual cancel suppresses the auto-cancel that would otherwise fire after timeout', () => {
    // This protects against a click+countdown race: if the user clicks cancel
    // and the timer also expires shortly after, the backend must not receive
    // two cancel messages.
    const onCancel = vi.fn();
    const onSubmit = vi.fn();

    render(
      <AskUserQuestionDialog
        isOpen
        request={buildRequest()}
        onSubmit={onSubmit}
        onCancel={onCancel}
        timeoutSeconds={30}
      />,
    );

    const cancelButton = screen.getByText('取消');
    fireEvent.click(cancelButton);
    expect(onCancel).toHaveBeenCalledTimes(1);

    // Run the timer well past the deadline; the duplicate-response guard should bail.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('invalid-format cancel suppresses the later auto-cancel', () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();

    render(
      <AskUserQuestionDialog
        isOpen
        request={buildRequest({ questions: [] })}
        onSubmit={onSubmit}
        onCancel={onCancel}
        timeoutSeconds={30}
      />,
    );

    fireEvent.click(screen.getByText('取消'));

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith('req-test-1');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submit suppresses the auto-cancel that would otherwise fire after timeout', () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();

    render(
      <AskUserQuestionDialog
        isOpen
        request={buildRequest()}
        onSubmit={onSubmit}
        onCancel={onCancel}
        timeoutSeconds={30}
      />,
    );

    // Pick an option then submit
    fireEvent.click(screen.getByText('Red'));
    fireEvent.click(screen.getByText('提交'));

    expect(onSubmit).toHaveBeenCalledTimes(1);

    // Now race the countdown past the deadline; the backend should not see a duplicate response.
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('keeps the original timeout when the prop changes mid-flight', () => {
    // The Java-side safety net is scheduled once when the dialog is created
    // and cannot be rescheduled. The frontend must not drift to a new timeout
    // while the dialog is already open, otherwise the backend could auto-reject
    // while the user still sees a running countdown.
    const onCancel = vi.fn();
    const onSubmit = vi.fn();

    const { rerender } = render(
      <AskUserQuestionDialog
        isOpen
        request={buildRequest()}
        onSubmit={onSubmit}
        onCancel={onCancel}
        timeoutSeconds={30}
      />,
    );

    // Simulate the user changing the setting while the dialog is visible.
    rerender(
      <AskUserQuestionDialog
        isOpen
        request={buildRequest()}
        onSubmit={onSubmit}
        onCancel={onCancel}
        timeoutSeconds={60}
      />,
    );

    // The dialog must continue using the original 30s timeout.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('AskUserQuestionDialog keyboard guards', () => {
  // Escape is a destructive shortcut (cancels the whole turn). When the user is
  // typing into the chat box or any other input on the page, an Escape there
  // (e.g. to close an IME suggestion popup) must not propagate to the dialog.
  it('ignores Escape when focus is on an INPUT element', () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();

    render(
      <AskUserQuestionDialog
        isOpen
        request={buildRequest()}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    try {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    } finally {
      input.remove();
    }

    expect(onCancel).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('still honors Escape when no editable element has focus', () => {
    const onCancel = vi.fn();
    const onSubmit = vi.fn();

    render(
      <AskUserQuestionDialog
        isOpen
        request={buildRequest()}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith('req-test-1');
  });
});
