import { describe, expect, it } from 'vitest';
import { hasEmptyToolsWarning } from './ServerCard';

describe('hasEmptyToolsWarning', () => {
  it('warns after a connected server finishes loading with no tools', () => {
    expect(hasEmptyToolsWarning('connected', {
      tools: [],
      loading: false,
    }, true)).toBe(true);
  });

  it('does not warn while loading, after failure, or when tools exist', () => {
    expect(hasEmptyToolsWarning('connected', {
      tools: [],
      loading: true,
    }, true)).toBe(false);
    expect(hasEmptyToolsWarning('connected', {
      tools: [],
      loading: false,
      error: 'tools/list failed',
    }, true)).toBe(false);
    expect(hasEmptyToolsWarning('connected', {
      tools: [{ name: 'codegraph_explore' }],
      loading: false,
    }, true)).toBe(false);
  });

  it('does not warn for disconnected or disabled servers', () => {
    expect(hasEmptyToolsWarning('failed', {
      tools: [],
      loading: false,
    }, true)).toBe(false);
    expect(hasEmptyToolsWarning('connected', {
      tools: [],
      loading: false,
    }, false)).toBe(false);
  });
});
