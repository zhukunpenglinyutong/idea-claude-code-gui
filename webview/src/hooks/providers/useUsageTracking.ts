import { useCallback, useState } from 'react';

export interface ClaudeLimitWindow {
  percent: number;
  resetsAt: string | null;
}

export interface CodexWindow {
  percent: number;
  resetsAt: string | null;
}

export interface UsageLimits {
  provider: 'claude' | 'codex';
  fiveHour?: ClaudeLimitWindow | null;
  sevenDay?: ClaudeLimitWindow | null;
  primaryWindow?: CodexWindow | null;
  secondaryWindow?: CodexWindow | null;
}

const PROVIDER_TO_SDK: Record<string, string> = {
  claude: 'claude-sdk',
  anthropic: 'claude-sdk',
  bedrock: 'claude-sdk',
  codex: 'codex-sdk',
  openai: 'codex-sdk',
};

type SdkStatus = Record<string, { installed?: boolean; status?: string }>;

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
  const [usageLimits, setUsageLimits] = useState<UsageLimits | null>(null);
  const [sdkStatus, setSdkStatus] = useState<SdkStatus>({});
  const [sdkStatusLoaded, setSdkStatusLoaded] = useState(false);

  const isSdkInstalled = useCallback(
    (providerId: string): boolean => {
      if (!sdkStatusLoaded) return false;
      const sdkId = PROVIDER_TO_SDK[providerId] || 'claude-sdk';
      const status = sdkStatus[sdkId];
      return status?.status === 'installed' || status?.installed === true;
    },
    [sdkStatusLoaded, sdkStatus],
  );

  return {
    usagePercentage,
    setUsagePercentage,
    usageUsedTokens,
    setUsageUsedTokens,
    usageMaxTokens,
    setUsageMaxTokens,
    usageLimits,
    setUsageLimits,
    sdkStatus,
    setSdkStatus,
    sdkStatusLoaded,
    setSdkStatusLoaded,
    isSdkInstalled,
  };
}

export type UseUsageTrackingReturn = ReturnType<typeof useUsageTracking>;
