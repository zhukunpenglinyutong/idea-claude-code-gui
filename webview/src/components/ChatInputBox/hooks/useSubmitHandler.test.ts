import { renderHook } from '@testing-library/react';
import type { Attachment } from '../types.js';
import { useSubmitHandler } from './useSubmitHandler.js';

function createAttachment(id: string): Attachment {
  return { id, fileName: `${id}.txt`, mediaType: 'text/plain', data: 'ZGF0YQ==' };
}

describe('useSubmitHandler', () => {
  it('blocks keyboard and button submission while Codex context config is saving', () => {
    const addToast = vi.fn();
    const clearInput = vi.fn();
    const onSubmit = vi.fn();

    const { result } = renderHook(() =>
      useSubmitHandler({
        getTextContent: () => 'hello',
        invalidateCache: vi.fn(),
        attachments: [],
        isLoading: false,
        sdkStatusLoading: false,
        sdkInstalled: true,
        currentProvider: 'codex',
        submitBlocked: true,
        clearInput,
        cancelPendingInput: vi.fn(),
        externalAttachments: undefined,
        setInternalAttachments: vi.fn(),
        fileCompletion: { close: vi.fn() },
        commandCompletion: { close: vi.fn() },
        agentCompletion: { close: vi.fn() },
        promptCompletion: { close: vi.fn() },
        dollarCommandCompletion: { close: vi.fn() },
        recordInputHistory: vi.fn(),
        onSubmit,
        addToast,
        t: (key) => key,
      })
    );

    result.current();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(clearInput).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith('codexContextWindow.savingBlocked', 'info');
  });

  it('does nothing when input is empty and no attachments', () => {
    const clearInput = vi.fn();
    const close = vi.fn();
    const onSubmit = vi.fn();
    const recordInputHistory = vi.fn();

    const { result } = renderHook(() =>
      useSubmitHandler({
        getTextContent: () => '',
        invalidateCache: vi.fn(),
        attachments: [],
        isLoading: false,
        sdkStatusLoading: false,
        sdkInstalled: true,
        currentProvider: 'claude',
        clearInput,
        cancelPendingInput: vi.fn(),
        externalAttachments: undefined,
        setInternalAttachments: vi.fn(),
        fileCompletion: { close },
        commandCompletion: { close },
        agentCompletion: { close },
        promptCompletion: { close },
        dollarCommandCompletion: { close },
        recordInputHistory,
        onSubmit,
        t: (key) => key,
      })
    );

    result.current();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(clearInput).not.toHaveBeenCalled();
    expect(recordInputHistory).not.toHaveBeenCalled();
  });

  it('blocks submit when SDK status is loading', () => {
    const addToast = vi.fn();
    const clearInput = vi.fn();
    const close = vi.fn();

    const { result } = renderHook(() =>
      useSubmitHandler({
        getTextContent: () => 'hello',
        invalidateCache: vi.fn(),
        attachments: [],
        isLoading: false,
        sdkStatusLoading: true,
        sdkInstalled: true,
        currentProvider: 'claude',
        clearInput,
        cancelPendingInput: vi.fn(),
        externalAttachments: undefined,
        setInternalAttachments: vi.fn(),
        fileCompletion: { close },
        commandCompletion: { close },
        agentCompletion: { close },
        promptCompletion: { close },
        dollarCommandCompletion: { close },
        recordInputHistory: vi.fn(),
        onSubmit: vi.fn(),
        addToast,
        t: (key) => key,
      })
    );

    result.current();
    expect(addToast).toHaveBeenCalled();
    expect(clearInput).not.toHaveBeenCalled();
  });

  it('prompts install when SDK is missing', () => {
    const addToast = vi.fn();
    const onInstallSdk = vi.fn();

    const { result } = renderHook(() =>
      useSubmitHandler({
        getTextContent: () => 'hello',
        invalidateCache: vi.fn(),
        attachments: [],
        isLoading: false,
        sdkStatusLoading: false,
        sdkInstalled: false,
        currentProvider: 'codex',
        clearInput: vi.fn(),
        cancelPendingInput: vi.fn(),
        externalAttachments: undefined,
        setInternalAttachments: vi.fn(),
        fileCompletion: { close: vi.fn() },
        commandCompletion: { close: vi.fn() },
        agentCompletion: { close: vi.fn() },
        promptCompletion: { close: vi.fn() },
        dollarCommandCompletion: { close: vi.fn() },
        recordInputHistory: vi.fn(),
        onSubmit: vi.fn(),
        onInstallSdk,
        addToast,
        t: (key) => key,
      })
    );

    result.current();
    expect(addToast).toHaveBeenCalled();
    expect(onInstallSdk).toHaveBeenCalled();
  });

  it('submits content, closes completions, records history, and clears input', () => {
    vi.useFakeTimers();
    const clearInput = vi.fn();
    const recordInputHistory = vi.fn();
    const close = vi.fn();
    const onSubmit = vi.fn();
    const invalidateCache = vi.fn();

    const { result } = renderHook(() =>
      useSubmitHandler({
        getTextContent: () => 'hello',
        invalidateCache,
        attachments: [createAttachment('a1')],
        isLoading: false,
        sdkStatusLoading: false,
        sdkInstalled: true,
        currentProvider: 'claude',
        clearInput,
        cancelPendingInput: vi.fn(),
        externalAttachments: undefined,
        setInternalAttachments: vi.fn(),
        fileCompletion: { close },
        commandCompletion: { close },
        agentCompletion: { close },
        promptCompletion: { close },
        dollarCommandCompletion: { close },
        recordInputHistory,
        onSubmit,
        t: (key) => key,
      })
    );

    result.current();
    expect(invalidateCache).toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(5);
    expect(recordInputHistory).toHaveBeenCalledWith('hello');
    expect(clearInput).toHaveBeenCalled();

    vi.advanceTimersByTime(20);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('hello', [createAttachment('a1')]);
    vi.useRealTimers();
  });
});
