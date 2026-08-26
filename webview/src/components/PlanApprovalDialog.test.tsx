import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlanApprovalDialog, { type PlanApprovalRequest } from './PlanApprovalDialog';
import { resetLinkifyCapabilities, setLinkifyCapabilities } from '../utils/linkifyCapabilities';

vi.mock('../hooks/useDialogResize', () => ({
  useDialogResize: () => ({
    dialogRef: { current: null },
    dialogHeight: null,
    setDialogHeight: vi.fn(),
    handleResizeStart: vi.fn(),
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOptions?: unknown) => {
      if (typeof fallbackOrOptions === 'string') {
        return fallbackOrOptions;
      }
      return key;
    },
    i18n: { language: 'en' },
  }),
}));

describe('PlanApprovalDialog', () => {
  beforeEach(() => {
    resetLinkifyCapabilities();
    setLinkifyCapabilities({ classNavigationEnabled: true });
  });

  it('reuses MarkdownBlock linkify inside the dialog content', () => {
    const request: PlanApprovalRequest = {
      requestId: 'req-1',
      toolName: 'plan',
      plan: [
        'Review src/components/App.tsx',
        '',
        'Check com.github.claudecodegui.handler.file.OpenFileHandler',
        '',
        'Reference https://example.com/docs',
      ].join('\n'),
    };

    render(
      <PlanApprovalDialog
        isOpen
        request={request}
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );

    expect(screen.getByRole('link', { name: 'src/components/App.tsx' })).toBeTruthy();
    expect(
      screen.getByRole('link', {
        name: 'com.github.claudecodegui.handler.file.OpenFileHandler',
      }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'https://example.com/docs' })).toBeTruthy();
  });
});

describe('PlanApprovalDialog countdown', () => {
  const buildRequest = (overrides: Partial<PlanApprovalRequest> = {}): PlanApprovalRequest => ({
    requestId: 'plan-test-1',
    toolName: 'ExitPlanMode',
    plan: 'Simple plan body',
    ...overrides,
  });

  beforeEach(() => {
    resetLinkifyCapabilities();
    setLinkifyCapabilities({ classNavigationEnabled: true });
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Drain timers/effects before swapping back to real time, otherwise a
    // lingering setInterval would fire across the test boundary.
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // When the user does not respond, the dialog must auto-reject — leaving the
  // Java pending future hanging would block the agent until the safety-net
  // timeout (much later). Auto-reject mirrors what onCancel does for AskUser.

  it('auto-rejects with the original requestId after timeoutSeconds elapses', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();

    render(
      <PlanApprovalDialog
        isOpen
        request={buildRequest()}
        onApprove={onApprove}
        onReject={onReject}
        timeoutSeconds={30}
      />,
    );

    expect(onReject).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledWith('plan-test-1');
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('does not fire auto-reject before the deadline', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();

    render(
      <PlanApprovalDialog
        isOpen
        request={buildRequest()}
        onApprove={onApprove}
        onReject={onReject}
        timeoutSeconds={30}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(29_000);
    });

    expect(onReject).not.toHaveBeenCalled();
  });

  it('manual reject click suppresses a second auto-reject after timeout', () => {
    const onApprove = vi.fn();
    const onReject = vi.fn();

    render(
      <PlanApprovalDialog
        isOpen
        request={buildRequest()}
        onApprove={onApprove}
        onReject={onReject}
        timeoutSeconds={30}
      />,
    );

    // Use role + name to disambiguate the reject button from the "Esc 拒绝" keyboard hint, which
    // also contains the literal "拒绝".
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(onReject).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('keeps the original timeout when the prop changes mid-flight', () => {
    // The Java-side safety net is scheduled once when the dialog is created
    // and cannot be rescheduled. The frontend must not drift to a new timeout
    // while the dialog is already open, otherwise the backend could auto-reject
    // while the user still sees a running countdown.
    const onApprove = vi.fn();
    const onReject = vi.fn();

    const { rerender } = render(
      <PlanApprovalDialog
        isOpen
        request={buildRequest()}
        onApprove={onApprove}
        onReject={onReject}
        timeoutSeconds={30}
      />,
    );

    // User edits the timeout in Settings while the dialog is open.
    rerender(
      <PlanApprovalDialog
        isOpen
        request={buildRequest()}
        onApprove={onApprove}
        onReject={onReject}
        timeoutSeconds={60}
      />,
    );

    // The dialog must continue using the original 30s timeout.
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(onReject).toHaveBeenCalledTimes(1);
  });
});
