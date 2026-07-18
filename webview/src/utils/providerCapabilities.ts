export interface ProviderCapabilities {
  modelSelection: boolean;
  permissionModes: boolean;
  reasoningEffort: boolean;
  promptEnhancer: boolean;
  attachments: boolean;
  agents: boolean;
  runtimeProvider: boolean;
  streamingToggle: boolean;
  thinkingToggle: boolean;
  rewind: boolean;
  mcp: boolean;
  finalDiffApproval: boolean;
  runStatus: boolean;
}

const CLOSED_CAPABILITIES: ProviderCapabilities = {
  modelSelection: false,
  permissionModes: false,
  reasoningEffort: false,
  promptEnhancer: false,
  attachments: false,
  agents: false,
  runtimeProvider: false,
  streamingToggle: false,
  thinkingToggle: false,
  rewind: false,
  mcp: false,
  finalDiffApproval: false,
  runStatus: false,
};

const PROVIDER_CAPABILITIES: Record<string, ProviderCapabilities> = {
  claude: {
    modelSelection: true,
    permissionModes: true,
    reasoningEffort: true,
    promptEnhancer: true,
    attachments: true,
    agents: true,
    runtimeProvider: true,
    streamingToggle: true,
    thinkingToggle: true,
    rewind: true,
    mcp: true,
    finalDiffApproval: false,
    runStatus: false,
  },
  codex: {
    modelSelection: true,
    permissionModes: true,
    reasoningEffort: true,
    promptEnhancer: true,
    attachments: true,
    agents: true,
    runtimeProvider: true,
    streamingToggle: true,
    thinkingToggle: false,
    rewind: false,
    mcp: true,
    finalDiffApproval: false,
    runStatus: false,
  },
  ppcc: {
    ...CLOSED_CAPABILITIES,
    finalDiffApproval: true,
    runStatus: true,
  },
};

/** Unknown providers intentionally receive no capabilities. */
export function getProviderCapabilities(provider: string): ProviderCapabilities {
  return PROVIDER_CAPABILITIES[provider] ?? CLOSED_CAPABILITIES;
}
