export type McpProvider = 'claude' | 'codex';

export function resolveInitialMcpProvider(
  currentProvider: string,
  savedProvider: string | null,
): McpProvider {
  if (savedProvider === 'claude' || savedProvider === 'codex') {
    return savedProvider;
  }
  return currentProvider === 'codex' ? 'codex' : 'claude';
}

export function getMcpMessagePrefix(provider: McpProvider): '' | 'codex_' {
  return provider === 'codex' ? 'codex_' : '';
}
