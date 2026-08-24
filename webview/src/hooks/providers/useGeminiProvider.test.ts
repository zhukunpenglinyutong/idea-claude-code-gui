import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGeminiProvider } from './useGeminiProvider';

const sendBridgeEventMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/bridge', () => ({
  sendBridgeEvent: (...args: unknown[]) => sendBridgeEventMock(...args),
}));

// Flat `agy models` fixture (real catalog, 2026-08-24): gemini families ship
// effort tiers, opus only exists as -thinking, sonnet only as a bare slug,
// gpt-oss only as -medium.
const AGY_CATALOG = {
  success: true,
  models: [
    { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)' },
    { id: 'gemini-3.7-flash-medium', label: 'Gemini 3.7 Flash (Medium)' },
    { id: 'gemini-3.7-flash-low', label: 'Gemini 3.7 Flash (Low)' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
    { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
    { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
  ],
};

describe('useGeminiProvider resolveDefaultEffortForFamily', () => {
  beforeEach(() => {
    sendBridgeEventMock.mockClear();
  });

  it('falls back per family shape when the catalog is not loaded', () => {
    const { result } = renderHook(() => useGeminiProvider());
    expect(result.current.resolveDefaultEffortForFamily('gemini-3.1-pro')).toBe('high');
    expect(result.current.resolveDefaultEffortForFamily('gpt-oss-120b')).toBe('medium');
    // Claude-style bare ids must stay unsuffixed: agy rejects
    // claude-sonnet-4-6-high ("not recognized as a known model").
    expect(result.current.resolveDefaultEffortForFamily('claude-sonnet-4-6')).toBe('');
  });

  it('unknown claude family composes the bare slug, never an invented tier', () => {
    const { result } = renderHook(() => useGeminiProvider());
    const effort = result.current.resolveDefaultEffortForFamily('claude-sonnet-4-6');
    expect(
      result.current.resolveGeminiAgyModelId('claude-sonnet-4-6', effort),
    ).toBe('claude-sonnet-4-6');
  });

  it('honors the loaded catalog: bare sonnet default, thinking opus default', () => {
    const { result } = renderHook(() => useGeminiProvider());
    act(() => {
      result.current.applyGeminiCatalog(AGY_CATALOG);
    });
    expect(result.current.resolveDefaultEffortForFamily('claude-sonnet-4-6')).toBe('');
    expect(result.current.resolveDefaultEffortForFamily('claude-opus-4-6')).toBe('thinking');
    expect(result.current.resolveDefaultEffortForFamily('gemini-3.7-flash')).toBe('medium');
    expect(
      result.current.resolveGeminiAgyModelId('claude-sonnet-4-6', ''),
    ).toBe('claude-sonnet-4-6');
  });
});
