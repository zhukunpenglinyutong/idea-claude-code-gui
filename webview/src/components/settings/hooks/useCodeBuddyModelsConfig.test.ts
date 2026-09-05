import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodeBuddyModelsConfig } from './useCodeBuddyModelsConfig';

const sendToJavaMock = vi.hoisted(() => vi.fn());

vi.mock('../../../utils/bridge', () => ({
  sendToJava: (...args: unknown[]) => sendToJavaMock(...args),
}));

function emitModels(payload: unknown) {
  act(() => {
    window.updateCodeBuddyModelsConfig?.(JSON.stringify(payload));
  });
}

function savedRequest() {
  const call = sendToJavaMock.mock.calls
    .find(([command]) => String(command) === 'save_codebuddy_models_config');
  const content = call?.[1] ?? '{}';
  return JSON.parse(String(content)) as {
    models: Array<Record<string, unknown>>;
    deletedModels: Array<Record<string, unknown>>;
  };
}

describe('useCodeBuddyModelsConfig', () => {
  beforeEach(() => {
    sendToJavaMock.mockClear();
    delete window.updateCodeBuddyModelsConfig;
  });

  afterEach(() => {
    delete window.updateCodeBuddyModelsConfig;
  });

  it('loads only valid models.json entries and normalizes LanguageModel names', () => {
    const { result, unmount } = renderHook(() => useCodeBuddyModelsConfig(true));

    expect(sendToJavaMock).toHaveBeenCalledWith('get_codebuddy_models_config');

    emitModels({
      success: true,
      models: [
        {
          id: '  project/model  ',
          name: 'Project Model',
          __ccguiScope: 'project',
          relatedModels: { fast: 'project/fast', ignored: 42 },
        },
        { name: 'missing-id' },
        null,
      ],
    });

    expect(result.current.models).toEqual([{
      id: 'project/model',
      label: 'Project Model',
      description: undefined,
      __ccguiScope: 'project',
      vendor: undefined,
      apiKey: undefined,
      maxInputTokens: undefined,
      maxOutputTokens: undefined,
      url: undefined,
      temperature: undefined,
      supportsToolCall: undefined,
      supportsImages: undefined,
      supportsReasoning: undefined,
      relatedModels: { fast: 'project/fast' },
    }]);

    unmount();
  });

  it('delivers the config response to multiple mounted consumers', () => {
    const { result, unmount } = renderHook(() => ({
      first: useCodeBuddyModelsConfig(true),
      second: useCodeBuddyModelsConfig(true),
    }));

    emitModels({
      success: true,
      models: [{ id: 'gpt-5.4-mini', name: 'GPT-5.4 mini' }],
    });

    expect(result.current.first.models).toEqual([
      expect.objectContaining({ id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' }),
    ]);
    expect(result.current.second.models).toEqual([
      expect.objectContaining({ id: 'gpt-5.4-mini', label: 'GPT-5.4 mini' }),
    ]);

    unmount();
  });

  it('refreshes the models.json catalog on demand', () => {
    const { result, unmount } = renderHook(() => useCodeBuddyModelsConfig(true));
    sendToJavaMock.mockClear();

    act(() => {
      result.current.refresh();
    });

    expect(sendToJavaMock).toHaveBeenCalledWith('get_codebuddy_models_config');
    unmount();
  });

  it('preserves scope and sends only changed and deleted models to Java', () => {
    const { result, unmount } = renderHook(() => useCodeBuddyModelsConfig(true));
    emitModels({
      success: true,
      models: [
        { id: 'project/model', name: 'Old Project', vendor: 'old', __ccguiScope: 'project' },
        { id: 'user/remove', name: 'Remove Me', __ccguiScope: 'user' },
        { id: 'user/unchanged', name: 'Unchanged', __ccguiScope: 'user' },
      ],
    });
    sendToJavaMock.mockClear();

    act(() => {
      result.current.updateModels([
        { id: 'project/model', label: 'New Project', vendor: 'new', __ccguiScope: 'project' },
        { id: 'user/unchanged', label: 'Unchanged' },
        { id: 'user/added', label: 'Added' },
      ]);
    });

    const request = savedRequest();
    expect(request.models).toEqual([
      {
        id: 'project/model',
        vendor: 'new',
        name: 'New Project',
        __ccguiScope: 'project',
      },
      {
        id: 'user/added',
        name: 'Added',
        __ccguiScope: 'user',
      },
    ]);
    expect(request.deletedModels).toEqual([{ id: 'user/remove', __ccguiScope: 'user' }]);
    expect(sendToJavaMock).not.toHaveBeenCalledWith('get_cli_models', 'codebuddy');
    unmount();
  });

  it('keeps the existing list when Java reports a save failure', () => {
    const { result, unmount } = renderHook(() => useCodeBuddyModelsConfig(true));
    emitModels({
      success: true,
      models: [{ id: 'gpt-5.5', name: 'GPT-5.5' }, { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' }],
    });
    expect(result.current.models).toHaveLength(2);

    // A failed save push carries no models array and must not blank the list.
    emitModels({ success: false, errorCode: 'CODEBUDDY_LOCAL_CONFIG_REQUIRED' });

    expect(result.current.models).toHaveLength(2);
    expect(result.current.models).toEqual([
      expect.objectContaining({ id: 'gpt-5.5' }),
      expect.objectContaining({ id: 'gpt-5.6-luna' }),
    ]);
    unmount();
  });

  it('does not request the catalog while disabled', () => {
    const { result } = renderHook(() => useCodeBuddyModelsConfig(false));

    act(() => {
      result.current.refresh();
    });

    expect(sendToJavaMock).not.toHaveBeenCalled();
  });
});
