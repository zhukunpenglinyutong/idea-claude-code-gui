import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { ClaudeMessage, ToolResultBlock } from '../types';
import { debugLog } from '../utils/debug';

export interface UseFileChangesManagementOptions {
  currentSessionId: string | null;
  currentSessionIdRef: RefObject<string | null>;
  messages: ClaudeMessage[];
  getContentBlocks: (message: ClaudeMessage) => any[];
  findToolResult: (toolUseId?: string, messageIndex?: number) => ToolResultBlock | null;
}

export interface FileChange {
  filePath: string;
  [key: string]: any;
}

/**
 * Manages file change tracking: processedFiles, baseMessageIndex,
 * undo/discard/keep handlers, diff result callbacks, and session state restore.
 */
export function useFileChangesManagement({
  currentSessionId,
  currentSessionIdRef,
  messages,
}: UseFileChangesManagementOptions) {
  // List of processed file paths (filtered from fileChanges after Apply/Reject, persisted to localStorage)
  const [processedFiles, setProcessedFiles] = useState<string[]>([]);
  // Base message index (for Keep All feature, only counts changes after this index)
  const [baseMessageIndex, setBaseMessageIndex] = useState(0);

  // Ref to always hold the latest messages array, avoiding stale closure issues
  // in handleKeepAll when messages.length changes between renders.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  // Callback after file undo success (triggered from StatusPanel)
  const handleUndoFile = useCallback((filePath: string) => {
    setProcessedFiles(prev => {
      if (prev.includes(filePath)) return prev;
      const newList = [...prev, filePath];

      // Persist to localStorage
      if (currentSessionId) {
        try {
          localStorage.setItem(
            `processed-files-${currentSessionId}`,
            JSON.stringify(newList)
          );
        } catch (e) {
          console.error('Failed to persist processed files:', e);
        }
      }

      return newList;
    });
  }, [currentSessionId]);

  // Helper to add a file to the processed list with localStorage persistence
  const addFileToProcessed = useCallback((filePath: string) => {
    setProcessedFiles(prev => {
      if (prev.includes(filePath)) return prev;
      const newList = [...prev, filePath];

      const sessionId = currentSessionIdRef.current;
      if (sessionId) {
        try {
          localStorage.setItem(
            `processed-files-${sessionId}`,
            JSON.stringify(newList)
          );
        } catch (e) {
          console.error('Failed to persist processed files:', e);
        }
      }

      return newList;
    });
  }, [currentSessionIdRef]);

  // Callback after batch undo success (Discard All)
  const handleDiscardAll = useCallback((filteredFileChanges: FileChange[]) => {
    setProcessedFiles(prev => {
      const filesToAdd = filteredFileChanges.map(fc => fc.filePath);
      const newList = [...prev, ...filesToAdd.filter(f => !prev.includes(f))];

      if (currentSessionId) {
        try {
          localStorage.setItem(
            `processed-files-${currentSessionId}`,
            JSON.stringify(newList)
          );
        } catch (e) {
          console.error('Failed to persist processed files:', e);
        }
      }

      return newList;
    });
  }, [currentSessionId]);

  // Callback for Keep All - set current changes as the new baseline
  const handleKeepAll = useCallback(() => {
    // Use ref to get the latest messages.length, avoiding stale closure issues
    const newBaseIndex = messagesRef.current.length;
    setBaseMessageIndex(newBaseIndex);
    setProcessedFiles([]);

    if (currentSessionId) {
      try {
        localStorage.setItem(`keep-all-base-${currentSessionId}`, String(newBaseIndex));
        localStorage.removeItem(`processed-files-${currentSessionId}`);
      } catch (e) {
        console.error('Failed to persist Keep All state:', e);
      }
    }
  }, [currentSessionId]);

  // Register window callbacks for editable diff operations from Java backend
  useEffect(() => {
    // Handle remove file from edits list (legacy callback)
    window.handleRemoveFileFromEdits = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        const filePath = data.filePath;
        if (filePath) {
          addFileToProcessed(filePath);
        }
      } catch {
        // JSON parse failed, ignore
      }
    };

    // Handle interactive diff result (Apply/Reject from the new interactive diff view)
    window.handleDiffResult = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        const { filePath, action, error } = data;

        if (error) {
          console.error('[InteractiveDiff] Error:', error);
          return;
        }

        if (action === 'APPLY' || action === 'REJECT') {
          addFileToProcessed(filePath);
          debugLog(`[InteractiveDiff] ${action} changes to:`, filePath);
        }
      } catch {
        // JSON parse failed, ignore
      }
    };

    return () => {
      delete window.handleRemoveFileFromEdits;
      delete window.handleDiffResult;
    };
  }, [addFileToProcessed]);

  // Restore/reset state on session switch
  useEffect(() => {
    setProcessedFiles([]);

    if (!currentSessionId) {
      setBaseMessageIndex(0);
      return;
    }

    // Cleanup old localStorage entries to prevent infinite growth
    const MAX_STORED_SESSIONS = 50;
    try {
      const keysToCheck = Object.keys(localStorage)
        .filter(k => k.startsWith('processed-files-') || k.startsWith('keep-all-base-'));
      if (keysToCheck.length > MAX_STORED_SESSIONS) {
        const toRemove = keysToCheck.slice(0, keysToCheck.length - MAX_STORED_SESSIONS);
        toRemove.forEach(k => localStorage.removeItem(k));
      }
    } catch {
      // Ignore cleanup errors
    }

    // Restore processed files from localStorage
    try {
      const savedProcessedFiles = localStorage.getItem(
        `processed-files-${currentSessionId}`
      );
      if (savedProcessedFiles) {
        const files = JSON.parse(savedProcessedFiles);
        if (Array.isArray(files)) {
          setProcessedFiles(files);
        }
      }
    } catch (e) {
      console.error('Failed to load processed files:', e);
    }

    // Restore Keep All base index
    try {
      const savedBaseIndex = localStorage.getItem(`keep-all-base-${currentSessionId}`);
      if (savedBaseIndex) {
        const index = parseInt(savedBaseIndex, 10);
        if (!isNaN(index) && index >= 0) {
          setBaseMessageIndex(index);
          return;
        }
      }
    } catch (e) {
      console.error('Failed to load Keep All state:', e);
    }

    setBaseMessageIndex(0);
  }, [currentSessionId]);

  return {
    processedFiles,
    baseMessageIndex,
    handleUndoFile,
    handleDiscardAll,
    handleKeepAll,
  };
}
