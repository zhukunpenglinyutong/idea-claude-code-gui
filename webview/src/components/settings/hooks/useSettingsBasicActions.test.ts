import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useSettingsBasicActions } from './useSettingsBasicActions';
import type { CommitAiConfig } from '../../../types/aiFeatureConfig';
import type { CodeFontConfig } from '../../../types/uiFontConfig';

describe('useSettingsBasicActions', () => {
  const defaultCommitAiConfig: CommitAiConfig = {
    provider: null,
    effectiveProvider: 'codex',
    resolutionSource: 'auto',
    models: {
      claude: 'claude-sonnet-4-6',
      codex: 'gpt-5.5',
    },
    availability: {
      claude: true,
      codex: true,
    },
  };

  beforeEach(() => {
    window.sendToJava = vi.fn();
  });

  it('updates commit AI provider without mutating prompt enhancer state', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    act(() => {
      result.current.setCommitAiConfig(defaultCommitAiConfig);
    });

    const promptEnhancerBefore = result.current.promptEnhancerConfig;

    act(() => {
      result.current.handleCommitAiProviderChange('claude');
    });

    expect(result.current.commitAiConfig.provider).toBe('claude');
    expect(result.current.promptEnhancerConfig).toEqual(promptEnhancerBefore);
    expect(window.sendToJava).toHaveBeenCalledWith(
      'set_commit_ai_config:{"provider":"claude","models":{"claude":"claude-sonnet-4-6","codex":"gpt-5.5"}}'
    );
  });

  it('updates commit AI model without mutating prompt enhancer models', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    act(() => {
      result.current.setCommitAiConfig({
        ...defaultCommitAiConfig,
        provider: 'codex',
        effectiveProvider: 'codex',
        resolutionSource: 'manual',
      });
    });

    const promptEnhancerBefore = result.current.promptEnhancerConfig;

    act(() => {
      result.current.handleCommitAiModelChange('gpt-5.4');
    });

    expect(result.current.commitAiConfig.models.codex).toBe('gpt-5.4');
    expect(result.current.promptEnhancerConfig).toEqual(promptEnhancerBefore);
    expect(window.sendToJava).toHaveBeenCalledWith(
      'set_commit_ai_config:{"provider":"codex","models":{"claude":"claude-sonnet-4-6","codex":"gpt-5.4"}}'
    );
  });

  it('sends independent code font updates without mutating ui font state', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    act(() => {
      result.current.handleCodeFontSelectionChange('followEditor');
    });

    expect(window.sendToJava).not.toHaveBeenCalledWith(
      'set_ui_font_config:{"mode":"customFile"}'
    );
    expect(window.sendToJava).toHaveBeenCalledWith(
      'set_code_font_config:{"mode":"followEditor"}'
    );
  });

  it('sends a code font customFile update when a saved path exists', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    const customCodeFontConfig: CodeFontConfig = {
      mode: 'customFile',
      effectiveMode: 'customFile',
      customFontPath: '/tmp/my-code-font.ttf',
      fontFamily: 'CC GUI Code Custom',
      fontSize: 13,
      lineSpacing: 1,
    };

    act(() => {
      result.current.setCodeFontConfig(customCodeFontConfig);
    });

    act(() => {
      result.current.handleCodeFontSelectionChange('customFile');
    });

    expect(window.sendToJava).toHaveBeenCalledWith(
      'set_code_font_config:{"mode":"customFile","customFontPath":"/tmp/my-code-font.ttf"}'
    );
  });

  it('does not send anything when switching to customFile without a saved path (silent no-op)', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    act(() => {
      result.current.handleCodeFontSelectionChange('customFile');
    });

    expect(window.sendToJava).not.toHaveBeenCalled();
  });

  it('sends CoDriver tool icon preference changes to Java', () => {
    const { result } = renderHook(() => useSettingsBasicActions({}));

    act(() => {
      result.current.handleCoDriverToolIconEnabledChange(false);
    });

    expect(result.current.coDriverToolIconEnabled).toBe(false);
    expect(window.sendToJava).toHaveBeenCalledWith(
      'set_codriver_tool_icon_enabled:{"codriverToolIconEnabled":false}'
    );
  });
});
