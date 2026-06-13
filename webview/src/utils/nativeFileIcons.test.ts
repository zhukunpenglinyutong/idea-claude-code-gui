import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendToJavaMock } = vi.hoisted(() => ({ sendToJavaMock: vi.fn() }));

vi.mock('./bridge', () => ({
  sendToJava: sendToJavaMock,
}));

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC';

type NativeFileIconsModule = typeof import('./nativeFileIcons');

async function loadModule(): Promise<NativeFileIconsModule> {
  vi.resetModules();
  // Drop any callback installed by a previous module instance so each test
  // starts from a clean state.
  (window as unknown as { onNativeFileIconsResolved?: unknown }).onNativeFileIconsResolved = undefined;
  return import('./nativeFileIcons');
}

function emitBackendResponse(json: string): void {
  const handler = (window as unknown as { onNativeFileIconsResolved?: (json: string) => void })
    .onNativeFileIconsResolved;
  expect(handler).toBeTypeOf('function');
  handler!(json);
}

beforeEach(() => {
  sendToJavaMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('getNativeFileIconCacheKey', () => {
  it('builds stable keys for valid file and directory values', async () => {
    const { getNativeFileIconCacheKey } = await loadModule();

    expect(getNativeFileIconCacheKey({ filePath: 'C:\\a\\b.ts' })).toBe('file:C:/a/b.ts');
    expect(getNativeFileIconCacheKey({ fileName: 'b.ts' })).toBe('file:b.ts');
    expect(getNativeFileIconCacheKey({ filePath: '/x/y', isDirectory: true })).toBe('directory:/x/y');

    // Same input must produce an identical key.
    const request = { filePath: '/x/y/z.ts' };
    expect(getNativeFileIconCacheKey(request)).toBe(getNativeFileIconCacheKey(request));
  });

  it('does not produce a usable key for empty file/directory values', async () => {
    const { getNativeFileIconCacheKey } = await loadModule();

    expect(getNativeFileIconCacheKey({})).toBe('');
    expect(getNativeFileIconCacheKey({ filePath: '   ' })).toBe('');
    expect(getNativeFileIconCacheKey({ fileName: '' })).toBe('');
    // isDirectory alone must not yield `directory:`.
    expect(getNativeFileIconCacheKey({ isDirectory: true })).toBe('');
  });
});

describe('requestNativeFileIcon', () => {
  it('does not dispatch a request for an invalid (empty) key', async () => {
    const { requestNativeFileIcon } = await loadModule();

    requestNativeFileIcon('', { filePath: '' });

    expect(sendToJavaMock).not.toHaveBeenCalled();
  });

  it('caches the icon and notifies listeners on a successful callback', async () => {
    const { requestNativeFileIcon, subscribeNativeFileIcon, readNativeFileIcon } = await loadModule();
    const key = 'file:/project/a.ts';
    const listener = vi.fn();

    subscribeNativeFileIcon(key, listener);
    requestNativeFileIcon(key, { filePath: '/project/a.ts', fileName: 'a.ts' });

    expect(sendToJavaMock).toHaveBeenCalledTimes(1);
    expect(sendToJavaMock).toHaveBeenCalledWith('resolve_native_file_icons', {
      items: [{ id: key, path: '/project/a.ts', fileName: 'a.ts', isDirectory: false }],
    });

    emitBackendResponse(JSON.stringify({ icons: [{ id: key, dataUrl: PNG_DATA_URL }] }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(readNativeFileIcon(key)).toBe(PNG_DATA_URL);
  });

  it('releases pending keys on a malformed payload and allows a retry', async () => {
    const { requestNativeFileIcon, subscribeNativeFileIcon, readNativeFileIcon } = await loadModule();
    const key = 'file:/project/b.ts';
    const listener = vi.fn();

    subscribeNativeFileIcon(key, listener);
    requestNativeFileIcon(key, { filePath: '/project/b.ts' });
    expect(sendToJavaMock).toHaveBeenCalledTimes(1);

    emitBackendResponse('this is not json');

    // Listener notified so the UI can leave its pending state, nothing cached.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readNativeFileIcon(key)).toBeUndefined();

    // A subsequent request for the same key must be dispatched again.
    requestNativeFileIcon(key, { filePath: '/project/b.ts' });
    expect(sendToJavaMock).toHaveBeenCalledTimes(2);
  });

  it('does not block future requests when the response omits or mismatches the id', async () => {
    vi.useFakeTimers();
    const { requestNativeFileIcon } = await loadModule();
    const key = 'file:/project/c.ts';

    requestNativeFileIcon(key, { filePath: '/project/c.ts' });
    expect(sendToJavaMock).toHaveBeenCalledTimes(1);

    // Response carries an item without id and one for an unrelated key.
    emitBackendResponse(JSON.stringify({
      icons: [{ dataUrl: PNG_DATA_URL }, { id: 'file:/other.ts', dataUrl: PNG_DATA_URL }],
    }));

    // Still pending right after, so an immediate re-request is suppressed.
    requestNativeFileIcon(key, { filePath: '/project/c.ts' });
    expect(sendToJavaMock).toHaveBeenCalledTimes(1);

    // The defensive timeout releases the key, enabling a later retry.
    vi.advanceTimersByTime(15000);
    requestNativeFileIcon(key, { filePath: '/project/c.ts' });
    expect(sendToJavaMock).toHaveBeenCalledTimes(2);
  });

  it('does not notify a listener after it has unsubscribed', async () => {
    const { requestNativeFileIcon, subscribeNativeFileIcon } = await loadModule();
    const key = 'file:/project/d.ts';
    const listener = vi.fn();

    const unsubscribe = subscribeNativeFileIcon(key, listener);
    requestNativeFileIcon(key, { filePath: '/project/d.ts' });
    unsubscribe();

    emitBackendResponse(JSON.stringify({ icons: [{ id: key, dataUrl: PNG_DATA_URL }] }));

    expect(listener).not.toHaveBeenCalled();
  });

  it('does not cache invalid data URLs', async () => {
    const { requestNativeFileIcon, readNativeFileIcon } = await loadModule();
    const key = 'file:/project/e.ts';

    requestNativeFileIcon(key, { filePath: '/project/e.ts' });
    emitBackendResponse(JSON.stringify({ icons: [{ id: key, dataUrl: 'javascript:alert(1)' }] }));

    // The malicious value must not be cached; absence (null) is stored instead.
    expect(readNativeFileIcon(key)).toBeNull();
  });
});

describe('hydrateNativeFileIconElements', () => {
  function buildElement(key: string): { root: HTMLElement; el: HTMLElement } {
    const root = document.createElement('div');
    const el = document.createElement('span');
    el.setAttribute('data-native-file-icon-key', key);
    el.setAttribute('data-native-file-icon-path', '/project/f.ts');
    el.setAttribute('data-native-file-icon-name', 'f.ts');
    root.appendChild(el);
    return { root, el };
  }

  it('renders a cached icon as an <img> via DOM APIs', async () => {
    const { requestNativeFileIcon, hydrateNativeFileIconElements } = await loadModule();
    const key = 'file:/project/f.ts';

    requestNativeFileIcon(key, { filePath: '/project/f.ts', fileName: 'f.ts' });
    emitBackendResponse(JSON.stringify({ icons: [{ id: key, dataUrl: PNG_DATA_URL }] }));

    const { root, el } = buildElement(key);
    hydrateNativeFileIconElements(root);

    const img = el.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(PNG_DATA_URL);
    expect(el.classList.contains('native-loaded')).toBe(true);
    expect(el.classList.contains('native-pending')).toBe(false);
  });

  it('does not render an icon when the cached value is invalid', async () => {
    const { requestNativeFileIcon, hydrateNativeFileIconElements } = await loadModule();
    const key = 'file:/project/g.ts';
    const { root, el } = buildElement(key);

    requestNativeFileIcon(key, { filePath: '/project/g.ts' });
    emitBackendResponse(JSON.stringify({ icons: [{ id: key, dataUrl: 'data:text/html;base64,abcd' }] }));

    hydrateNativeFileIconElements(root);

    expect(el.querySelector('img')).toBeNull();
  });

  it('clears pending and does not re-request when the icon resolved to null', async () => {
    const { requestNativeFileIcon, hydrateNativeFileIconElements } = await loadModule();
    const key = 'file:/project/h.ts';

    // Backend resolved the request but returned no native icon.
    requestNativeFileIcon(key, { filePath: '/project/h.ts' });
    emitBackendResponse(JSON.stringify({ icons: [{ id: key, dataUrl: null }] }));
    sendToJavaMock.mockClear();

    const root = document.createElement('div');
    const el = document.createElement('span');
    el.classList.add('native-pending');
    el.setAttribute('data-native-file-icon-key', key);
    el.setAttribute('data-native-file-icon-path', '/project/h.ts');
    root.appendChild(el);

    hydrateNativeFileIconElements(root);

    // Fallback is kept, the element is no longer pending, and no new request is
    // dispatched (the cached null would otherwise leave it stuck pending).
    expect(el.querySelector('img')).toBeNull();
    expect(el.classList.contains('native-pending')).toBe(false);
    expect(sendToJavaMock).not.toHaveBeenCalled();
  });
});
