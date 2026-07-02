import { act, renderHook } from '@testing-library/react';
import { useDialogManagement } from './useDialogManagement';

const t = ((key: string) => key) as any;

// Regression coverage for issue #1360. When the Java safety-net timer fires, or
// a session switch calls clearPendingRequests, the backend force-closes the
// WebView dialogs. forceClose*(null) means "close every dialog of this kind" and
// MUST drain the entire pending queue — otherwise the active dialog is closed,
// the queue-draining effect immediately re-opens the next queued (and now stale)
// request, and a dialog from a previous session resurfaces in the new one.
describe('useDialogManagement - forceClose queue draining (issue #1360)', () => {
  const mkAsk = (requestId: string) => ({ requestId } as any);
  const mkPermission = (channelId: string) => ({ channelId } as any);
  const mkPlan = (requestId: string) => ({ requestId } as any);

  it('forceCloseAskUserQuestionDialog(null) drains the whole queue; no queued dialog resurfaces', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    // A becomes the active dialog, B is enqueued behind it.
    act(() => { result.current.openAskUserQuestionDialog(mkAsk('A')); });
    act(() => { result.current.openAskUserQuestionDialog(mkAsk('B')); });
    expect(result.current.askUserQuestionDialogOpen).toBe(true);
    expect(result.current.currentAskUserQuestionRequest?.requestId).toBe('A');

    act(() => { result.current.forceCloseAskUserQuestionDialog(null); });

    // The whole queue must be gone — B must NOT resurface after A is closed.
    expect(result.current.askUserQuestionDialogOpen).toBe(false);
    expect(result.current.currentAskUserQuestionRequest).toBeNull();
  });

  it('forceCloseAskUserQuestionDialog(id) closes the matching active dialog and lets the next queued one surface', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => { result.current.openAskUserQuestionDialog(mkAsk('A')); });
    act(() => { result.current.openAskUserQuestionDialog(mkAsk('B')); });

    act(() => { result.current.forceCloseAskUserQuestionDialog('A'); });

    // Only A was targeted, so the genuine follow-up B should open next.
    expect(result.current.askUserQuestionDialogOpen).toBe(true);
    expect(result.current.currentAskUserQuestionRequest?.requestId).toBe('B');
  });

  it('forceCloseAskUserQuestionDialog(id) for a queued-only id leaves the active dialog intact and prunes just that entry', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => { result.current.openAskUserQuestionDialog(mkAsk('A')); });
    act(() => { result.current.openAskUserQuestionDialog(mkAsk('B')); });

    // B is only queued (A is active); force-closing B must NOT touch A.
    act(() => { result.current.forceCloseAskUserQuestionDialog('B'); });
    expect(result.current.askUserQuestionDialogOpen).toBe(true);
    expect(result.current.currentAskUserQuestionRequest?.requestId).toBe('A');

    // Closing A now finds an empty queue (B was pruned) — nothing resurfaces.
    act(() => { result.current.forceCloseAskUserQuestionDialog('A'); });
    expect(result.current.askUserQuestionDialogOpen).toBe(false);
    expect(result.current.currentAskUserQuestionRequest).toBeNull();
  });

  it('forceClosePermissionDialog(null) drains the whole permission queue', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => { result.current.openPermissionDialog(mkPermission('A')); });
    act(() => { result.current.openPermissionDialog(mkPermission('B')); });
    expect(result.current.permissionDialogOpen).toBe(true);

    act(() => { result.current.forceClosePermissionDialog(null); });

    expect(result.current.permissionDialogOpen).toBe(false);
    expect(result.current.currentPermissionRequest).toBeNull();
  });

  it('forceClosePlanApprovalDialog(null) drains the whole plan-approval queue', () => {
    const { result } = renderHook(() => useDialogManagement({ t }));

    act(() => { result.current.openPlanApprovalDialog(mkPlan('A')); });
    act(() => { result.current.openPlanApprovalDialog(mkPlan('B')); });
    expect(result.current.planApprovalDialogOpen).toBe(true);

    act(() => { result.current.forceClosePlanApprovalDialog(null); });

    expect(result.current.planApprovalDialogOpen).toBe(false);
    expect(result.current.currentPlanApprovalRequest).toBeNull();
  });
});
