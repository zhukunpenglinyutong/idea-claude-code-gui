import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  promptProvider,
  resetPromptsState,
  setupPromptsCallback,
} from './promptProvider';

describe('promptProvider provider isolation', () => {
  beforeEach(() => {
    resetPromptsState();
    window.sendToJava = vi.fn();
    setupPromptsCallback();
  });

  it('loads only prompts owned by the requested provider', async () => {
    const loading = promptProvider('', new AbortController().signal, 'codex');
    window.updateGlobalPrompts?.(JSON.stringify({
      provider: 'codex',
      prompts: [
        { id: 'codex-1', name: 'Codex prompt', content: 'codex', provider: 'codex' },
        { id: 'claude-1', name: 'Claude prompt', content: 'claude', provider: 'claude' },
      ],
    }));
    window.updateProjectPrompts?.(JSON.stringify({ provider: 'codex', prompts: [] }));

    const items = await loading;

    expect(items.map(item => item.id)).toContain('codex-1');
    expect(items.map(item => item.id)).not.toContain('claude-1');
  });

  it('ignores callbacks for a provider that is no longer active', async () => {
    window.updateGlobalPrompts?.(JSON.stringify({ provider: 'codex', prompts: [
      { id: 'codex-1', name: 'Codex prompt', content: 'codex', provider: 'codex' },
    ] }));
    await promptProvider('', new AbortController().signal, 'codex');

    await promptProvider('', new AbortController().signal, 'claude');
    window.updateGlobalPrompts?.(JSON.stringify({ provider: 'codex', prompts: [
      { id: 'codex-2', name: 'Stale Codex prompt', content: 'codex', provider: 'codex' },
    ] }));
    window.updateGlobalPrompts?.(JSON.stringify({ provider: 'claude', prompts: [
      { id: 'claude-1', name: 'Claude prompt', content: 'claude' },
    ] }));
    window.updateProjectPrompts?.(JSON.stringify({ provider: 'claude', prompts: [] }));

    const items = await promptProvider('', new AbortController().signal, 'claude');

    expect(items.map(item => item.id)).toContain('claude-1');
    expect(items.map(item => item.id)).not.toContain('codex-2');
  });
});
