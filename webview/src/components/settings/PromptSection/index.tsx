import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { PromptConfig, PromptProvider, PromptScope } from '../../../types/prompt';
import { usePromptManagement } from '../hooks/usePromptManagement';
import { updateGlobalPromptsCache, updateProjectPromptsCache } from '../../ChatInputBox/providers';
import PromptScopeSection from './PromptScopeSection';
import PromptDialog from '../../PromptDialog';
import ConfirmDialog from '../../ConfirmDialog';
import PromptExportDialog from './PromptExportDialog';
import PromptImportConfirmDialog from './PromptImportConfirmDialog';
import styles from './style.module.less';

type PromptCallbackPayload = { provider: PromptProvider; prompts: PromptConfig[] };

interface PromptSectionProps {
  onSuccess?: (message: string) => void;
  currentProvider?: 'claude' | 'codex' | string;
}

function normalizePromptProvider(provider?: string | null): PromptProvider {
  return provider === 'codex' ? 'codex' : 'claude';
}

function parsePromptCallbackPayload(json: string, fallbackProvider: PromptProvider): PromptCallbackPayload | null {
  const parsed: unknown = JSON.parse(json);
  // Legacy payloads predate provider routing and belong to Claude by default.
  if (Array.isArray(parsed)) return { provider: 'claude', prompts: parsed as PromptConfig[] };
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as { provider?: unknown; prompts?: unknown };
  if (!Array.isArray(value.prompts)) return null;
  return {
    provider: normalizePromptProvider(typeof value.provider === 'string' ? value.provider : fallbackProvider),
    prompts: value.prompts as PromptConfig[],
  };
}

export default function PromptSection({
  onSuccess,
  currentProvider = 'claude',
}: PromptSectionProps) {
  const { t } = useTranslation();
  const promptProvider: PromptProvider = normalizePromptProvider(currentProvider);

  // Use prompt management hook
  const {
    globalPrompts,
    projectPrompts,
    projectInfo,
    promptsLoading,
    promptDialog,
    deletePromptConfirm,
    importPreviewDialog,
    exportDialog,
    loadAllPrompts,
    updateGlobalPrompts,
    updateProjectPrompts,
    updateProjectInfo,
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
    cleanupPromptsTimeout,
  } = usePromptManagement({ onSuccess, provider: promptProvider });

  // Load project info and prompts on mount
  useEffect(() => {
    // Load project info first
    if (window.sendToJava) {
      window.sendToJava('get_project_info:{}');
    }
    // Then load prompts
    loadAllPrompts();
    return () => cleanupPromptsTimeout();
  }, [loadAllPrompts, cleanupPromptsTimeout, promptProvider]);

  // Setup window callbacks
  useEffect(() => {
    // Save original callbacks to restore on unmount
    const originalUpdateGlobalPrompts = window.updateGlobalPrompts;
    const originalUpdateProjectPrompts = window.updateProjectPrompts;
    const originalUpdateProjectInfo = window.updateProjectInfo;
    const originalPromptOperationResult = window.promptOperationResult;
    const originalPromptImportPreviewResult = window.promptImportPreviewResult;
    const originalPromptImportResult = window.promptImportResult;

    // Chain our handlers with existing ones
    window.updateGlobalPrompts = (json: string) => {
      try {
        const payload = parsePromptCallbackPayload(json, promptProvider);
        if (!payload || payload.provider !== promptProvider) {
          originalUpdateGlobalPrompts?.(json);
          return;
        }
        const promptsList = payload.prompts;
        updateGlobalPrompts(promptsList);

        // ✅ Sync update promptProvider cache
        const promptItems = promptsList.map((prompt) => ({
          id: prompt.id,
          name: prompt.name,
          content: prompt.content,
          scope: 'global' as PromptScope,
          provider: promptProvider,
        }));
        updateGlobalPromptsCache(promptItems, promptProvider);
      } catch (error) {
        console.error('[PromptSection] Failed to parse global prompts:', error);
      }
      // Call original handler if exists
      originalUpdateGlobalPrompts?.(json);
    };

    window.updateProjectPrompts = (json: string) => {
      try {
        const payload = parsePromptCallbackPayload(json, promptProvider);
        if (!payload || payload.provider !== promptProvider) {
          originalUpdateProjectPrompts?.(json);
          return;
        }
        const promptsList = payload.prompts;
        updateProjectPrompts(promptsList);

        // ✅ Sync update promptProvider cache
        const promptItems = promptsList.map((prompt) => ({
          id: prompt.id,
          name: prompt.name,
          content: prompt.content,
          scope: 'project' as PromptScope,
          provider: promptProvider,
        }));
        updateProjectPromptsCache(promptItems, promptProvider);
      } catch (error) {
        console.error('[PromptSection] Failed to parse project prompts:', error);
      }
      // Call original handler if exists
      originalUpdateProjectPrompts?.(json);
    };

    window.updateProjectInfo = (json: string) => {
      try {
        const info = JSON.parse(json);
        updateProjectInfo(info);
      } catch (error) {
        console.error('[PromptSection] Failed to parse project info:', error);
      }
      // Call original handler if exists
      originalUpdateProjectInfo?.(json);
    };

    window.promptOperationResult = (json: string) => {
      try {
        const result = JSON.parse(json);
        handlePromptOperationResult(result);
      } catch (error) {
        console.error('[PromptSection] Failed to parse prompt operation result:', error);
      }
      // Call original handler if exists
      originalPromptOperationResult?.(json);
    };

    window.promptImportPreviewResult = (json: string) => {
      try {
        const previewData = JSON.parse(json);
        handlePromptImportPreviewResult(previewData);
      } catch (error) {
        console.error('[PromptSection] Failed to parse prompt import preview result:', error);
      }
      // Call original handler if exists
      originalPromptImportPreviewResult?.(json);
    };

    window.promptImportResult = (json: string) => {
      try {
        const result = JSON.parse(json);
        handlePromptImportResult(result);
      } catch (error) {
        console.error('[PromptSection] Failed to parse prompt import result:', error);
      }
      // Call original handler if exists
      originalPromptImportResult?.(json);
    };

    return () => {
      // Restore original callbacks instead of deleting them
      // This ensures other components (like promptProvider) continue to receive updates
      window.updateGlobalPrompts = originalUpdateGlobalPrompts;
      window.updateProjectPrompts = originalUpdateProjectPrompts;
      window.updateProjectInfo = originalUpdateProjectInfo;
      window.promptOperationResult = originalPromptOperationResult;
      window.promptImportPreviewResult = originalPromptImportPreviewResult;
      window.promptImportResult = originalPromptImportResult;
    };
  }, [
    updateGlobalPrompts,
    updateProjectPrompts,
    updateProjectInfo,
    handlePromptOperationResult,
    handlePromptImportPreviewResult,
    handlePromptImportResult,
    promptProvider,
  ]);

  // Get all prompts for export dialog (combining global and project based on export scope)
  const getPromptsForExport = (scope: PromptScope) => {
    return scope === 'global' ? globalPrompts : projectPrompts;
  };

  return (
    <div className={styles.promptLibrary}>
      <h3>{t('settings.prompt.title')}</h3>
      <p className={styles.description}>{t('settings.prompt.description')}</p>

      {/* Global Prompts Section */}
      <PromptScopeSection
        title={t('settings.prompt.global')}
        scope="global"
        prompts={globalPrompts}
        loading={promptsLoading}
        onAdd={() => handleAddPrompt('global')}
        onEdit={(prompt) => handleEditPrompt(prompt, 'global')}
        onDelete={(prompt) => handleDeletePrompt(prompt, 'global')}
        onExport={() => handleExportPrompts('global')}
        onImport={() => handleImportPromptsFile('global')}
      />

      {/* Project Prompts Section */}
      {projectInfo?.available ? (
        <PromptScopeSection
          title={t('settings.prompt.projectScope', { projectName: projectInfo.name })}
          scope="project"
          prompts={projectPrompts}
          loading={promptsLoading}
          onAdd={() => handleAddPrompt('project')}
          onEdit={(prompt) => handleEditPrompt(prompt, 'project')}
          onDelete={(prompt) => handleDeletePrompt(prompt, 'project')}
          onExport={() => handleExportPrompts('project')}
          onImport={() => handleImportPromptsFile('project')}
        />
      ) : (
        <div className={styles.noProject}>
          <p>{t('settings.prompt.noProject')}</p>
        </div>
      )}

      {/* Prompt add/edit dialog */}
      <PromptDialog
        isOpen={promptDialog.isOpen}
        prompt={promptDialog.prompt}
        onClose={handleClosePromptDialog}
        onSave={handleSavePrompt}
      />

      {/* Prompt delete confirmation dialog */}
      <ConfirmDialog
        isOpen={deletePromptConfirm.isOpen}
        title={t('settings.prompt.deleteConfirmTitle')}
        message={t('settings.prompt.deleteConfirmMessage', { name: deletePromptConfirm.prompt?.name || '' })}
        confirmText={t('common.delete')}
        cancelText={t('common.cancel')}
        onConfirm={confirmDeletePrompt}
        onCancel={cancelDeletePrompt}
      />

      {/* Prompt export dialog */}
      {exportDialog.isOpen && (
        <PromptExportDialog
          prompts={getPromptsForExport(exportDialog.scope)}
          onConfirm={handleConfirmExport}
          onCancel={handleCloseExportDialog}
        />
      )}

      {/* Prompt import preview dialog */}
      {importPreviewDialog.isOpen && importPreviewDialog.previewData && (
        <PromptImportConfirmDialog
          previewData={importPreviewDialog.previewData}
          onConfirm={(selectedIds, strategy) => handleSaveImportedPrompts(selectedIds, strategy, importPreviewDialog.scope)}
          onCancel={handleCloseImportPreview}
        />
      )}
    </div>
  );
}
