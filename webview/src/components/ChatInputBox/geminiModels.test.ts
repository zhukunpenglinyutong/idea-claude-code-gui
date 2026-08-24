import { describe, expect, it } from 'vitest';
import {
  AVAILABLE_PROVIDERS,
  DEFAULT_GEMINI_MODEL_ID,
  GEMINI_MODELS,
  composeGeminiAgyModelId,
  splitGeminiAgyModelId,
  toGeminiFamilyId,
} from './types';

describe('Gemini provider catalog', () => {
  it('enables gemini in AVAILABLE_PROVIDERS', () => {
    const gemini = AVAILABLE_PROVIDERS.find((p) => p.id === 'gemini');
    expect(gemini).toBeDefined();
    expect(gemini?.enabled).toBe(true);
    expect(gemini?.beta).toBe(true);
  });

  it('lists family base ids including Claude/GPT via Antigravity', () => {
    expect(DEFAULT_GEMINI_MODEL_ID).toBe('gemini-3.5-flash');
    const ids = GEMINI_MODELS.map((m) => m.id);
    expect(ids).toContain(DEFAULT_GEMINI_MODEL_ID);
    expect(ids).toContain('gemini-3.6-flash');
    expect(ids).toContain('gemini-3.1-pro');
    expect(ids).toContain('claude-sonnet-4-6');
    expect(ids).toContain('claude-opus-4-6');
    expect(ids).toContain('gpt-oss-120b');
    expect(GEMINI_MODELS.every((m) => m.label && m.id)).toBe(true);
  });

  it('splits and composes agy effort suffixes', () => {
    expect(splitGeminiAgyModelId('gemini-3.5-flash-medium')).toEqual({
      baseId: 'gemini-3.5-flash',
      effort: 'medium',
    });
    expect(splitGeminiAgyModelId('claude-opus-4-6-thinking')).toEqual({
      baseId: 'claude-opus-4-6',
      effort: 'thinking',
    });
    expect(splitGeminiAgyModelId('claude-sonnet-4-6')).toEqual({
      baseId: 'claude-sonnet-4-6',
      effort: '',
    });
    expect(composeGeminiAgyModelId('gemini-3.5-flash', 'high')).toBe('gemini-3.5-flash-high');
    expect(composeGeminiAgyModelId('gemini-3.5-flash-medium', 'low')).toBe('gemini-3.5-flash-low');
    expect(toGeminiFamilyId('gpt-oss-120b-medium')).toBe('gpt-oss-120b');
  });
});
