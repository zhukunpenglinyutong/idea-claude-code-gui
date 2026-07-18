import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PpccApprovalDialog, { type PpccApprovalRequest } from './PpccApprovalDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallbackOrOptions?: unknown) =>
      typeof fallbackOrOptions === 'string' ? fallbackOrOptions : _key,
  }),
}));

const request: PpccApprovalRequest = {
  runId: 'run-1',
  approvalId: 'approval-1',
  diffSha256: 'abc123',
  expiresAt: Date.now() + 60_000,
  diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new',
};

describe('PpccApprovalDialog', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('renders the complete diff and returns all approval bindings', () => {
    const onApprove = vi.fn();
    render(<PpccApprovalDialog isOpen request={request} onApprove={onApprove} onReject={() => {}} />);

    expect(screen.getByText(/diff --git/).textContent).toContain('+new');
    expect(screen.getByText('abc123')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '批准变更' }));
    expect(onApprove).toHaveBeenCalledWith({
      runId: 'run-1',
      approvalId: 'approval-1',
      diffSha256: 'abc123',
    });
  });

  it('rejects with the same approval bindings', () => {
    const onReject = vi.fn();
    render(<PpccApprovalDialog isOpen request={request} onApprove={() => {}} onReject={onReject} />);

    fireEvent.click(screen.getByRole('button', { name: '拒绝并回滚' }));
    expect(onReject).toHaveBeenCalledWith({
      runId: 'run-1',
      approvalId: 'approval-1',
      diffSha256: 'abc123',
    });
  });

  it('fails closed when the approval expires', () => {
    vi.useFakeTimers();
    const onReject = vi.fn();
    const expiringRequest = { ...request, expiresAt: Date.now() + 1_000 };
    render(<PpccApprovalDialog isOpen request={expiringRequest} onApprove={() => {}} onReject={onReject} />);

    act(() => vi.advanceTimersByTime(1_000));
    expect(onReject).toHaveBeenCalledWith({
      runId: 'run-1',
      approvalId: 'approval-1',
      diffSha256: 'abc123',
    });
  });
});
