import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, renderHook } from '@testing-library/react';

const { sendToJavaMock } = vi.hoisted(() => ({ sendToJavaMock: vi.fn() }));

vi.mock('../../utils/bridge', () => ({
  sendToJava: sendToJavaMock,
}));

import { NativeFileIcon } from './NativeFileIcon';
import { getNativeFileIconCacheKey, readNativeFileIcon, useNativeFileIcon } from '../../utils/nativeFileIcons';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';

function emit(json: string): void {
  (window as unknown as { onNativeFileIconsResolved?: (j: string) => void }).onNativeFileIconsResolved?.(json);
}

beforeEach(() => {
  sendToJavaMock.mockClear();
});

afterEach(() => {
  cleanup();
});

// Module-level CACHE persists across tests, so every test uses a unique path/key.
describe('useNativeFileIcon tri-state', () => {
  it('returns undefined while no cache entry exists (still pending)', () => {
    const { result } = renderHook(() =>
      useNativeFileIcon({ filePath: '/x/hook-pending.ts', fileName: 'hook-pending.ts' }, true));

    expect(result.current).toBeUndefined();
  });

  it('returns null when the backend resolves without a usable icon', () => {
    const request = { filePath: '/x/hook-null.ts', fileName: 'hook-null.ts' };
    const key = getNativeFileIconCacheKey(request);

    const { result } = renderHook(() => useNativeFileIcon(request, true));
    expect(result.current).toBeUndefined();

    act(() => emit(JSON.stringify({ icons: [{ id: key, dataUrl: null }] })));

    expect(result.current).toBeNull();
  });

  it('returns the data URL once a safe icon resolves', () => {
    const request = { filePath: '/x/hook-loaded.ts', fileName: 'hook-loaded.ts' };
    const key = getNativeFileIconCacheKey(request);

    const { result } = renderHook(() => useNativeFileIcon(request, true));
    act(() => emit(JSON.stringify({ icons: [{ id: key, dataUrl: PNG_DATA_URL }] })));

    expect(result.current).toBe(PNG_DATA_URL);
  });

  it('returns null (not undefined) when disabled', () => {
    const { result } = renderHook(() =>
      useNativeFileIcon({ filePath: '/x/hook-disabled.ts', fileName: 'hook-disabled.ts' }, false));

    expect(result.current).toBeNull();
  });

  it('does not re-request when the icon is already cached as a data URL', () => {
    const request = { filePath: '/x/hook-cached-icon.ts', fileName: 'hook-cached-icon.ts' };
    const key = getNativeFileIconCacheKey(request);

    const first = renderHook(() => useNativeFileIcon(request, true));
    act(() => emit(JSON.stringify({ icons: [{ id: key, dataUrl: PNG_DATA_URL }] })));
    expect(first.result.current).toBe(PNG_DATA_URL);
    first.unmount();
    sendToJavaMock.mockClear();

    // A fresh mount for the same (cached) key must not subscribe/request again.
    const second = renderHook(() => useNativeFileIcon(request, true));
    expect(second.result.current).toBe(PNG_DATA_URL);
    expect(sendToJavaMock).not.toHaveBeenCalled();
  });

  it('does not re-request when the icon is already cached as null', () => {
    const request = { filePath: '/x/hook-cached-null.ts', fileName: 'hook-cached-null.ts' };
    const key = getNativeFileIconCacheKey(request);

    const first = renderHook(() => useNativeFileIcon(request, true));
    act(() => emit(JSON.stringify({ icons: [{ id: key, dataUrl: null }] })));
    expect(first.result.current).toBeNull();
    first.unmount();
    sendToJavaMock.mockClear();

    const second = renderHook(() => useNativeFileIcon(request, true));
    expect(second.result.current).toBeNull();
    expect(sendToJavaMock).not.toHaveBeenCalled();
  });

  it('keeps the resolved value after the key is evicted from the bounded cache', () => {
    const request = { filePath: '/x/hook-evicted.ts', fileName: 'hook-evicted.ts' };
    const key = getNativeFileIconCacheKey(request);

    const { result, rerender } = renderHook(() => useNativeFileIcon(request, true));
    act(() => emit(JSON.stringify({ icons: [{ id: key, dataUrl: PNG_DATA_URL }] })));
    expect(result.current).toBe(PNG_DATA_URL);

    // Overflow the bounded cache so the resolved key is evicted (oldest-first).
    const others: Array<{ id: string; dataUrl: string }> = [];
    for (let i = 0; i < 600; i += 1) {
      others.push({ id: `file:/evict/${i}.ts`, dataUrl: PNG_DATA_URL });
    }
    act(() => emit(JSON.stringify({ icons: others })));
    expect(readNativeFileIcon(key)).toBeUndefined();

    // A re-render still surfaces the value via the resolvedRef snapshot.
    rerender();
    expect(result.current).toBe(PNG_DATA_URL);
  });
});

describe('NativeFileIcon pending state', () => {
  function getSpan(container: HTMLElement): HTMLElement {
    return container.querySelector('span.codriver-native-file-icon') as HTMLElement;
  }

  it('sets native-pending only while pending (undefined)', () => {
    const { container } = render(
      <NativeFileIcon filePath="/x/comp-pending.ts" fileName="comp-pending.ts" fallback={<i data-testid="fb" />} />,
    );

    const span = getSpan(container);
    expect(span.classList.contains('native-pending')).toBe(true);
    expect(span.classList.contains('native-loaded')).toBe(false);
  });

  it('removes native-pending when the backend resolves to null (fallback only)', () => {
    const request = { filePath: '/x/comp-null.ts', fileName: 'comp-null.ts' };
    const key = getNativeFileIconCacheKey(request);

    const { container } = render(
      <NativeFileIcon filePath={request.filePath} fileName={request.fileName} fallback={<i data-testid="fb" />} />,
    );
    const span = getSpan(container);
    expect(span.classList.contains('native-pending')).toBe(true);

    act(() => emit(JSON.stringify({ icons: [{ id: key, dataUrl: null }] })));

    expect(span.classList.contains('native-pending')).toBe(false);
    expect(span.classList.contains('native-loaded')).toBe(false);
    expect(span.querySelector('img')).toBeNull();
  });

  it('sets native-loaded with an <img> when a safe icon resolves', () => {
    const request = { filePath: '/x/comp-loaded.ts', fileName: 'comp-loaded.ts' };
    const key = getNativeFileIconCacheKey(request);

    const { container } = render(
      <NativeFileIcon filePath={request.filePath} fileName={request.fileName} fallback={<i data-testid="fb" />} />,
    );

    act(() => emit(JSON.stringify({ icons: [{ id: key, dataUrl: PNG_DATA_URL }] })));

    const span = getSpan(container);
    expect(span.classList.contains('native-loaded')).toBe(true);
    expect(span.classList.contains('native-pending')).toBe(false);
    expect(span.querySelector('img')?.getAttribute('src')).toBe(PNG_DATA_URL);
  });
});
