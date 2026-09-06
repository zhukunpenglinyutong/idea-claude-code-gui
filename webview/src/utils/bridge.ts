import { isJavaFqcnCandidate, normalizeFileNavigationTarget, parseFileLinkTarget } from './linkify';

const BRIDGE_UNAVAILABLE_WARNED = new Set<string>();
/** Canonical GitHub repository URL, used by star/promo banners across the UI. */
export const GITHUB_REPO_URL = 'https://github.com/zhukunpenglinyutong/jetbrains-cc-gui';

const SAFE_BROWSER_PROTOCOLS = /^(https?|mailto):/i;

/** Regex to detect path traversal: matches ".." as a path segment, not as part of filenames */
const PATH_TRAVERSAL_REGEX = /(^|[\\/])\.\.($|[\\/])/;
const CONTROL_CHAR_REGEX = /[\u0000-\u001f]/;

type ResolveFilePathCallback = (resolvedPath: string | null) => void;

interface PendingResolveEntry {
  callbacks: ResolveFilePathCallback[];
  timeoutId: ReturnType<typeof setTimeout>;
}

// Upper-bound on how long we wait for the JCEF backend to answer a
// resolve_file_path request. Without this, a dropped bridge message,
// closed project, or backend exception would leak the callback forever
// and let the Map grow unbounded over a long session.
const RESOLVE_FILE_PATH_TIMEOUT_MS = 5000;

const resolveFilePathCallbacks = new Map<string, PendingResolveEntry>();
let resolveFilePathHandlerInstalled = false;

function flushPendingCallbacks(path: string, resolvedPath: string | null) {
  const entry = resolveFilePathCallbacks.get(path);
  if (!entry) {
    return;
  }
  clearTimeout(entry.timeoutId);
  resolveFilePathCallbacks.delete(path);
  entry.callbacks.forEach((cb) => {
    try {
      cb(resolvedPath);
    } catch {
      // A misbehaving subscriber must not block siblings from receiving
      // the resolved path or the null-on-timeout signal.
    }
  });
}

function installResolveFilePathHandler() {
  if (resolveFilePathHandlerInstalled) {
    return;
  }

  const originalHandler = window.onFilePathResolved;
  window.onFilePathResolved = (json: string) => {
    if (originalHandler) {
      try {
        originalHandler(json);
      } catch {
        // Ignore errors from legacy handlers
      }
    }

    try {
      const data = JSON.parse(json) as { path?: string; resolvedPath?: string | null };
      const path = data.path;
      const resolvedPath = data.resolvedPath ?? null;
      if (!path) {
        return;
      }
      flushPendingCallbacks(path, resolvedPath);
    } catch {
      // Silently ignore malformed JSON from backend
    }
  };

  resolveFilePathHandlerInstalled = true;
}

/**
 * Resolve a file path asynchronously with a callback.
 * Multiple callers for the same path share a single backend request.
 */
export const resolveFilePathWithCallback = (
  filePath: string,
  callback: ResolveFilePathCallback,
): void => {
  if (!filePath) {
    callback(null);
    return;
  }
  const normalizedPath = normalizeFileNavigationTarget(filePath);
  if (!normalizedPath || !isValidOpenFileTarget(normalizedPath)) {
    callback(null);
    return;
  }

  installResolveFilePathHandler();

  const existing = resolveFilePathCallbacks.get(normalizedPath);
  if (existing) {
    resolveFilePathCallbacks.set(normalizedPath, {
      callbacks: [...existing.callbacks, callback],
      timeoutId: existing.timeoutId,
    });
    return;
  }

  const timeoutId = setTimeout(() => {
    flushPendingCallbacks(normalizedPath, null);
  }, RESOLVE_FILE_PATH_TIMEOUT_MS);

  resolveFilePathCallbacks.set(normalizedPath, {
    callbacks: [callback],
    timeoutId,
  });
  sendBridgeEvent('resolve_file_path', normalizedPath);
};

/**
 * Validate mutating file paths don't contain traversal patterns.
 * Defense-in-depth: backend also validates using canonical paths.
 */
const isValidMutatingPath = (filePath: string): boolean => {
  if (!filePath) return false;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(filePath);
  } catch {
    console.debug('[bridge] isValidMutatingPath: decodeURIComponent failed for:', filePath);
    return false;
  }
  if (CONTROL_CHAR_REGEX.test(filePath) || CONTROL_CHAR_REGEX.test(decodedPath)) {
    return false;
  }
  return !PATH_TRAVERSAL_REGEX.test(filePath) && !PATH_TRAVERSAL_REGEX.test(decodedPath);
};

/**
 * Navigation-only file opening supports relative paths like ../foo.ts and path:line.
 */
const isValidOpenFileTarget = (filePath: string): boolean => {
  if (!filePath) return false;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(filePath);
  } catch {
    console.debug('[bridge] isValidOpenFileTarget: decodeURIComponent failed for:', filePath);
    return false;
  }

  return !CONTROL_CHAR_REGEX.test(filePath) && !CONTROL_CHAR_REGEX.test(decodedPath);
};

const isValidFqcn = (className: string): boolean => {
  const trimmed = className?.trim();
  if (!trimmed || CONTROL_CHAR_REGEX.test(trimmed)) {
    return false;
  }

  return isJavaFqcnCandidate(trimmed);
};

const callBridge = (payload: string) => {
  if (window.sendToJava) {
    window.sendToJava(payload);
    return true;
  }
  // Track warned payloads to avoid spam, but don't log to console
  BRIDGE_UNAVAILABLE_WARNED.add(payload);
  return false;
};

export const sendBridgeEvent = (event: string, content = '') => {
  return callBridge(`${event}:${content}`);
};

export const resolveFilePath = (filePath?: string) => {
  if (!filePath) {
    return;
  }
  const normalizedPath = normalizeFileNavigationTarget(filePath);
  if (!normalizedPath || !isValidOpenFileTarget(normalizedPath)) {
    return;
  }
  sendBridgeEvent('resolve_file_path', normalizedPath);
};

export const openFile = (filePath?: string, lineStart?: number, lineEnd?: number) => {
  if (!filePath) {
    return;
  }
  const normalizedPath = normalizeFileNavigationTarget(filePath);
  if (!normalizedPath || !isValidOpenFileTarget(normalizedPath)) {
    return;
  }

  const parsedTarget = parseFileLinkTarget(normalizedPath);
  const pathOnly = parsedTarget?.path ?? normalizedPath;
  const resolvedLineStart = lineStart ?? parsedTarget?.lineStart;
  const resolvedLineEnd = lineEnd ?? parsedTarget?.lineEnd;

  let path = pathOnly;
  if (resolvedLineStart !== undefined && Number.isFinite(resolvedLineStart) && resolvedLineStart > 0) {
    path = (resolvedLineEnd !== undefined && Number.isFinite(resolvedLineEnd) && resolvedLineEnd > 0)
      ? `${pathOnly}:${resolvedLineStart}-${resolvedLineEnd}`
      : `${pathOnly}:${resolvedLineStart}`;
  }
  sendBridgeEvent('open_file', path);
};

export const openClass = (className?: string) => {
  const trimmed = className?.trim();
  if (!trimmed || !isValidFqcn(trimmed)) {
    return;
  }

  sendBridgeEvent('open_class', trimmed);
};

export const openBrowser = (url?: string) => {
  if (!url) {
    return;
  }
  // Defense-in-depth: only allow http, https, and mailto protocols.
  // file: and javascript: are explicitly rejected even though markdown
  // sanitization should strip them before they reach this point.
  if (!SAFE_BROWSER_PROTOCOLS.test(url)) {
    return;
  }
  sendBridgeEvent('open_browser', url);
};

/**
 * Open a URL in the OS default browser (outside the IDE's embedded JCEF
 * preview). Use for external docs whose SPA pages render blank inside JCEF.
 */
export const openBrowserExternal = (url?: string) => {
  if (!url) {
    return;
  }
  if (!SAFE_BROWSER_PROTOCOLS.test(url)) {
    return;
  }
  sendBridgeEvent('open_browser_external', url);
};

export const sendToJava = (message: string, payload: any = {}) => {
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
  sendBridgeEvent(message, payloadStr);
};

export const refreshFile = (filePath: string) => {
  if (!filePath) return;
  sendToJava('refresh_file', { filePath });
};

export const showDiff = (filePath: string, oldContent: string, newContent: string, title?: string) => {
  if (!isValidMutatingPath(filePath)) {
    return;
  }
  sendToJava('show_diff', { filePath, oldContent, newContent, title });
};

export const showMultiEditDiff = (
  filePath: string,
  edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }>,
  currentContent?: string
) => {
  if (!isValidMutatingPath(filePath)) {
    return;
  }
  sendToJava('show_multi_edit_diff', { filePath, edits, currentContent });
};

/**
 * Show editable diff view for a file
 * Opens IDEA's native diff view where user can selectively accept/reject changes
 * @param filePath - Absolute path to the file
 * @param operations - Array of edit operations
 * @param status - File status: 'A' (added) or 'M' (modified)
 */
export const showEditableDiff = (
  filePath: string,
  operations: Array<{ oldString: string; newString: string; replaceAll?: boolean }>,
  status: 'A' | 'M'
) => {
  // Security: Validate file path (defense-in-depth, backend also validates)
  if (!isValidMutatingPath(filePath)) {
    return;
  }
  sendToJava('show_editable_diff', { filePath, operations, status });
};

/**
 * Show edit preview diff (current content → after edit)
 * Used to preview the effect before executing edits
 * @param filePath - Absolute path to the file
 * @param edits - Array of edit operations to preview
 * @param title - Optional title for the diff view
 */
export const showEditPreviewDiff = (
  filePath: string,
  edits: Array<{ oldString: string; newString: string; replaceAll?: boolean }>,
  title?: string
) => {
  if (!isValidMutatingPath(filePath)) {
    return;
  }
  sendToJava('show_edit_preview_diff', { filePath, edits, title });
};

/**
 * Show edit full diff (original content → modified content)
 * Used to show complete file comparison before and after modification
 * @param filePath - Absolute path to the file
 * @param oldString - The original string that was replaced
 * @param newString - The new string that replaced the original
 * @param originalContent - Optional cached original file content (for full file diff)
 * @param replaceAll - Whether to replace all occurrences
 * @param title - Optional title for the diff view
 */
export const showEditFullDiff = (
  filePath: string,
  oldString: string,
  newString: string,
  originalContent?: string,
  replaceAll?: boolean,
  title?: string
) => {
  if (!isValidMutatingPath(filePath)) {
    return;
  }
  sendToJava('show_edit_full_diff', { filePath, oldString, newString, originalContent, replaceAll, title });
};

/**
 * Show interactive diff view with Apply/Reject buttons
 * Based on the official Claude Code JetBrains plugin implementation
 * @param filePath - Absolute path to the file
 * @param newFileContents - The proposed new content for the file
 * @param tabName - Optional name for the diff tab
 * @param isNewFile - Whether this is a new file (no original content)
 */
export const showInteractiveDiff = (
  filePath: string,
  newFileContents: string,
  tabName?: string,
  isNewFile?: boolean
) => {
  if (!isValidMutatingPath(filePath)) {
    return;
  }
  sendToJava('show_interactive_diff', { filePath, newFileContents, tabName, isNewFile: isNewFile ?? false });
};

/**
 * Rewind files to a specific user message state
 * @param sessionId - Session ID
 * @param userMessageId - User message UUID to rewind to
 */
export const rewindFiles = (sessionId: string, userMessageId: string) => {
  sendToJava('rewind_files', { sessionId, userMessageId });
};

/**
 * Undo changes for a single file
 * @param filePath - Absolute path to the file
 * @param status - File status: 'A' (added) or 'M' (modified)
 * @param operations - Array of edit operations to reverse
 */
export const undoFileChanges = (
  filePath: string,
  status: 'A' | 'M',
  operations: Array<{ oldString: string; newString: string; replaceAll?: boolean }>
) => {
  // Security: Validate file path (defense-in-depth, backend also validates)
  if (!isValidMutatingPath(filePath)) {
    return;
  }
  sendToJava('undo_file_changes', { filePath, status, operations });
};
