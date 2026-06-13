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
const PENDING_TIMERS = new Map<string, ReturnType<typeof setTimeout>>();

// Defensive timeout: if the backend never answers a request (or answers without
// the expected id), the pending key is released after this delay so later
// requests for the same key can be retried instead of being blocked forever.
const NATIVE_ICON_REQUEST_TIMEOUT_MS = 15000;

// Only accept base64-encoded image data URLs. This guards against `javascript:`
// or other non-image payloads ever reaching an <img src> or the cache.
const SAFE_ICON_DATA_URL_REGEX = /^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/i;

let callbackInstalled = false;

function normalizePath(value?: string): string {
  return (value || '').replace(/\\/g, '/').trim();
}

function isSafeIconDataUrl(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ICON_DATA_URL_REGEX.test(value);
}

/**
 * Build a stable cache key for a request. Returns an empty string when neither a
 * path nor a file name is available, so callers can treat an empty key as
 * "no native icon" and fall back instead of emitting meaningless keys such as
 * `file:` or `directory:`.
 */
export function getNativeFileIconCacheKey(request: NativeFileIconRequest): string {
  const path = normalizePath(request.filePath);
  const name = normalizePath(request.fileName);
  const identifier = path || name;
  if (!identifier) {
    return '';
  }
  const kind = request.isDirectory ? 'directory' : 'file';
  return `${kind}:${identifier}`;
}

function notify(key: string): void {
  const listeners = LISTENERS.get(key);
  if (!listeners) {
    return;
  }
  listeners.forEach((listener) => listener());
}

function clearPendingTimer(key: string): void {
  const timer = PENDING_TIMERS.get(key);
  if (timer !== undefined) {
    clearTimeout(timer);
    PENDING_TIMERS.delete(key);
  }
}

/** Resolve a pending request with a (validated) value and notify listeners. */
function resolvePending(key: string, value: NativeFileIconCacheValue): void {
  clearPendingTimer(key);
  PENDING.delete(key);
  CACHE.set(key, value);
  notify(key);
}

/**
 * Release a pending request without caching a value (timeout / malformed /
 * unknown response). Listeners are notified so the UI can leave its
 * intermediate state, and a later request for the same key can be retried.
 */
function failPending(key: string): void {
  clearPendingTimer(key);
  if (PENDING.delete(key)) {
    notify(key);
  }
}

function failAllPending(): void {
  for (const key of Array.from(PENDING)) {
    failPending(key);
  }
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

    let response: { icons?: NativeFileIconResponseItem[] };
    try {
      response = JSON.parse(json) as { icons?: NativeFileIconResponseItem[] };
    } catch {
      // Malformed payload: release every pending key so the requests are not
      // blocked forever and can be retried later.
      failAllPending();
      return;
    }

    const icons = response?.icons;
    if (!Array.isArray(icons)) {
      failAllPending();
      return;
    }

    for (const icon of icons) {
      const id = icon?.id;
      if (!id || typeof id !== 'string') {
        // Cannot map this entry back to a request; the defensive timeout will
        // release the originating key.
        continue;
      }
      const dataUrl = isSafeIconDataUrl(icon.dataUrl) ? icon.dataUrl : null;
      resolvePending(id, dataUrl);
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
  if (!key || CACHE.has(key) || PENDING.has(key)) {
    return;
  }

  installNativeFileIconCallback();
  PENDING.add(key);

  const timer = setTimeout(() => failPending(key), NATIVE_ICON_REQUEST_TIMEOUT_MS);
  PENDING_TIMERS.set(key, timer);

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

/** Render a validated data URL into an element using DOM APIs (no innerHTML). */
function applyNativeIconImage(element: HTMLElement, dataUrl: string): void {
  const img = document.createElement('img');
  img.alt = '';
  img.draggable = false;
  img.src = dataUrl;

  // Replace existing children without parsing HTML strings.
  element.textContent = '';
  element.appendChild(img);
  element.classList.add('native-loaded');
  element.classList.remove('native-pending');
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
    if (isSafeIconDataUrl(cached)) {
      applyNativeIconImage(element, cached);
      continue;
    }

    element.classList.add('native-pending');
    const unsubscribe = subscribeNativeFileIcon(key, () => {
      const dataUrl = CACHE.get(key);
      if (isSafeIconDataUrl(dataUrl)) {
        applyNativeIconImage(element, dataUrl);
        unsubscribe();
      }
      // On failure/timeout the value is absent; stay subscribed so a later
      // successful resolution can still hydrate the element.
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
    if (!enabled || !key) {
      return undefined;
    }

    installNativeFileIconCallback();
    const unsubscribe = subscribeNativeFileIcon(key, () => setVersion((value) => value + 1));
    requestNativeFileIcon(key, request);
    return unsubscribe;
  }, [enabled, key, request.filePath, request.fileName, request.isDirectory]);

  if (!enabled || !key) {
    return null;
  }

  const cached = CACHE.get(key);
  return isSafeIconDataUrl(cached) ? cached : null;
}
