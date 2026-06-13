import { useEffect, useMemo, useState } from 'react';
import { sendToJava } from './bridge';

export interface NativeFileIconRequest {
  filePath?: string;
  fileName?: string;
  isDirectory?: boolean;
}

type NativeFileIconCacheValue = string | null;

interface NativeFileIconResponseItem {
  id?: string;
  dataUrl?: string;
}

const CACHE = new Map<string, NativeFileIconCacheValue>();
const LISTENERS = new Map<string, Set<() => void>>();
const PENDING = new Set<string>();

let callbackInstalled = false;

function normalizePath(value?: string): string {
  return (value || '').replace(/\\/g, '/').trim();
}

export function getNativeFileIconCacheKey(request: NativeFileIconRequest): string {
  const path = normalizePath(request.filePath);
  const name = normalizePath(request.fileName);
  const kind = request.isDirectory ? 'directory' : 'file';
  return `${kind}:${path || name}`;
}

function notify(key: string): void {
  const listeners = LISTENERS.get(key);
  if (!listeners) {
    return;
  }
  listeners.forEach((listener) => listener());
}

function installNativeFileIconCallback(): void {
  if (callbackInstalled || typeof window === 'undefined') {
    return;
  }

  const previous = window.onNativeFileIconsResolved;
  window.onNativeFileIconsResolved = (json: string) => {
    if (previous) {
      try {
        previous(json);
      } catch {
        // Ignore errors from a legacy handler.
      }
    }

    try {
      const response = JSON.parse(json) as { icons?: NativeFileIconResponseItem[] };
      for (const icon of response.icons || []) {
        const id = icon.id;
        if (!id) {
          continue;
        }
        PENDING.delete(id);
        CACHE.set(id, icon.dataUrl || null);
        notify(id);
      }
    } catch {
      // Keep fallback SVG icons when the backend sends malformed data.
    }
  };

  callbackInstalled = true;
}

export function subscribeNativeFileIcon(key: string, listener: () => void): () => void {
  let listeners = LISTENERS.get(key);
  if (!listeners) {
    listeners = new Set();
    LISTENERS.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners && listeners.size === 0) {
      LISTENERS.delete(key);
    }
  };
}

export function requestNativeFileIcon(key: string, request: NativeFileIconRequest): void {
  if (CACHE.has(key) || PENDING.has(key)) {
    return;
  }

  installNativeFileIconCallback();
  PENDING.add(key);

  sendToJava('resolve_native_file_icons', {
    items: [{
      id: key,
      path: request.filePath || '',
      fileName: request.fileName || '',
      isDirectory: Boolean(request.isDirectory),
    }],
  });
}

export function readNativeFileIcon(key: string): string | null | undefined {
  return CACHE.get(key);
}

export function hydrateNativeFileIconElements(root: ParentNode): void {
  if (typeof document === 'undefined') {
    return;
  }

  installNativeFileIconCallback();
  const elements = Array.from(root.querySelectorAll<HTMLElement>('[data-native-file-icon-key]'));
  for (const element of elements) {
    const key = element.dataset.nativeFileIconKey || '';
    if (!key) {
      continue;
    }

    const cached = CACHE.get(key);
    if (cached) {
      element.innerHTML = `<img src="${cached}" alt="" draggable="false" />`;
      element.classList.add('native-loaded');
      element.classList.remove('native-pending');
      continue;
    }

    element.classList.add('native-pending');
    const unsubscribe = subscribeNativeFileIcon(key, () => {
      const dataUrl = CACHE.get(key);
      if (dataUrl) {
        element.innerHTML = `<img src="${dataUrl}" alt="" draggable="false" />`;
        element.classList.add('native-loaded');
        element.classList.remove('native-pending');
      }
      unsubscribe();
    });

    requestNativeFileIcon(key, {
      filePath: element.dataset.nativeFileIconPath || '',
      fileName: element.dataset.nativeFileIconName || '',
      isDirectory: element.dataset.nativeFileIconDirectory === 'true',
    });
  }
}

export function useNativeFileIcon(request: NativeFileIconRequest, enabled = true): string | null {
  const key = useMemo(() => getNativeFileIconCacheKey(request), [request.filePath, request.fileName, request.isDirectory]);
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!enabled || !key || key === 'file:') {
      return undefined;
    }

    installNativeFileIconCallback();
    const unsubscribe = subscribeNativeFileIcon(key, () => setVersion((value) => value + 1));
    requestNativeFileIcon(key, request);
    return unsubscribe;
  }, [enabled, key, request.filePath, request.fileName, request.isDirectory]);

  if (!enabled || !key || key === 'file:') {
    return null;
  }

  return CACHE.get(key) || null;
}
