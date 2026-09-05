import { useCallback, useEffect, useState } from 'react';
import {
  DEPENDENCY_STATUS_REQUEST_STARTED_EVENT,
  retryDependencyStatusRequest,
} from '../../utils/bridgeStartup';

import { CLI_ONLY_PROVIDERS } from './cliProviders';

const PROVIDER_TO_SDK: Record<string, string> = {
  claude: 'claude-sdk',
  anthropic: 'claude-sdk',
  bedrock: 'claude-sdk',
  codex: 'codex-sdk',
  openai: 'codex-sdk',
  // CodeBuddy streams over the CLI marker protocol but still requires the
  // npm Agent SDK (@tencent-ai/agent-sdk) — it must stay gated on SDK status.
  codebuddy: 'codebuddy-sdk',
  // CLI providers have no npm SDK — markers are only for lookups.
  grok: 'grok-cli',
  kimi: 'kimi-cli',
  minimax: 'minimax-cli',
  opencode: 'opencode-cli',
  pi: 'pi-cli',
  omp: 'omp-cli',
};

/** Providers that stream via the marker protocol yet need a bundled npm SDK. */
const SDK_GATED_CLI_PROVIDERS = new Set(['codebuddy']);

type SdkStatus = Record<string, {
  installed?: boolean;
  status?: string;
  installedVersion?: string;
  meetsMinimumVersion?: boolean;
  minimumVersion?: string;
}>;

/**
 * Usage % / token counters and SDK install status. `isSdkInstalled(providerId)`
 * is exposed as a stable callback for callers that need to gate UI on SDK
 * availability. The sdkStatusLoaded flag must be true before queries return
 * meaningful results.
 */
export function useUsageTracking() {
  const [usagePercentage, setUsagePercentage] = useState(0);
  const [usageUsedTokens, setUsageUsedTokens] = useState<number | undefined>(undefined);
  const [usageMaxTokens, setUsageMaxTokens] = useState<number | undefined>(undefined);
  const [sdkStatus, setSdkStatus] = useState<SdkStatus>({});
  const [sdkStatusLoaded, setSdkStatusLoaded] = useState(false);
  const [sdkStatusError, setSdkStatusError] = useState<string | null>(null);
  const sdkStatusLoading = !sdkStatusLoaded && sdkStatusError === null;

  useEffect(() => {
    const handleStatusRequestStarted = () => {
      setSdkStatusError(null);
      setSdkStatusLoaded(false);
    };
    window.addEventListener(DEPENDENCY_STATUS_REQUEST_STARTED_EVENT, handleStatusRequestStarted);
    return () => {
      window.removeEventListener(DEPENDENCY_STATUS_REQUEST_STARTED_EVENT, handleStatusRequestStarted);
    };
  }, []);

  const isSdkInstalled = useCallback(
    (providerId: string): boolean => {
      // Grok CLI is system-installed; do not gate on Claude/Codex SDK status.
      // SDK-backed CLI providers (CodeBuddy) still require the npm SDK.
      if (CLI_ONLY_PROVIDERS.has(providerId) && !SDK_GATED_CLI_PROVIDERS.has(providerId)) return true;
      const sdkId = PROVIDER_TO_SDK[providerId] || 'claude-sdk';
      const status = sdkStatus[sdkId];
      if (status?.status === 'installed' || status?.installed === true) return true;
      if (status?.status === 'not_installed' || status?.installed === false) return false;
      // A failed query means "unknown", not "not installed". Let chat proceed;
      // the backend will still report an actionable SDK startup error if needed.
      if (sdkStatusError !== null) return true;
      if (!sdkStatusLoaded) return false;
      return false;
    },
    [sdkStatusError, sdkStatusLoaded, sdkStatus],
  );

  const isSdkStatusKnown = useCallback((providerId: string): boolean => {
    if (CLI_ONLY_PROVIDERS.has(providerId) && !SDK_GATED_CLI_PROVIDERS.has(providerId)) return true;
    const sdkId = PROVIDER_TO_SDK[providerId] || 'claude-sdk';
    const status = sdkStatus[sdkId];
    return status?.status === 'installed'
      || status?.status === 'not_installed'
      || typeof status?.installed === 'boolean';
  }, [sdkStatus]);

  const retrySdkStatus = useCallback(() => {
    setSdkStatusError(null);
    setSdkStatusLoaded(false);
    retryDependencyStatusRequest();
  }, []);

  return {
    usagePercentage,
    setUsagePercentage,
    usageUsedTokens,
    setUsageUsedTokens,
    usageMaxTokens,
    setUsageMaxTokens,
    sdkStatus,
    setSdkStatus,
    sdkStatusLoaded,
    setSdkStatusLoaded,
    sdkStatusLoading,
    sdkStatusError,
    setSdkStatusError,
    retrySdkStatus,
    isSdkInstalled,
    isSdkStatusKnown,
  };
}

export type UseUsageTrackingReturn = ReturnType<typeof useUsageTracking>;
