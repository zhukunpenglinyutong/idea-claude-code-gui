import { describe, expect, it } from 'vitest';
import { getProviderCapabilities } from './providerCapabilities';

describe('PPCC provider capabilities', () => {
  it('exposes only the controls PPCC actually supports', () => {
    const capabilities = getProviderCapabilities('ppcc');

    expect(capabilities).toEqual({
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
      finalDiffApproval: true,
      runStatus: true,
    });
  });

  it('keeps existing Claude and Codex controls enabled', () => {
    expect(getProviderCapabilities('claude').modelSelection).toBe(true);
    expect(getProviderCapabilities('claude').permissionModes).toBe(true);
    expect(getProviderCapabilities('codex').reasoningEffort).toBe(true);
    expect(getProviderCapabilities('codex').attachments).toBe(true);
  });

  it('fails closed for an unknown provider', () => {
    const capabilities = getProviderCapabilities('unknown');
    expect(capabilities.modelSelection).toBe(false);
    expect(capabilities.promptEnhancer).toBe(false);
    expect(capabilities.finalDiffApproval).toBe(false);
  });
});
