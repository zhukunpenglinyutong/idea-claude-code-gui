import { describe, expect, it } from 'vitest';
import { resolveIconVendor, resolveModelVendor, resolveVendorFromBaseUrl } from './modelIconMapping';

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
    // Runtime CLI provider (ProviderSelect / BlinkingLogo), not only the go preset
    expect(resolveIconVendor('opencode')).toBe('opencode');
    // Runtime CLI provider — must not fall through to Claude default
    expect(resolveIconVendor('pi')).toBe('pi');
    expect(resolveIconVendor('agy')).toBe('gemini');
    expect(resolveIconVendor('omp')).toBe('omp');
  });

  it('resolves vendor from the provider base URL host', () => {
    expect(resolveVendorFromBaseUrl('https://open.bigmodel.cn/api/anthropic')).toBe('zhipu');
    expect(resolveVendorFromBaseUrl('https://api.moonshot.cn/anthropic')).toBe('kimi');
    expect(resolveVendorFromBaseUrl('https://api.deepseek.com/anthropic')).toBe('deepseek');
    expect(resolveVendorFromBaseUrl('https://dashscope.aliyuncs.com/apps/anthropic')).toBe('bailian');
    expect(resolveVendorFromBaseUrl('https://openrouter.ai/api')).toBe('openrouter');
    expect(resolveVendorFromBaseUrl('https://opencode.ai/zen/go')).toBe('opencode');
    expect(resolveVendorFromBaseUrl(undefined)).toBeNull();
    expect(resolveVendorFromBaseUrl('https://my-personal-proxy.example.com')).toBeNull();
  });

  it('treats the base URL as the strongest brand signal', () => {
    // OpenRouter serves a claude model, but the endpoint brand wins.
    expect(resolveIconVendor(undefined, 'anthropic/claude-fable-5', 'https://openrouter.ai/api')).toBe('openrouter');
    // OpenCode-Go serves a deepseek model, but the endpoint brand wins.
    expect(resolveIconVendor(undefined, 'deepseek-v4-flash', 'https://opencode.ai/zen/go')).toBe('opencode');
    // Bailian presets carry no model env, so only the base URL identifies them.
    expect(resolveIconVendor(undefined, undefined, 'https://dashscope.aliyuncs.com/apps/anthropic')).toBe('bailian');
    // An unrecognized base URL falls through to the model id.
    expect(resolveIconVendor(undefined, 'glm-5.2', 'https://my-proxy.example.com')).toBe('zhipu');
    // Existing two-arg callers keep their model > provider priority.
    expect(resolveIconVendor('claude', 'mimo-v2.5-pro')).toBe('xiaomi');
  });
});
