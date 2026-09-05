import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ModelSelect } from './ModelSelect';
import { CLAUDE_MODELS, CODEX_MODELS } from '../types';
import type { ModelInfo } from '../types';
import { STORAGE_KEYS } from '../../../types/provider';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => options?.model ?? key,
  }),
}));

describe('ModelSelect', () => {
  const sonnetModel: ModelInfo = {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',
    description: 'Sonnet 4.6 · Use the default model',
  };

  beforeEach(() => {
    localStorage.clear();
  });

  it('rerender 后应读取最新的 Claude 模型映射', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ sonnet: 'glm-4' }),
    );

    const { rerender } = render(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="claude"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('glm-4');

    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ sonnet: 'glm-5' }),
    );

    rerender(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="claude"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('glm-5');
  });

  it('没有具体映射时应回退到全局 main 映射', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ main: 'glm-4.7', fable: 'glm-5.2' }),
    );

    render(
      <ModelSelect
        value="claude-fable-5"
        onChange={vi.fn()}
        models={[
          sonnetModel,
          { id: 'claude-fable-5', label: 'Fable 5', description: 'Fable 5 · Most powerful · Mythos-class' },
        ]}
        currentProvider="claude"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('glm-5.2');
  });

  it('Claude 内置模型列表应按目标顺序展示最新模型，并移除旧可见项', () => {
    expect(CLAUDE_MODELS.map((model) => model.id)).toEqual([
      'claude-fable-5',
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-sonnet-5',
      'claude-haiku-4-5',
    ]);
    const ids = CLAUDE_MODELS.map((model) => model.id);
    expect(ids).not.toContain('claude-opus-4-7');
    expect(ids).not.toContain('claude-opus-4-6');
    expect(ids).not.toContain('claude-sonnet-4-6');
    expect(ids).not.toContain('claude-sonnet-4-7');
    expect(ids.some((id) => id.endsWith('[1m]'))).toBe(false);
  });

  it('Codex 内置模型列表应与目标设计一致', () => {
    expect(CODEX_MODELS.map((model) => model.id)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.4',
    ]);
  });

  it('loading 时应显示加载状态', () => {
    render(
      <ModelSelect
        value="opencode-default"
        onChange={vi.fn()}
        models={[
          {
            id: 'opencode-default',
            label: 'OpenCode Default',
            description: 'Use OpenCode CLI default model',
          },
        ]}
        currentProvider="opencode"
        loading
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('model-loading')).toBeTruthy();
    expect(screen.getByText('chat.loadingDropdown')).toBeTruthy();
  });

  it('CodeBuddy 目录为空时仍显示占位模型，不应崩溃', () => {
    expect(() => render(
      <ModelSelect
        value=""
        onChange={vi.fn()}
        models={[]}
        currentProvider="codebuddy"
      />,
    )).not.toThrow();

    expect(screen.getByRole('button').textContent).toContain('models.selectModel');
  });

  it('error 时应显示失败状态并支持点击重试', () => {
    const onRetry = vi.fn();
    render(
      <ModelSelect
        value="auto"
        onChange={vi.fn()}
        models={[
          {
            id: 'auto',
            label: 'PI Auto',
            description: 'Use PI CLI default model',
          },
        ]}
        currentProvider="pi"
        error="pi --list-models failed"
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    const errorRow = screen.getByTestId('model-load-error');
    expect(errorRow).toBeTruthy();
    expect(screen.getByText('chat.modelsLoadFailed')).toBeTruthy();

    fireEvent.click(errorRow);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('loading 时不应同时显示 error 状态', () => {
    render(
      <ModelSelect
        value="auto"
        onChange={vi.fn()}
        models={[{ id: 'auto', label: 'PI Auto' }]}
        currentProvider="pi"
        loading
        error="timeout"
        onRetry={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('model-loading')).toBeTruthy();
    expect(screen.queryByTestId('model-load-error')).toBeNull();
  });

  const openCodeModels: ModelInfo[] = [
    { id: 'opencode/big-pickle', label: 'opencode/Big-Pickle', description: 'opencode/big-pickle' },
    { id: 'opencode/longcat-2.0-free', label: 'opencode/Longcat-2.0-Free', description: 'opencode/longcat-2.0-free' },
    { id: 'anthropic/claude-sonnet-4', label: 'anthropic/Claude-Sonnet-4', description: 'anthropic/claude-sonnet-4' },
    { id: 'deepseek/deepseek-v4-flash-free', label: 'deepseek/Deepseek-V4-Flash-Free', description: 'deepseek/deepseek-v4-flash-free' },
    { id: 'xiaomi/mimo-v2.5-free', label: 'xiaomi/Mimo-V2.5-Free', description: 'xiaomi/mimo-v2.5-free' },
    { id: 'laguna/laguna-s-2.1-free', label: 'laguna/Laguna-S-2.1-Free', description: 'laguna/laguna-s-2.1-free' },
    { id: 'ling/ling-3.0-tiny-free', label: 'ling/Ling-3.0-Tiny-Free', description: 'ling/ling-3.0-tiny-free' },
    { id: 'nvidia/nemotron-3-ultra-free', label: 'nvidia/Nemotron-3-Ultra-Free', description: 'nvidia/nemotron-3-ultra-free' },
  ];

  it('OpenCode 长列表应显示搜索并按 provider 分组', () => {
    render(
      <ModelSelect
        value="opencode/big-pickle"
        onChange={vi.fn()}
        models={openCodeModels}
        currentProvider="opencode"
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByTestId('model-search-input')).toBeTruthy();
    expect(screen.getByTestId('model-group-opencode')).toBeTruthy();
    expect(screen.getByTestId('model-group-anthropic')).toBeTruthy();
    expect(screen.getByTestId('model-group-deepseek')).toBeTruthy();
  });

  it('搜索应过滤模型并隐藏空分组', () => {
    render(
      <ModelSelect
        value="opencode/big-pickle"
        onChange={vi.fn()}
        models={openCodeModels}
        currentProvider="opencode"
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    fireEvent.change(screen.getByTestId('model-search-input'), {
      target: { value: 'deepseek' },
    });

    expect(screen.getByTestId('model-option-deepseek/deepseek-v4-flash-free')).toBeTruthy();
    expect(screen.queryByTestId('model-option-opencode/big-pickle')).toBeNull();
    // Empty vendor groups disappear; a single remaining match stays flat (no group header).
    expect(screen.queryByTestId('model-group-opencode')).toBeNull();
    expect(screen.queryByTestId('model-group-deepseek')).toBeNull();
  });

  it('置顶后模型应出现在 Pinned 分组顶部', () => {
    render(
      <ModelSelect
        value="opencode/big-pickle"
        onChange={vi.fn()}
        models={openCodeModels}
        currentProvider="opencode"
      />,
    );

    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByTestId('model-pin-deepseek/deepseek-v4-flash-free'));

    expect(screen.getByTestId('model-group-__pinned__')).toBeTruthy();
    const pinnedSection = screen.getByTestId('model-section-__pinned__');
    expect(pinnedSection.textContent).toContain('deepseek/Deepseek-V4-Flash-Free');
  });

  // Third-party catalogs expose models whose ids collide with the claude-*
  // mapping slots. Non-claude providers must render catalog labels verbatim.
  it('非 Claude 提供商应原样显示目录标签，不受 Claude 模型映射影响', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ sonnet: 'glm-4' }),
    );

    render(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="opencode"
      />,
    );

    expect(screen.getByRole('button').textContent).toContain('Sonnet 4.6');
    expect(screen.getByRole('button').textContent).not.toContain('glm-4');
  });

  it('同一模型 ID 切换到非 Claude 提供商后不应沿用 Claude 映射标签', () => {
    localStorage.setItem(
      STORAGE_KEYS.CLAUDE_MODEL_MAPPING,
      JSON.stringify({ sonnet: 'glm-4' }),
    );

    const { rerender } = render(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="claude"
      />,
    );
    expect(screen.getByRole('button').textContent).toContain('glm-4');

    rerender(
      <ModelSelect
        value={sonnetModel.id}
        onChange={vi.fn()}
        models={[sonnetModel]}
        currentProvider="opencode"
      />,
    );
    expect(screen.getByRole('button').textContent).toContain('Sonnet 4.6');
    expect(screen.getByRole('button').textContent).not.toContain('glm-4');
  });
});
