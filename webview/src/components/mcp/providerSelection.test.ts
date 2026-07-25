import { describe, expect, it } from 'vitest';
import { getMcpMessagePrefix, resolveInitialMcpProvider } from './providerSelection';

describe('MCP provider selection', () => {
  it('restores an explicit MCP tab independently from the chat provider', () => {
    expect(resolveInitialMcpProvider('claude', 'codex')).toBe('codex');
    expect(resolveInitialMcpProvider('codex', 'claude')).toBe('claude');
  });

  it('uses the current chat provider only when no tab was saved', () => {
    expect(resolveInitialMcpProvider('codex', null)).toBe('codex');
    expect(resolveInitialMcpProvider('unknown', null)).toBe('claude');
  });

  it('routes each provider tab to its own backend message family', () => {
    expect(getMcpMessagePrefix('claude')).toBe('');
    expect(getMcpMessagePrefix('codex')).toBe('codex_');
  });
});
