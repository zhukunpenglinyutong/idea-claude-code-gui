import { useEffect, useMemo, useRef, useState } from 'react';
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

// Maximum number of entries to retain in the frontend icon cache. When exceeded,
// the oldest entries are evicted to prevent unbounded memory growth in long-lived
// sessions or large workspaces.
const CACHE_MAX_SIZE = 512;

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
  cacheSet(key, value);
  notify(key);
}

/** Set a cache entry, evicting the oldest entries when the cache exceeds its limit. */
function cacheSet(key: string, value: NativeFileIconCacheValue): void {
  CACHE.set(key, value);
  if (CACHE.size > CACHE_MAX_SIZE) {
    const iterator = CACHE.keys();
    // Evict the oldest entry (first key in insertion order).
    const oldest = iterator.next().value;
    if (oldest !== undefined) {
      CACHE.delete(oldest);
    }
  }
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

    // Already resolved: render the icon, or — if it resolved without a usable
    // icon (cached null) — keep the fallback and drop the pending state instead
    // of re-subscribing to a request that CACHE.has() would suppress.
    if (CACHE.has(key)) {
      const cached = CACHE.get(key);
      if (isSafeIconDataUrl(cached)) {
        applyNativeIconImage(element, cached);
      } else {
        element.classList.remove('native-pending');
      }
      continue;
    }

    element.classList.add('native-pending');
    const unsubscribe = subscribeNativeFileIcon(key, () => {
      // Drop listeners whose element was removed from the DOM (e.g. useFileTags
      // replacing innerHTML) so detached nodes aren't retained via LISTENERS.
      if (!element.isConnected) {
        unsubscribe();
        return;
      }
      const dataUrl = CACHE.get(key);
      if (isSafeIconDataUrl(dataUrl)) {
        applyNativeIconImage(element, dataUrl);
        unsubscribe();
      } else if (CACHE.has(key)) {
        // Resolved without a usable icon: keep the fallback, stop pending.
        element.classList.remove('native-pending');
        unsubscribe();
      }
      // On failure/timeout the value is absent (not cached); stay subscribed so
      // a later successful resolution can still hydrate the element.
    });

    requestNativeFileIcon(key, {
      filePath: element.dataset.nativeFileIconPath || '',
      fileName: element.dataset.nativeFileIconName || '',
      isDirectory: element.dataset.nativeFileIconDirectory === 'true',
    });
  }
}

export function useNativeFileIcon(request: NativeFileIconRequest, enabled = true): string | null | undefined {
  const key = useMemo(() => getNativeFileIconCacheKey(request), [request.filePath, request.fileName, request.isDirectory]);
  const [, setVersion] = useState(0);

  // Snapshot the resolved value so the component is resilient to cache eviction.
  // Once we observe a resolved value (string or null), we keep it in a ref so
  // that a later eviction from the bounded CACHE doesn't regress to undefined.
  const resolvedRef = useRef<{ key: string; value: string | null } | null>(null);

  useEffect(() => {
    if (!enabled || !key) {
      return undefined;
    }

    // Skip subscription and request when the key is already resolved in the
    // cache (including cached null). No further notify() will ever fire for a
    // resolved key, so subscribing would only retain an unused function reference
    // in LISTENERS until unmount.
    if (CACHE.has(key)) {
      const cached = CACHE.get(key);
      resolvedRef.current = { key, value: isSafeIconDataUrl(cached) ? cached : null };
      return undefined;
    }

    installNativeFileIconCallback();
    const unsubscribe = subscribeNativeFileIcon(key, () => {
      // Snapshot the value on notification so it survives eviction.
      if (CACHE.has(key)) {
        const cached = CACHE.get(key);
        resolvedRef.current = { key, value: isSafeIconDataUrl(cached) ? cached : null };
      }
      setVersion((value) => value + 1);
    });
    requestNativeFileIcon(key, request);
    return unsubscribe;
  }, [enabled, key, request.filePath, request.fileName, request.isDirectory]);

  // Tri-state: null = disabled/invalid-key/resolved-without-icon,
  // undefined = still pending (no cache entry yet), string = safe data URL.
  if (!enabled || !key) {
    return null;
  }

  // Use the snapshotted value if available and still for the current key.
  if (resolvedRef.current && resolvedRef.current.key === key) {
    return resolvedRef.current.value;
  }

  if (!CACHE.has(key)) {
    return undefined;
  }

  const cached = CACHE.get(key);
  const result = isSafeIconDataUrl(cached) ? cached : null;
  resolvedRef.current = { key, value: result };
  return result;
}
