import { useState, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PromptConfig,
  PromptProvider,
  PromptScope,
  GetPromptsMessage,
  AddPromptMessage,
  UpdatePromptMessage,
  DeletePromptMessage,
  ExportPromptsMessage,
  ImportPromptsFileMessage,
  SaveImportedPromptsMessage,
  ProjectInfo
} from '../../../types/prompt';
import type { ImportPreviewResult, ConflictStrategy } from '../../../types/import';

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
  // Silently ignore when sendToJava is unavailable to avoid log pollution in production
};

export interface PromptDialogState {
  isOpen: boolean;
  prompt: PromptConfig | null;
  scope: PromptScope;
}

export interface DeletePromptConfirmState {
  isOpen: boolean;
  prompt: PromptConfig | null;
  scope: PromptScope;
}

export interface ImportPreviewDialogState {
  isOpen: boolean;
  previewData: ImportPreviewResult<PromptConfig> | null;
  scope: PromptScope;
}

export interface ExportDialogState {
  isOpen: boolean;
  scope: PromptScope;
}

export interface UsePromptManagementOptions {
  onError?: (message: string) => void;
  onSuccess?: (message: string) => void;
  provider?: PromptProvider;
}

export function usePromptManagement(options: UsePromptManagementOptions = {}) {
  const { onSuccess, onError, provider = 'claude' } = options;
  const { t } = useTranslation();

  // Timeout timer reference (using useRef to avoid global variable pollution)
  const promptsLoadingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track current import scope (used when import preview result arrives)
  const currentImportScopeRef = useRef<PromptScope>('global');

  // Prompt list state - dual lists for global and project scopes
  const [globalPrompts, setGlobalPrompts] = useState<PromptConfig[]>([]);
  const [projectPrompts, setProjectPrompts] = useState<PromptConfig[]>([]);
  const [projectInfo, setProjectInfo] = useState<ProjectInfo | null>(null);
  const [promptsLoading, setPromptsLoading] = useState(false);

  // Prompt dialog state
  const [promptDialog, setPromptDialog] = useState<PromptDialogState>({
    isOpen: false,
    prompt: null,
    scope: 'global',
  });

  // Prompt delete confirmation state
  const [deletePromptConfirm, setDeletePromptConfirm] = useState<DeletePromptConfirmState>({
    isOpen: false,
    prompt: null,
    scope: 'global',
  });

  // Import preview dialog state
  const [importPreviewDialog, setImportPreviewDialog] = useState<ImportPreviewDialogState>({
    isOpen: false,
    previewData: null,
    scope: 'global',
  });

  // Export dialog state
  const [exportDialog, setExportDialog] = useState<ExportDialogState>({
    isOpen: false,
    scope: 'global',
  });

  // Load prompt list (with timeout protection, no retries)
  const loadPrompts = useCallback((scope: PromptScope) => {
    const TIMEOUT = 2000; // 2-second timeout

    setPromptsLoading(true);
    const message: GetPromptsMessage = { scope, provider };
    sendToJava(`get_prompts:${JSON.stringify(message)}`);

    // Set up timeout timer - show empty list after timeout
    const timeoutId = setTimeout(() => {
      // Stop loading after timeout, show empty list
      setPromptsLoading(false);
      // Don't clear the list, preserve any existing data
    }, TIMEOUT);

    // Store timeout ID in ref
    promptsLoadingTimeoutRef.current = timeoutId;
  }, [provider]);

  // Convenience functions for loading prompts
  const loadGlobalPrompts = useCallback(() => loadPrompts('global'), [loadPrompts]);
  const loadProjectPrompts = useCallback(() => loadPrompts('project'), [loadPrompts]);
  const loadAllPrompts = useCallback(() => {
    loadGlobalPrompts();
    loadProjectPrompts();
  }, [loadGlobalPrompts, loadProjectPrompts]);

  // Update global prompts list (used by window callback)
  const updateGlobalPrompts = useCallback((promptsList: PromptConfig[]) => {
    // Clear timeout timer
    if (promptsLoadingTimeoutRef.current) {
      clearTimeout(promptsLoadingTimeoutRef.current);
      promptsLoadingTimeoutRef.current = null;
    }

    setGlobalPrompts(promptsList);
    setPromptsLoading(false);
  }, []);

  // Update project prompts list (used by window callback)
  const updateProjectPrompts = useCallback((promptsList: PromptConfig[]) => {
    // Clear timeout timer
    if (promptsLoadingTimeoutRef.current) {
      clearTimeout(promptsLoadingTimeoutRef.current);
      promptsLoadingTimeoutRef.current = null;
    }

    setProjectPrompts(promptsList);
    setPromptsLoading(false);
  }, []);

  // Update project info (used by window callback)
  const updateProjectInfo = useCallback((info: ProjectInfo | null) => {
    setProjectInfo(info);
  }, []);

  // Clean up timeout timer
  const cleanupPromptsTimeout = useCallback(() => {
    if (promptsLoadingTimeoutRef.current) {
      clearTimeout(promptsLoadingTimeoutRef.current);
      promptsLoadingTimeoutRef.current = null;
    }
  }, []);

  // Open add prompt dialog
  const handleAddPrompt = useCallback((scope: PromptScope) => {
    setPromptDialog({ isOpen: true, prompt: null, scope });
  }, []);

  // Open edit prompt dialog
  const handleEditPrompt = useCallback((prompt: PromptConfig, scope: PromptScope) => {
    setPromptDialog({ isOpen: true, prompt, scope });
  }, []);

  // Close prompt dialog
  const handleClosePromptDialog = useCallback(() => {
    setPromptDialog({ isOpen: false, prompt: null, scope: 'global' });
  }, []);

  // Delete prompt
  const handleDeletePrompt = useCallback((prompt: PromptConfig, scope: PromptScope) => {
    setDeletePromptConfirm({ isOpen: true, prompt, scope });
  }, []);

  // Save prompt
  const handleSavePrompt = useCallback(
    (data: { name: string; content: string }) => {
      const isAdding = !promptDialog.prompt;
      const scope = promptDialog.scope;

      if (isAdding) {
        // Add new prompt
        const message: AddPromptMessage = {
          scope,
          provider,
          prompt: {
            id: crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(),
            name: data.name,
            content: data.content,
            provider,
            createdAt: Date.now(),
          },
        };
        sendToJava(`add_prompt:${JSON.stringify(message)}`);
      } else if (promptDialog.prompt) {
        // Update existing prompt
        const message: UpdatePromptMessage = {
          scope,
          provider,
          id: promptDialog.prompt.id,
          updates: {
            name: data.name,
            content: data.content,
            provider,
            updatedAt: Date.now(),
          },
        };
        sendToJava(`update_prompt:${JSON.stringify(message)}`);
      }

      setPromptDialog({ isOpen: false, prompt: null, scope: 'global' });
      // Reload list after prompt operation (with timeout protection)
      loadPrompts(scope);
    },
    [promptDialog, loadPrompts, provider]
  );

  // Confirm prompt deletion
  const confirmDeletePrompt = useCallback(() => {
    const prompt = deletePromptConfirm.prompt;
    const scope = deletePromptConfirm.scope;
    if (!prompt) return;

    const message: DeletePromptMessage = {
      scope,
      provider,
      id: prompt.id,
    };
    sendToJava(`delete_prompt:${JSON.stringify(message)}`);
    setDeletePromptConfirm({ isOpen: false, prompt: null, scope: 'global' });
    // Reload list after deletion (with timeout protection)
    loadPrompts(scope);
  }, [deletePromptConfirm, loadPrompts, provider]);

  // Cancel prompt deletion
  const cancelDeletePrompt = useCallback(() => {
    setDeletePromptConfirm({ isOpen: false, prompt: null, scope: 'global' });
  }, []);

  // Handle prompt operation result (used by window callback)
  const handlePromptOperationResult = useCallback(
    (result: { success: boolean; operation?: string; error?: string }) => {
      if (result.success) {
        const operationMessages: Record<string, string> = {
          add: t('settings.prompt.addSuccess'),
          update: t('settings.prompt.updateSuccess'),
          delete: t('settings.prompt.deleteSuccess'),
        };
        onSuccess?.(operationMessages[result.operation || ''] || t('settings.prompt.operationSuccess'));
      } else {
        onError?.(result.error || t('settings.prompt.operationFailed'));
      }
    },
    [onSuccess, onError, t]
  );

  // Open export dialog
  const handleExportPrompts = useCallback((scope: PromptScope) => {
    setExportDialog({ isOpen: true, scope });
  }, []);

  // Close export dialog
  const handleCloseExportDialog = useCallback(() => {
    setExportDialog({ isOpen: false, scope: 'global' });
  }, []);

  // Confirm export with selected IDs
  const handleConfirmExport = useCallback((selectedIds: string[]) => {
    const scope = exportDialog.scope;
    const message: ExportPromptsMessage = {
      scope,
      provider,
      promptIds: selectedIds,
    };
    sendToJava(`export_prompts:${JSON.stringify(message)}`);
    setExportDialog({ isOpen: false, scope: 'global' });
  }, [exportDialog.scope, provider]);

  // Import prompts from file
  const handleImportPromptsFile = useCallback((scope: PromptScope) => {
    currentImportScopeRef.current = scope;
    const message: ImportPromptsFileMessage = { scope, provider };
    sendToJava(`import_prompts_file:${JSON.stringify(message)}`);
  }, [provider]);

  // Handle import preview result (used by window callback)
  const handlePromptImportPreviewResult = useCallback(
    (previewData: ImportPreviewResult<PromptConfig>) => {
      setImportPreviewDialog({
        isOpen: true,
        previewData,
        scope: currentImportScopeRef.current,
      });
    },
    []
  );

  // Close import preview dialog
  const handleCloseImportPreview = useCallback(() => {
    setImportPreviewDialog({
      isOpen: false,
      previewData: null,
      scope: 'global',
    });
  }, []);

  // Save imported prompts
  const handleSaveImportedPrompts = useCallback(
    (selectedIds: string[], strategy: ConflictStrategy, scope: PromptScope) => {
      if (!importPreviewDialog.previewData) return;

      const selectedPrompts = importPreviewDialog.previewData.items
        .filter(item => selectedIds.includes(item.data.id))
        .map(item => item.data);

      const message: SaveImportedPromptsMessage = {
        scope,
        provider,
        prompts: selectedPrompts,
        strategy,
      };

      sendToJava(`save_imported_prompts:${JSON.stringify(message)}`);
      setImportPreviewDialog({ isOpen: false, previewData: null, scope: 'global' });
    },
    [importPreviewDialog.previewData, provider]
  );

  // Handle import result (used by window callback)
  const handlePromptImportResult = useCallback(
    (result: { success: boolean; imported: number; updated: number; skipped: number; scope: PromptScope; error?: string }) => {
      if (result.success) {
        const message = t('settings.prompt.importDialog.importPartialSuccess', {
          imported: result.imported,
          updated: result.updated,
          skipped: result.skipped,
        });
        onSuccess?.(message);
      }

      // Reload prompts list for the affected scope
      loadPrompts(result.scope);
    },
    [onSuccess, t, loadPrompts]
  );

  return {
    // State
    globalPrompts,
    projectPrompts,
    projectInfo,
    promptsLoading,
    promptDialog,
    deletePromptConfirm,
    importPreviewDialog,
    exportDialog,

    // Methods
    loadPrompts,
    loadGlobalPrompts,
    loadProjectPrompts,
    loadAllPrompts,
    updateGlobalPrompts,
    updateProjectPrompts,
    updateProjectInfo,
    cleanupPromptsTimeout,
    handleAddPrompt,
    handleEditPrompt,
    handleClosePromptDialog,
    handleDeletePrompt,
    handleSavePrompt,
    confirmDeletePrompt,
    cancelDeletePrompt,
    handlePromptOperationResult,
    handleExportPrompts,
    handleCloseExportDialog,
    handleConfirmExport,
    handleImportPromptsFile,
    handlePromptImportPreviewResult,
    handleCloseImportPreview,
    handleSaveImportedPrompts,
    handlePromptImportResult,

    // Setter
    setPromptsLoading,
  };
}

export type UsePromptManagementReturn = ReturnType<typeof usePromptManagement>;
