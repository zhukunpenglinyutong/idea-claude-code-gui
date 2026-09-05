import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import CustomModelDialog from './index';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}));

describe('CustomModelDialog', () => {
  it('adds a custom model with optional context window and pricing', () => {
    const onModelsChange = vi.fn();

    render(
      <CustomModelDialog
        isOpen
        models={[]}
        onModelsChange={onModelsChange}
        onClose={vi.fn()}
        contextWindowEnabled
        initialAddMode
      />,
    );

    fireEvent.change(screen.getByLabelText('settings.codexProvider.dialog.modelIdPlaceholder'), {
      target: { value: 'vendor/custom-model' },
    });
    fireEvent.change(screen.getByLabelText('settings.codexProvider.dialog.modelLabelPlaceholder'), {
      target: { value: 'Custom Model' },
    });
    fireEvent.change(screen.getByLabelText('settings.pluginModels.contextWindow.label'), {
      target: { value: '500' },
    });
    // Pricing is collapsed by default — expand it to enter rates.
    fireEvent.click(screen.getByRole('button', { name: /settings\.pluginModels\.pricing\.title/ }));
    fireEvent.change(screen.getByLabelText('settings.pluginModels.pricing.inputLabel'), {
      target: { value: '0.2' },
    });
    fireEvent.change(screen.getByLabelText('settings.pluginModels.pricing.outputLabel'), {
      target: { value: '0.8' },
    });
    fireEvent.change(screen.getByLabelText('settings.pluginModels.pricing.cacheReadLabel'), {
      target: { value: '0.02' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'common.add' }));

    expect(onModelsChange).toHaveBeenCalledWith([
      {
        id: 'vendor/custom-model',
        label: 'Custom Model',
        description: undefined,
        contextWindowTokens: 500000,
        pricing: {
          inputCostPer1M: 0.2,
          outputCostPer1M: 0.8,
          cacheReadCostPer1M: 0.02,
        },
      },
    ]);
  });

  it('omits the context window when the field is blank', () => {
    const onModelsChange = vi.fn();

    render(
      <CustomModelDialog
        isOpen
        models={[]}
        onModelsChange={onModelsChange}
        onClose={vi.fn()}
        contextWindowEnabled
        initialAddMode
      />,
    );

    fireEvent.change(screen.getByLabelText('settings.codexProvider.dialog.modelIdPlaceholder'), {
      target: { value: 'vendor/default-context' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.add' }));

    expect(onModelsChange).toHaveBeenCalledWith([{
      id: 'vendor/default-context',
      label: 'vendor/default-context',
      description: undefined,
    }]);
  });

  it('rejects fractional K input', () => {
    const onModelsChange = vi.fn();

    render(
      <CustomModelDialog
        isOpen
        models={[]}
        onModelsChange={onModelsChange}
        onClose={vi.fn()}
        contextWindowEnabled
        initialAddMode
      />,
    );

    fireEvent.change(screen.getByLabelText('settings.codexProvider.dialog.modelIdPlaceholder'), {
      target: { value: 'vendor/decimal-context' },
    });
    fireEvent.change(screen.getByLabelText('settings.pluginModels.contextWindow.label'), {
      target: { value: '500.5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.add' }));

    expect(onModelsChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Maximum context must be a positive integer in K units');
  });

  it('blocks saving when the context window is not a valid positive K value', () => {
    const onModelsChange = vi.fn();

    render(
      <CustomModelDialog
        isOpen
        models={[]}
        onModelsChange={onModelsChange}
        onClose={vi.fn()}
        contextWindowEnabled
        initialAddMode
      />,
    );

    fireEvent.change(screen.getByLabelText('settings.codexProvider.dialog.modelIdPlaceholder'), {
      target: { value: 'vendor/invalid-context' },
    });
    fireEvent.change(screen.getByLabelText('settings.pluginModels.contextWindow.label'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.add' }));

    expect(onModelsChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Maximum context must be a positive integer in K units');
  });

  it('uses whole-K input constraints only when Codex context configuration is enabled', () => {
    const { rerender } = render(
      <CustomModelDialog
        isOpen
        models={[]}
        onModelsChange={vi.fn()}
        onClose={vi.fn()}
        initialAddMode
      />,
    );

    expect(screen.queryByLabelText('settings.pluginModels.contextWindow.label')).toBeNull();

    rerender(
      <CustomModelDialog
        isOpen
        models={[]}
        onModelsChange={vi.fn()}
        onClose={vi.fn()}
        contextWindowEnabled
        initialAddMode
      />,
    );

    const contextInput = screen.getByLabelText('settings.pluginModels.contextWindow.label') as HTMLInputElement;
    expect(contextInput.min).toBe('1');
    expect(contextInput.step).toBe('1');
    expect(contextInput.inputMode).toBe('numeric');
  });

  it('clears a previously configured context window', () => {
    const onModelsChange = vi.fn();

    render(
      <CustomModelDialog
        isOpen
        models={[{
          id: 'vendor/context-model',
          label: 'Context Model',
          contextWindowTokens: 500_000,
        }]}
        onModelsChange={onModelsChange}
        onClose={vi.fn()}
        contextWindowEnabled
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'common.edit vendor/context-model' }));
    const contextInput = screen.getByLabelText('settings.pluginModels.contextWindow.label') as HTMLInputElement;
    expect(contextInput.value).toBe('500');

    fireEvent.change(contextInput, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    expect(onModelsChange).toHaveBeenCalledWith([{
      id: 'vendor/context-model',
      label: 'Context Model',
      description: undefined,
    }]);
  });

  it('blocks saving when a pricing field is negative', () => {
    const onModelsChange = vi.fn();

    render(
      <CustomModelDialog
        isOpen
        models={[]}
        onModelsChange={onModelsChange}
        onClose={vi.fn()}
        initialAddMode
      />,
    );

    fireEvent.change(screen.getByLabelText('settings.codexProvider.dialog.modelIdPlaceholder'), {
      target: { value: 'vendor/custom-model' },
    });
    // Pricing is collapsed by default — expand it to enter the invalid value.
    fireEvent.click(screen.getByRole('button', { name: /settings\.pluginModels\.pricing\.title/ }));
    fireEvent.change(screen.getByLabelText('settings.pluginModels.pricing.inputLabel'), {
      target: { value: '-1' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'common.add' }));

    expect(onModelsChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Pricing must be a non-negative number');
  });

  it('keeps the optional pricing section collapsed by default and expands on click', () => {
    render(
      <CustomModelDialog
        isOpen
        models={[]}
        onModelsChange={vi.fn()}
        onClose={vi.fn()}
        initialAddMode
      />,
    );

    const toggle = screen.getByRole('button', { name: /settings\.pluginModels\.pricing\.title/ });
    // Pricing inputs are hidden until the section is expanded.
    expect(screen.queryByLabelText('settings.pluginModels.pricing.inputLabel')).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByLabelText('settings.pluginModels.pricing.inputLabel')).toBeTruthy();

    // Collapsing again hides the inputs.
    fireEvent.click(toggle);
    expect(screen.queryByLabelText('settings.pluginModels.pricing.inputLabel')).toBeNull();
  });

  it('edits pricing only for Claude models configured by the active provider', () => {
    const onModelsChange = vi.fn();
    const onConfiguredModelPricingChange = vi.fn();

    render(
      <CustomModelDialog
        isOpen
        models={[{
          id: 'user/custom-model',
          label: 'User Custom Model',
        }]}
        configuredModels={[{
          id: 'deepseek-v4-pro[1m]',
          label: 'deepseek-v4-pro[1m]',
        }]}
        onModelsChange={onModelsChange}
        onConfiguredModelPricingChange={onConfiguredModelPricingChange}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('deepseek-v4-pro[1m]')).toBeTruthy();
    expect(screen.getByText('settings.pluginModels.pricing.defaultPricing')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', {
      name: 'settings.pluginModels.editPricing deepseek-v4-pro[1m]',
    }));

    expect((screen.getByLabelText('settings.codexProvider.dialog.modelIdPlaceholder') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('settings.codexProvider.dialog.modelLabelPlaceholder') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('settings.codexProvider.dialog.modelDescPlaceholder') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByLabelText('settings.pluginModels.contextWindow.label')).toBeNull();

    fireEvent.change(screen.getByLabelText('settings.pluginModels.pricing.inputLabel'), {
      target: { value: '0.2' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    expect(onModelsChange).not.toHaveBeenCalled();
    expect(onConfiguredModelPricingChange).toHaveBeenCalledWith('deepseek-v4-pro[1m]', {
      inputCostPer1M: 0.2,
    });
  });

  it('adds a CodeBuddy LanguageModel configuration', () => {
    const onModelsChange = vi.fn();

    render(
      <CustomModelDialog
        isOpen
        models={[]}
        onModelsChange={onModelsChange}
        onClose={vi.fn()}
        codeBuddyConfigEnabled
        initialAddMode
      />,
    );

    fireEvent.change(screen.getByLabelText('settings.codexProvider.dialog.modelIdPlaceholder'), {
      target: { value: 'vendor/codebuddy-model' },
    });
    fireEvent.change(screen.getByLabelText('settings.codexProvider.dialog.modelLabelPlaceholder'), {
      target: { value: 'CodeBuddy Model' },
    });
    fireEvent.change(screen.getByPlaceholderText('供应商'), { target: { value: 'openai' } });
    fireEvent.change(screen.getByPlaceholderText('API KEY'), {
      target: { value: '${OPENAI_API_KEY}' },
    });
    fireEvent.change(screen.getByPlaceholderText('BASE URL (OpenAI 兼容)'), {
      target: { value: 'https://example.test/v1/chat/completions' },
    });
    fireEvent.change(screen.getByPlaceholderText('输入（context）'), { target: { value: '128000' } });
    fireEvent.change(screen.getByPlaceholderText('输出（max output）'), { target: { value: '8192' } });
    fireEvent.click(screen.getByLabelText('工具调用'));
    fireEvent.click(screen.getByLabelText('推理'));

    fireEvent.click(screen.getByRole('button', { name: 'common.add' }));

    expect(onModelsChange).toHaveBeenCalledWith([{
      id: 'vendor/codebuddy-model',
      label: 'CodeBuddy Model',
      description: undefined,
      vendor: 'openai',
      apiKey: '${OPENAI_API_KEY}',
      maxInputTokens: 128000,
      maxOutputTokens: 8192,
      url: 'https://example.test/v1/chat/completions',
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: true,
    }]);
  });

  it('rejects invalid CodeBuddy LanguageModel metadata', () => {
    const onModelsChange = vi.fn();

    render(
      <CustomModelDialog
        isOpen
        models={[]}
        onModelsChange={onModelsChange}
        onClose={vi.fn()}
        codeBuddyConfigEnabled
        initialAddMode
      />,
    );

    fireEvent.change(screen.getByLabelText('settings.codexProvider.dialog.modelIdPlaceholder'), {
      target: { value: 'vendor/invalid-codebuddy-model' },
    });
    fireEvent.change(screen.getByPlaceholderText('输入（context）'), { target: { value: '0' } });

    fireEvent.click(screen.getByRole('button', { name: 'common.add' }));

    expect(onModelsChange).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('Check token limits.');
  });

  it('preserves CodeBuddy fields when editing an existing model', () => {
    const onModelsChange = vi.fn();

    render(
      <CustomModelDialog
        isOpen
        models={[{
          id: 'vendor/existing-codebuddy-model',
          label: 'Existing Model',
          vendor: 'anthropic',
          apiKey: '${ANTHROPIC_API_KEY}',
          maxInputTokens: 200000,
          maxOutputTokens: 16000,
          url: 'https://example.test/anthropic',
          supportsToolCall: true,
          supportsImages: true,
          supportsReasoning: false,
        }]}
        onModelsChange={onModelsChange}
        onClose={vi.fn()}
        codeBuddyConfigEnabled
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'common.edit vendor/existing-codebuddy-model' }));

    expect((screen.getByPlaceholderText('供应商') as HTMLInputElement).value).toBe('anthropic');
    expect((screen.getByPlaceholderText('输入（context）') as HTMLInputElement).value).toBe('200000');
    expect((screen.getByLabelText('工具调用') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('图片输入') as HTMLInputElement).checked).toBe(true);

    fireEvent.change(screen.getByPlaceholderText('供应商'), { target: { value: 'openai' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    expect(onModelsChange).toHaveBeenCalledWith([expect.objectContaining({
      id: 'vendor/existing-codebuddy-model',
      vendor: 'openai',
      apiKey: '${ANTHROPIC_API_KEY}',
      maxInputTokens: 200000,
      supportsToolCall: true,
      supportsImages: true,
    })]);
  });

  it('preserves __ccguiScope when renaming a CodeBuddy model', () => {
    const onModelsChange = vi.fn();

    render(
      <CustomModelDialog
        isOpen
        models={[{
          id: 'vendor/project-scope-model',
          label: 'Project Model',
          __ccguiScope: 'project',
          vendor: 'openai',
          maxInputTokens: 128000,
          maxOutputTokens: 8192,
          url: 'https://example.test/v1/chat/completions',
        }]}
        onModelsChange={onModelsChange}
        onClose={vi.fn()}
        codeBuddyConfigEnabled
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'common.edit vendor/project-scope-model' }));
    fireEvent.change(screen.getByLabelText('settings.codexProvider.dialog.modelIdPlaceholder'), {
      target: { value: 'vendor/renamed-model' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));

    expect(onModelsChange).toHaveBeenCalledWith([expect.objectContaining({
      id: 'vendor/renamed-model',
      __ccguiScope: 'project',
    })]);
  });
});
