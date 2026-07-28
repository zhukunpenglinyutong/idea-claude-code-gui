import { describe, expect, it } from 'vitest';
import { resolveIconVendor, resolveModelVendor } from './modelIconMapping';

describe('modelIconMapping', () => {
  it('keeps Codex Spark variants on the OpenAI icon', () => {
    expect(resolveModelVendor('gpt-5.3-codex-spark')).toBe('openai');
    expect(resolveIconVendor('codex', 'gpt-5.3-codex-spark')).toBe('openai');
  });

  it('still matches dedicated Spark vendor model ids', () => {
    expect(resolveModelVendor('spark-max')).toBe('spark');
    expect(resolveIconVendor(undefined, 'spark-lite')).toBe('spark');
  });

  it('resolves Xiaomi MiMo models before falling back to Claude provider icons', () => {
    expect(resolveModelVendor('mimo-v2.5-pro')).toBe('xiaomi');
    expect(resolveIconVendor('claude', 'mimo-v2.5-pro')).toBe('xiaomi');
    expect(resolveIconVendor('xiaomi')).toBe('xiaomi');
    expect(resolveIconVendor('xiaomi-plan')).toBe('xiaomi');
  });

  it('resolves expanded third-party provider preset icons', () => {
    expect(resolveIconVendor('kimi-coding')).toBe('kimi');
    expect(resolveIconVendor('bailian')).toBe('bailian');
    expect(resolveIconVendor('bailian-coding')).toBe('bailian');
    expect(resolveIconVendor('longcat')).toBe('longcat');
    expect(resolveIconVendor('opencode-go')).toBe('opencode');
  });
});
