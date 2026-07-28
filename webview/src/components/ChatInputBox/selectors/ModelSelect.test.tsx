import { render, screen } from '@testing-library/react';
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
      'claude-sonnet-4-7',
      'claude-haiku-4-5',
    ]);
    const ids = CLAUDE_MODELS.map((model) => model.id);
    expect(ids).not.toContain('claude-opus-4-7');
    expect(ids).not.toContain('claude-opus-4-6');
    expect(ids).not.toContain('claude-sonnet-4-6');
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
});
