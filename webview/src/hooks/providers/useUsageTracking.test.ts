import { act, renderHook } from '@testing-library/react';
import { retryDependencyStatusRequest } from '../../utils/bridgeStartup';
import { useUsageTracking } from './useUsageTracking';

vi.mock('../../utils/bridgeStartup', () => ({
  DEPENDENCY_STATUS_REQUEST_STARTED_EVENT: 'ccg:dependency-status-request-started',
  retryDependencyStatusRequest: vi.fn(),
}));

describe('useUsageTracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails open after a status error and supports an explicit retry', () => {
    const { result } = renderHook(() => useUsageTracking());

    act(() => {
      result.current.setSdkStatusError('status unavailable');
    });

    expect(result.current.sdkStatusLoading).toBe(false);
    expect(result.current.isSdkInstalled('codex')).toBe(true);

    act(() => {
      result.current.retrySdkStatus();
    });

    expect(result.current.sdkStatusError).toBeNull();
    expect(result.current.sdkStatusLoading).toBe(true);
    expect(retryDependencyStatusRequest).toHaveBeenCalledTimes(1);
  });

  it('does not let a later query error override an explicit not-installed status', () => {
    const { result } = renderHook(() => useUsageTracking());

    act(() => {
      result.current.setSdkStatus({
        'codex-sdk': { status: 'not_installed', installed: false },
      });
      result.current.setSdkStatusLoaded(false);
      result.current.setSdkStatusError('status unavailable');
    });

    expect(result.current.isSdkStatusKnown('codex')).toBe(true);
    expect(result.current.isSdkInstalled('codex')).toBe(false);
  });

  it('gates CodeBuddy on its npm SDK even though it streams over the CLI protocol', () => {
    const { result } = renderHook(() => useUsageTracking());

    act(() => {
      result.current.setSdkStatus({
        'codebuddy-sdk': { status: 'not_installed', installed: false },
      });
      result.current.setSdkStatusLoaded(true);
    });

    // Unlike grok/kimi/dsh, CodeBuddy cannot run without @tencent-ai/agent-sdk.
    expect(result.current.isSdkStatusKnown('codebuddy')).toBe(true);
    expect(result.current.isSdkInstalled('codebuddy')).toBe(false);

    act(() => {
      result.current.setSdkStatus({
        'codebuddy-sdk': { status: 'installed', installed: true },
      });
    });

    expect(result.current.isSdkInstalled('codebuddy')).toBe(true);
  });
});
