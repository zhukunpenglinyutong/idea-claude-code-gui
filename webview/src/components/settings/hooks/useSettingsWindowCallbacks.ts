// hooks/useSettingsWindowCallbacks.ts
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProviderConfig, CodexProviderConfig } from '../../../types/provider';
import type { AgentConfig } from '../../../types/agent';
import type { PromptConfig } from '../../../types/prompt';
import type { CommitAiConfig } from '../../../types/aiFeatureConfig';
import { normalizeAiFeatureConfig, DEFAULT_COMMIT_AI_CONFIG } from '../../../types/aiFeatureConfig';
import type { UiFontConfig, CodeFontConfig } from './useSettingsBasicActions';
import type { PromptEnhancerConfig } from '../../../types/promptEnhancer';
import { normalizePromptEnhancerConfig } from '../../../types/promptEnhancer';
import type { AlertType } from '../../AlertDialog';
import type { ToastMessage } from '../../Toast';
import {
  subscribeActiveCodexProvider,
  subscribeActiveProvider,
  subscribeCodexProviderList,
  subscribeProviderList,
} from '../../../utils/runtimeProviderCapabilities';
import { scheduleBatchedBridgeRequests } from './scheduleBatchedBridgeRequests';

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
};

/**
 * Settings bootstrap bridge messages, ordered by first-paint priority.
 * Batched on open so CEF/Java is not hit with ~20 messages in one frame.
 */
export const SETTINGS_BOOTSTRAP_BRIDGE_MESSAGES = [
  // Environment + permissions (visible / used early on basic tab)
  'get_node_path:',
  'get_claude_cli_path:',
  'get_codex_cli_path:',
  'get_working_directory:',
  'get_streaming_enabled:',
  'get_codex_sandbox_mode:',
  'get_permission_dialog_timeout:',
  // Appearance fonts
  'get_editor_font_config:',
  'get_ui_font_config:',
  'get_code_font_config:',
  // Behavior / feature toggles (basic tab sub-views)
  'get_sound_notification_config:',
  'get_commit_generation_enabled:',
  'get_ai_title_generation_enabled:',
  'get_status_bar_widget_enabled:',
  'get_task_completion_notification_enabled:',
  'get_ask_user_question_notification_enabled:',
  'get_system_notification_only_when_unfocused:',
  'get_ask_user_question_sound_notification_enabled:',
  // NOTE: commit prompt / commit AI / prompt-enhancer configs are intentionally
  // NOT bootstrapped here. Their handlers probe CLI availability (spawn processes)
  // on the JCEF UI thread and freeze Settings until complete. Load on tab open.
] as const;

export interface SettingsWindowCallbacksDeps {
  // State setters
  setNodePath: (path: string) => void;
  setNodeVersion: (version: string | null) => void;
  setMinNodeVersion: (version: number) => void;
  setSavingNodePath: (saving: boolean) => void;
  setClaudeCliPath: (path: string) => void;
  setSavingClaudeCliPath: (saving: boolean) => void;
  setCodexCliPath: (path: string) => void;
  setSavingCodexCliPath: (saving: boolean) => void;
  setWorkingDirectory: (dir: string) => void;
  setSavingWorkingDirectory: (saving: boolean) => void;
  setCommitPrompt: (prompt: string) => void;
  setSavingCommitPrompt: (saving: boolean) => void;
  setCommitAiConfig: (config: CommitAiConfig) => void;
  setPromptEnhancerConfig: (config: PromptEnhancerConfig) => void;
  setProjectCommitPrompt: (prompt: string) => void;
  setSavingProjectCommitPrompt: (saving: boolean) => void;
  setEditorFontConfig: (config: { fontFamily: string; fontSize: number; lineSpacing: number } | undefined) => void;
  setUiFontConfig: (config: UiFontConfig | undefined) => void;
  setCodeFontConfig: (config: CodeFontConfig | undefined) => void;
  setIdeTheme: (theme: 'light' | 'dark' | null) => void;
  setLocalStreamingEnabled: (enabled: boolean) => void;
  setCodexSandboxMode?: (mode: 'workspace-write' | 'danger-full-access') => void;
  setLocalSendShortcut: (shortcut: 'enter' | 'cmdEnter') => void;
  setLoading: (loading: boolean) => void;
  setCodexLoading: (loading: boolean) => void;
  setCodexConfigLoading: (loading: boolean) => void;
  // AI feature toggle setters
  setCommitGenerationEnabled?: (enabled: boolean) => void;
  setAiTitleGenerationEnabled?: (enabled: boolean) => void;
  setStatusBarWidgetEnabled?: (enabled: boolean) => void;
  setTaskCompletionNotificationEnabled?: (enabled: boolean) => void;
  setAskUserQuestionNotificationEnabled?: (enabled: boolean) => void;
  setSystemNotificationOnlyWhenUnfocused?: (enabled: boolean) => void;
  setAskUserQuestionSoundNotificationEnabled?: (enabled: boolean) => void;
  // Sound notification setters
  setSoundNotificationEnabled?: (enabled: boolean) => void;
  setSoundOnlyWhenUnfocused?: (enabled: boolean) => void;
  setSelectedSound?: (soundId: string) => void;
  setCustomSoundPath?: (path: string) => void;

  // Hook functions
  updateProviders: (providers: ProviderConfig[]) => void;
  updateActiveProvider: (provider: ProviderConfig) => void;
  loadProviders: () => void;
  loadCodexProviders: () => void;
  loadAgents: () => void;
  updateAgents: (agents: AgentConfig[]) => void;
  handleAgentOperationResult: (result: any) => void;
  handleAgentImportPreviewResult: (previewData: any) => void;
  handleAgentImportResult: (result: any) => void;
  updateCodexProviders: (providers: CodexProviderConfig[]) => void;
  updateActiveCodexProvider: (provider: CodexProviderConfig) => void;
  updateCurrentCodexConfig: (config: any) => void;
  cleanupAgentsTimeout: () => void;

  // Prompt-related handlers (optional - now handled by PromptSection component)
  loadPrompts?: () => void;
  updatePrompts?: (prompts: PromptConfig[]) => void;
  handlePromptOperationResult?: (result: any) => void;
  handlePromptImportPreviewResult?: (previewData: any) => void;
  handlePromptImportResult?: (result: any) => void;
  cleanupPromptsTimeout?: () => void;

  // Callbacks
  showAlert: (type: AlertType, title: string, message: string) => void;
  addToast: (message: string, type?: ToastMessage['type']) => void;

  // Props
  onStreamingEnabledChangeProp?: (enabled: boolean) => void;
  onSendShortcutChangeProp?: (shortcut: 'enter' | 'cmdEnter') => void;
}

/**
 * Registers window callbacks for Java bridge communication in settings view.
 * Handles provider, agent, prompt, config, and theme callbacks.
 */
export function useSettingsWindowCallbacks(deps: SettingsWindowCallbacksDeps) {
  const { t } = useTranslation();

  // Use ref to avoid stale closures - callbacks always read latest deps
  const depsRef = useRef(deps);
  depsRef.current = deps;

  useEffect(() => {
    const d = () => depsRef.current;

    // Provider callbacks - subscribe to the registry instead of overriding
    // window callbacks directly. This keeps behavior deterministic when
    // multiple consumers (e.g. RuntimeProviderSelect) are mounted.
    const unsubscribeProviders = subscribeProviderList((jsonStr: string) => {
      try {
        const providersList: ProviderConfig[] = JSON.parse(jsonStr);
        d().updateProviders(providersList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse providers:', error);
        d().setLoading(false);
      }
    });

    const unsubscribeActiveProvider = subscribeActiveProvider((jsonStr: string) => {
      try {
        const activeProvider: ProviderConfig = JSON.parse(jsonStr);
        if (activeProvider) {
          d().updateActiveProvider(activeProvider);
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse active provider:', error);
      }
    });

    window.showError = (message: string) => {
      d().showAlert('error', t('toast.operationFailed'), message);
      d().setLoading(false);
      d().setSavingNodePath(false);
      d().setSavingClaudeCliPath(false);
      d().setSavingCodexCliPath(false);
      d().setSavingWorkingDirectory(false);
      d().setSavingCommitPrompt(false);
      d().setSavingProjectCommitPrompt(false);
    };

    window.showSwitchSuccess = (message: string) => {
      d().showAlert('success', t('toast.switchSuccess'), message);
    };

    window.updateNodePath = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setNodePath(data.path || '');
        d().setNodeVersion(data.version || null);
        if (data.minVersion) {
          d().setMinNodeVersion(data.minVersion);
        }
      } catch (e) {
        console.warn('[SettingsView] Failed to parse updateNodePath JSON, fallback to legacy format:', e);
        d().setNodePath(jsonStr || '');
      }
      d().setSavingNodePath(false);
      window.dispatchEvent(new CustomEvent('nodePathReady'));
    };

    window.updateClaudeCliPath = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setClaudeCliPath(data.path || '');
      } catch (e) {
        console.warn('[SettingsView] Failed to parse updateClaudeCliPath JSON, fallback to legacy format:', e);
        d().setClaudeCliPath(jsonStr || '');
      }
      d().setSavingClaudeCliPath(false);
    };

    window.updateCodexCliPath = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setCodexCliPath(data.path || '');
      } catch (e) {
        console.warn('[SettingsView] Failed to parse updateCodexCliPath JSON, fallback to legacy format:', e);
        d().setCodexCliPath(jsonStr || '');
      }
      d().setSavingCodexCliPath(false);
    };

    window.updateWorkingDirectory = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setWorkingDirectory(data.customWorkingDir || '');
        d().setSavingWorkingDirectory(false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse working directory:', error);
        d().setSavingWorkingDirectory(false);
      }
    };

    window.showSuccess = (message: string) => {
      d().showAlert('success', t('toast.operationSuccess'), message);
      d().setSavingNodePath(false);
      d().setSavingClaudeCliPath(false);
      d().setSavingWorkingDirectory(false);
    };

    window.showSuccessI18n = (i18nKey: string) => {
      const message = t(i18nKey);
      d().addToast(message, 'success');
    };

    window.onEditorFontConfigReceived = (jsonStr: string) => {
      try {
        const config = JSON.parse(jsonStr);
        d().setEditorFontConfig(config);
      } catch (error) {
        console.error('[SettingsView] Failed to parse editor font config:', error);
      }
    };

    window.onUiFontConfigReceived = (jsonStr: string) => {
      try {
        const config = JSON.parse(jsonStr);
        d().setUiFontConfig(config);
        window.applyUiFontConfig?.(config);
      } catch {
        // Silently ignore malformed UI font config from backend
      }
    };

    window.onCodeFontConfigReceived = (jsonStr: string) => {
      try {
        const config = JSON.parse(jsonStr);
        d().setCodeFontConfig(config);
        window.applyCodeFontConfig?.(config);
      } catch {
        // Silently ignore malformed code font config from backend
      }
    };

    // IDE theme callback
    const previousOnIdeThemeReceived = window.onIdeThemeReceived;
    window.onIdeThemeReceived = (jsonStr: string) => {
      try {
        const themeData = JSON.parse(jsonStr);
        const theme = themeData.isDark ? 'dark' : 'light';
        d().setIdeTheme(theme);
        previousOnIdeThemeReceived?.(jsonStr);
      } catch (error) {
        console.error('[SettingsView] Failed to parse IDE theme:', error);
      }
    };

    // Streaming configuration callback
    const previousUpdateStreamingEnabled = window.updateStreamingEnabled;
    if (!d().onStreamingEnabledChangeProp) {
      window.updateStreamingEnabled = (jsonStr: string) => {
        try {
          const data = JSON.parse(jsonStr);
          d().setLocalStreamingEnabled(data.streamingEnabled ?? true);
        } catch (error) {
          console.error('[SettingsView] Failed to parse streaming config:', error);
        }
      };
    }

    // Codex sandbox mode callback
    window.updateCodexSandboxMode = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        const mode = data?.sandboxMode;
        if (mode === 'workspace-write' || mode === 'danger-full-access') {
          d().setCodexSandboxMode?.(mode);
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse Codex sandbox mode config:', error);
      }
    };

    // Send shortcut configuration callback
    const previousUpdateSendShortcut = window.updateSendShortcut;
    if (!d().onSendShortcutChangeProp) {
      window.updateSendShortcut = (jsonStr: string) => {
        try {
          const data = JSON.parse(jsonStr);
          d().setLocalSendShortcut(data.sendShortcut ?? 'enter');
        } catch (error) {
          console.error('[SettingsView] Failed to parse send shortcut config:', error);
        }
      };
    }

    // Commit AI prompt callback
    window.updateCommitPrompt = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setCommitPrompt(data.commitPrompt || '');
        d().setSavingCommitPrompt(false);
        if (data.projectCommitPrompt !== undefined) {
          d().setProjectCommitPrompt(data.projectCommitPrompt || '');
        }
        if (data.saved) {
          d().addToast(t('toast.saveSuccess'), 'success');
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse commit prompt:', error);
        d().setSavingCommitPrompt(false);
        d().addToast(t('toast.saveFailed'), 'error');
      }
    };

    window.updatePromptEnhancerConfig = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setPromptEnhancerConfig(normalizePromptEnhancerConfig(data));
      } catch (error) {
        console.error('[SettingsView] Failed to parse prompt enhancer config:', error);
      }
    };

    window.updateCommitAiConfig = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setCommitAiConfig(normalizeAiFeatureConfig(data, DEFAULT_COMMIT_AI_CONFIG));
      } catch (error) {
        console.error('[SettingsView] Failed to parse commit AI config:', error);
      }
    };

    // Project-level commit AI prompt callback
    window.updateProjectCommitPrompt = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setProjectCommitPrompt(data.projectCommitPrompt || '');
        d().setSavingProjectCommitPrompt(false);
        if (data.saved) {
          d().addToast(t('toast.saveSuccess'), 'success');
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse project commit prompt:', error);
        d().setSavingProjectCommitPrompt(false);
        d().addToast(t('toast.saveFailed'), 'error');
      }
    };

    // AI commit generation config callback
    window.updateCommitGenerationEnabled = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setCommitGenerationEnabled?.(data.commitGenerationEnabled ?? true);
      } catch (error) {
        console.error('[SettingsView] Failed to parse commit generation config:', error);
      }
    };

    // AI session title generation config callback
    window.updateAiTitleGenerationEnabled = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setAiTitleGenerationEnabled?.(data.aiTitleGenerationEnabled ?? true);
      } catch (error) {
        console.error('[SettingsView] Failed to parse AI title generation config:', error);
      }
    };

    // Status bar widget config callback
    window.updateStatusBarWidgetEnabled = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setStatusBarWidgetEnabled?.(data.statusBarWidgetEnabled ?? true);
      } catch (error) {
        console.error('[SettingsView] Failed to parse status bar widget config:', error);
      }
    };

    // Task completion notification config callback (opt-in feature, default false)
    window.updateTaskCompletionNotificationEnabled = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setTaskCompletionNotificationEnabled?.(data.taskCompletionNotificationEnabled ?? false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse task completion notification config:', error);
      }
    };

    // AskUserQuestion reminder notification config callback (opt-in feature, default false)
    window.updateAskUserQuestionNotificationEnabled = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setAskUserQuestionNotificationEnabled?.(data.askUserQuestionNotificationEnabled ?? false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse ask user question notification config:', error);
      }
    };

    // System notification focus gate config callback (default false)
    window.updateSystemNotificationOnlyWhenUnfocused = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setSystemNotificationOnlyWhenUnfocused?.(data.systemNotificationOnlyWhenUnfocused ?? false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse system notification focus config:', error);
      }
    };

    // AskUserQuestion reminder sound notification config callback (opt-in feature, default false)
    window.updateAskUserQuestionSoundNotificationEnabled = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        d().setAskUserQuestionSoundNotificationEnabled?.(data.askUserQuestionSoundNotificationEnabled ?? false);
      } catch (error) {
        console.error('[SettingsView] Failed to parse ask user question sound notification config:', error);
      }
    };

    // Sound notification config callback
    window.updateSoundNotificationConfig = (jsonStr: string) => {
      try {
        const data = JSON.parse(jsonStr);
        if (data.enabled !== undefined) {
          d().setSoundNotificationEnabled?.(data.enabled);
        }
        if (data.onlyWhenUnfocused !== undefined) {
          d().setSoundOnlyWhenUnfocused?.(data.onlyWhenUnfocused);
        }
        if (data.selectedSound !== undefined) {
          d().setSelectedSound?.(data.selectedSound);
        }
        if (data.customSoundPath !== undefined) {
          d().setCustomSoundPath?.(data.customSoundPath);
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse sound notification config:', error);
      }
    };

    // Agent callbacks
    const previousUpdateAgents = window.updateAgents;
    window.updateAgents = (jsonStr: string) => {
      try {
        const agentsList: AgentConfig[] = JSON.parse(jsonStr);
        d().updateAgents(agentsList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse agents:', error);
      }
      previousUpdateAgents?.(jsonStr);
    };

    window.agentOperationResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        d().handleAgentOperationResult(result);
      } catch (error) {
        console.error('[SettingsView] Failed to parse agent operation result:', error);
      }
    };

    window.agentImportPreviewResult = (jsonStr: string) => {
      try {
        const previewData = JSON.parse(jsonStr);
        if (!Array.isArray(previewData?.items) || typeof previewData?.summary !== 'object') {
          console.error('[SettingsView] Invalid agent import preview data structure');
          return;
        }
        d().handleAgentImportPreviewResult(previewData);
      } catch (error) {
        console.error('[SettingsView] Failed to parse agent import preview result:', error);
      }
    };

    window.agentImportResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        d().handleAgentImportResult(result);
      } catch (error) {
        console.error('[SettingsView] Failed to parse agent import result:', error);
      }
    };

    // Prompt library callbacks (legacy support - now primarily handled by PromptSection)
    const previousUpdatePrompts = window.updatePrompts;
    window.updatePrompts = (jsonStr: string) => {
      try {
        const promptsList: PromptConfig[] = JSON.parse(jsonStr);
        d().updatePrompts?.(promptsList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse prompts:', error);
      }
      previousUpdatePrompts?.(jsonStr);
    };

    window.promptOperationResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        d().handlePromptOperationResult?.(result);
      } catch (error) {
        console.error('[SettingsView] Failed to parse prompt operation result:', error);
      }
    };

    window.promptImportPreviewResult = (jsonStr: string) => {
      try {
        const previewData = JSON.parse(jsonStr);
        if (!Array.isArray(previewData?.items) || typeof previewData?.summary !== 'object') {
          console.error('[SettingsView] Invalid prompt import preview data structure');
          return;
        }
        d().handlePromptImportPreviewResult?.(previewData);
      } catch (error) {
        console.error('[SettingsView] Failed to parse prompt import preview result:', error);
      }
    };

    window.promptImportResult = (jsonStr: string) => {
      try {
        const result = JSON.parse(jsonStr);
        d().handlePromptImportResult?.(result);
      } catch (error) {
        console.error('[SettingsView] Failed to parse prompt import result:', error);
      }
    };

    // Codex provider callbacks - subscribe via the registry.
    const unsubscribeCodexProviders = subscribeCodexProviderList((jsonStr: string) => {
      try {
        const providersList: CodexProviderConfig[] = JSON.parse(jsonStr);
        d().updateCodexProviders(providersList);
      } catch (error) {
        console.error('[SettingsView] Failed to parse Codex providers:', error);
        d().setCodexLoading(false);
      }
    });

    const unsubscribeActiveCodexProvider = subscribeActiveCodexProvider((jsonStr: string) => {
      try {
        const activeProvider: CodexProviderConfig = JSON.parse(jsonStr);
        if (activeProvider) {
          d().updateActiveCodexProvider(activeProvider);
        }
      } catch (error) {
        console.error('[SettingsView] Failed to parse active Codex provider:', error);
      }
    });

    window.updateCurrentCodexConfig = (jsonStr: string) => {
      try {
        const config = JSON.parse(jsonStr);
        d().updateCurrentCodexConfig(config);
      } catch (error) {
        console.error('[SettingsView] Failed to parse Codex config:', error);
        d().setCodexConfigLoading(false);
      }
    };

    // Initial data loading for the default (basic) settings surface only.
    // Provider / agent / prompt lists are fetched when their tabs first mount.
    // Bootstrap messages are batched so open-settings does not stampede CEF.
    const bootstrapRequests = scheduleBatchedBridgeRequests({
      messages: SETTINGS_BOOTSTRAP_BRIDGE_MESSAGES,
      batchSize: 5,
      batchDelayMs: 16,
      send: sendToJava,
    });

    return () => {
      bootstrapRequests.cancel();
      d().cleanupAgentsTimeout();
      d().cleanupPromptsTimeout?.();

      unsubscribeProviders();
      unsubscribeActiveProvider();
      unsubscribeCodexProviders();
      unsubscribeActiveCodexProvider();
      window.showError = undefined;
      window.showSwitchSuccess = undefined;
      window.updateNodePath = undefined;
      window.updateClaudeCliPath = undefined;
      window.updateCodexCliPath = undefined;
      window.updateWorkingDirectory = undefined;
      window.showSuccess = undefined;
      window.showSuccessI18n = undefined;
      window.onEditorFontConfigReceived = undefined;
      window.onUiFontConfigReceived = undefined;
      window.onCodeFontConfigReceived = undefined;
      window.onIdeThemeReceived = previousOnIdeThemeReceived;
      if (!d().onStreamingEnabledChangeProp) {
        window.updateStreamingEnabled = previousUpdateStreamingEnabled;
      }
      window.updateCodexSandboxMode = undefined;
      if (!d().onSendShortcutChangeProp) {
        window.updateSendShortcut = previousUpdateSendShortcut;
      }
      window.updateCommitPrompt = undefined;
      window.updateCommitAiConfig = undefined;
      window.updatePromptEnhancerConfig = undefined;
      window.updateProjectCommitPrompt = undefined;
      window.updateSoundNotificationConfig = undefined;
      window.updateCommitGenerationEnabled = undefined;
      window.updateAiTitleGenerationEnabled = undefined;
      window.updateStatusBarWidgetEnabled = undefined;
      window.updateTaskCompletionNotificationEnabled = undefined;
      window.updateAskUserQuestionNotificationEnabled = undefined;
      window.updateSystemNotificationOnlyWhenUnfocused = undefined;
      window.updateAskUserQuestionSoundNotificationEnabled = undefined;
      window.updateAgents = previousUpdateAgents;
      window.agentOperationResult = undefined;
      window.agentImportPreviewResult = undefined;
      window.agentImportResult = undefined;
      window.updatePrompts = previousUpdatePrompts;
      window.promptOperationResult = undefined;
      window.promptImportPreviewResult = undefined;
      window.promptImportResult = undefined;
      window.updateCurrentCodexConfig = undefined;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);
}
