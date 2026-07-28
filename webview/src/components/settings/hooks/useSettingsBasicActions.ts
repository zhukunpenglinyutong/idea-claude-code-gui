// hooks/useSettingsBasicActions.ts
import { useState, useEffect, useCallback } from 'react';
export type { UiFontConfig, CodeFontConfig } from '../../../types/uiFontConfig';
import type { UiFontConfig, CodeFontConfig } from '../../../types/uiFontConfig';
import type { CommitAiConfig, CommitAiProvider } from '../../../types/aiFeatureConfig';
import { DEFAULT_COMMIT_AI_CONFIG } from '../../../types/aiFeatureConfig';
import type { PromptEnhancerConfig, PromptEnhancerProvider } from '../../../types/promptEnhancer';
import { DEFAULT_PROMPT_ENHANCER_CONFIG } from '../../../types/promptEnhancer';
import {
  DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS,
  clampPermissionDialogTimeoutSeconds,
} from '../../../utils/permissionDialogTimeout';
import {
  getSkipNewSessionConfirm,
  SKIP_NEW_SESSION_CONFIRM_EVENT,
  type SkipNewSessionConfirmChangedDetail,
} from '../../../utils/skipNewSessionConfirm';
import {
  DETAILED_OUTPUT_ENABLED_EVENT,
  getDetailedOutputEnabled,
  setDetailedOutputEnabled,
  type DetailedOutputEnabledChangedDetail,
} from '../../../utils/detailedOutputPreference';

const sendToJava = (message: string) => {
  if (window.sendToJava) {
    window.sendToJava(message);
  }
};

export interface UseSettingsBasicActionsProps {
  streamingEnabledProp?: boolean;
  onStreamingEnabledChangeProp?: (enabled: boolean) => void;
  sendShortcutProp?: 'enter' | 'cmdEnter';
  onSendShortcutChangeProp?: (shortcut: 'enter' | 'cmdEnter') => void;
  autoOpenFileEnabledProp?: boolean;
  onAutoOpenFileEnabledChangeProp?: (enabled: boolean) => void;
  permissionDialogTimeoutSecondsProp?: number;
  onPermissionDialogTimeoutChangeProp?: (seconds: number) => void;
}

export interface UseSettingsBasicActionsReturn {
  // =========================================================================
  // Public read-only state (safe to read in components)
  // =========================================================================
  nodePath: string;
  nodeVersion: string | null;
  minNodeVersion: number;
  savingNodePath: boolean;
  claudeCliPath: string;
  savingClaudeCliPath: boolean;
  workingDirectory: string;
  savingWorkingDirectory: boolean;
  editorFontConfig:
    | {
        fontFamily: string;
        fontSize: number;
        lineSpacing: number;
      }
    | undefined;
  uiFontConfig: UiFontConfig | undefined;
  codeFontConfig: CodeFontConfig | undefined;
  /** Streaming enabled state (prefers prop over local state) */
  streamingEnabled: boolean;
  localStreamingEnabled: boolean;
  codexSandboxMode: 'workspace-write' | 'danger-full-access';
  /** Send shortcut state (prefers prop over local state) */
  sendShortcut: 'enter' | 'cmdEnter';
  localSendShortcut: 'enter' | 'cmdEnter';
  /** Auto open file state (prefers prop over local state) */
  autoOpenFileEnabled: boolean;
  localAutoOpenFileEnabled: boolean;
  commitPrompt: string;
  savingCommitPrompt: boolean;
  projectCommitPrompt: string;
  savingProjectCommitPrompt: boolean;
  soundNotificationEnabled: boolean;
  soundOnlyWhenUnfocused: boolean;
  selectedSound: string;
  customSoundPath: string;
  diffExpandedByDefault: boolean;
  historyCompletionEnabled: boolean;
  /** Whether to skip the "create new session with existing messages" confirm dialog. */
  skipNewSessionConfirm: boolean;
  commitGenerationEnabled: boolean;
  aiTitleGenerationEnabled: boolean;
  statusBarWidgetEnabled: boolean;
  taskCompletionNotificationEnabled: boolean;
  askUserQuestionNotificationEnabled: boolean;
  detailedOutputEnabled: boolean;
  commitAiConfig: CommitAiConfig;
  promptEnhancerConfig: PromptEnhancerConfig;

  // =========================================================================
  // Handler functions (public API for components)
  // =========================================================================
  handleSaveNodePath: () => void;
  handleSaveClaudeCliPath: () => void;
  handleSaveWorkingDirectory: () => void;
  handleUiFontSelectionChange: (selection: string) => void;
  handleSaveUiFontCustomPath: (path: string) => void;
  handleBrowseUiFontFile: () => void;
  handleCodeFontSelectionChange: (selection: string) => void;
  handleSaveCodeFontCustomPath: (path: string) => void;
  handleBrowseCodeFontFile: () => void;
  handleStreamingEnabledChange: (enabled: boolean) => void;
  handleCodexSandboxModeChange: (mode: 'workspace-write' | 'danger-full-access') => void;
  handleSendShortcutChange: (shortcut: 'enter' | 'cmdEnter') => void;
  handleAutoOpenFileEnabledChange: (enabled: boolean) => void;
  handleSoundNotificationEnabledChange: (enabled: boolean) => void;
  handleSoundOnlyWhenUnfocusedChange: (enabled: boolean) => void;
  handleSelectedSoundChange: (soundId: string) => void;
  handleCustomSoundPathChange: (path: string) => void;
  handleSaveCustomSoundPath: () => void;
  handleTestSound: () => void;
  handleBrowseSound: () => void;
  handleSaveCommitPrompt: () => void;
  handleSaveProjectCommitPrompt: () => void;
  handleCommitGenerationEnabledChange: (enabled: boolean) => void;
  handleAiTitleGenerationEnabledChange: (enabled: boolean) => void;
  handleStatusBarWidgetEnabledChange: (enabled: boolean) => void;
  handleTaskCompletionNotificationEnabledChange: (enabled: boolean) => void;
  handleAskUserQuestionNotificationEnabledChange: (enabled: boolean) => void;
  handleDetailedOutputEnabledChange: (enabled: boolean) => void;
  permissionDialogTimeoutSeconds: number;
  handlePermissionDialogTimeoutChange: (seconds: number) => void;
  handleCommitAiProviderChange: (provider: CommitAiProvider) => void;
  handleCommitAiModelChange: (model: string) => void;
  handleCommitAiResetToDefault: () => void;
  handlePromptEnhancerProviderChange: (provider: PromptEnhancerProvider) => void;
  handlePromptEnhancerModelChange: (model: string) => void;
  handlePromptEnhancerResetToDefault: () => void;

  // =========================================================================
  // @internal — State setters used only by useSettingsWindowCallbacks.
  // Components should not call these directly; use handlers above instead.
  // =========================================================================
  /** @internal */ setNodePath: (path: string) => void;
  /** @internal */ setNodeVersion: (version: string | null) => void;
  /** @internal */ setMinNodeVersion: (version: number) => void;
  /** @internal */ setSavingNodePath: (saving: boolean) => void;
  /** @internal */ setClaudeCliPath: (path: string) => void;
  /** @internal */ setSavingClaudeCliPath: (saving: boolean) => void;
  /** @internal */ setWorkingDirectory: (dir: string) => void;
  /** @internal */ setSavingWorkingDirectory: (saving: boolean) => void;
  /** @internal */ setEditorFontConfig: (
    config:
      | {
          fontFamily: string;
          fontSize: number;
          lineSpacing: number;
      }
      | undefined
  ) => void;
  /** @internal */ setUiFontConfig: (config: UiFontConfig | undefined) => void;
  /** @internal */ setCodeFontConfig: (config: CodeFontConfig | undefined) => void;
  /** @internal */ setLocalStreamingEnabled: (enabled: boolean) => void;
  /** @internal */ setCodexSandboxMode: (mode: 'workspace-write' | 'danger-full-access') => void;
  /** @internal */ setLocalSendShortcut: (shortcut: 'enter' | 'cmdEnter') => void;
  /** @internal */ setLocalAutoOpenFileEnabled: (enabled: boolean) => void;
  /** @internal */ setCommitPrompt: (prompt: string) => void;
  /** @internal */ setSavingCommitPrompt: (saving: boolean) => void;
  /** @internal */ setProjectCommitPrompt: (prompt: string) => void;
  /** @internal */ setSavingProjectCommitPrompt: (saving: boolean) => void;
  /** @internal */ setSoundNotificationEnabled: (enabled: boolean) => void;
  /** @internal */ setSoundOnlyWhenUnfocused: (enabled: boolean) => void;
  /** @internal */ setSelectedSound: (soundId: string) => void;
  /** @internal */ setCustomSoundPath: (path: string) => void;
  /** @internal */ setDiffExpandedByDefault: (expanded: boolean) => void;
  /** @internal */ setHistoryCompletionEnabled: (enabled: boolean) => void;
  /** @internal */ setSkipNewSessionConfirm: (enabled: boolean) => void;
  /** @internal */ setCommitGenerationEnabled: (enabled: boolean) => void;
  /** @internal */ setAiTitleGenerationEnabled: (enabled: boolean) => void;
  /** @internal */ setStatusBarWidgetEnabled: (enabled: boolean) => void;
  /** @internal */ setTaskCompletionNotificationEnabled: (enabled: boolean) => void;
  /** @internal */ setAskUserQuestionNotificationEnabled: (enabled: boolean) => void;
  /** @internal */ setCommitAiConfig: (config: CommitAiConfig) => void;
  /** @internal */ setPromptEnhancerConfig: (config: PromptEnhancerConfig) => void;
}

export function useSettingsBasicActions({
  streamingEnabledProp,
  onStreamingEnabledChangeProp,
  sendShortcutProp,
  onSendShortcutChangeProp,
  autoOpenFileEnabledProp,
  onAutoOpenFileEnabledChangeProp,
  permissionDialogTimeoutSecondsProp,
  onPermissionDialogTimeoutChangeProp,
}: UseSettingsBasicActionsProps): UseSettingsBasicActionsReturn {
  // Node.js path
  const [nodePath, setNodePath] = useState('');
  const [nodeVersion, setNodeVersion] = useState<string | null>(null);
  const [minNodeVersion, setMinNodeVersion] = useState(18);
  const [savingNodePath, setSavingNodePath] = useState(false);

  // Custom Claude CLI path (overrides bundled SDK when set)
  const [claudeCliPath, setClaudeCliPath] = useState('');
  const [savingClaudeCliPath, setSavingClaudeCliPath] = useState(false);

  // Working directory configuration
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [savingWorkingDirectory, setSavingWorkingDirectory] = useState(false);

  // IDEA editor font configuration (read-only display)
  const [editorFontConfig, setEditorFontConfig] = useState<
    | {
        fontFamily: string;
        fontSize: number;
        lineSpacing: number;
      }
    | undefined
  >();
  const [uiFontConfig, setUiFontConfig] = useState<UiFontConfig | undefined>();
  const [codeFontConfig, setCodeFontConfig] = useState<CodeFontConfig | undefined>();

  // Streaming configuration - prefer props, fallback to local state
  const [localStreamingEnabled, setLocalStreamingEnabled] = useState<boolean>(false);
  const streamingEnabled = streamingEnabledProp ?? localStreamingEnabled;

  const [codexSandboxMode, setCodexSandboxMode] = useState<'workspace-write' | 'danger-full-access'>(
    'danger-full-access'
  );

  // Send shortcut configuration - prefer props, fallback to local state
  const [localSendShortcut, setLocalSendShortcut] = useState<'enter' | 'cmdEnter'>('enter');
  const sendShortcut = sendShortcutProp ?? localSendShortcut;

  // Auto open file configuration - prefer props, fallback to local state
  const [localAutoOpenFileEnabled, setLocalAutoOpenFileEnabled] = useState<boolean>(false);
  const autoOpenFileEnabled = autoOpenFileEnabledProp ?? localAutoOpenFileEnabled;

  // Commit AI prompt configuration
  const [commitPrompt, setCommitPrompt] = useState('');
  const [savingCommitPrompt, setSavingCommitPrompt] = useState(false);

  // Project-level commit AI prompt configuration
  const [projectCommitPrompt, setProjectCommitPrompt] = useState('');
  const [savingProjectCommitPrompt, setSavingProjectCommitPrompt] = useState(false);

  // Sound notification configuration
  const [soundNotificationEnabled, setSoundNotificationEnabled] = useState<boolean>(false);
  const [soundOnlyWhenUnfocused, setSoundOnlyWhenUnfocused] = useState<boolean>(false);
  const [selectedSound, setSelectedSound] = useState<string>('default');
  const [customSoundPath, setCustomSoundPath] = useState<string>('');

  // Diff expanded by default configuration (localStorage-only)
  const [diffExpandedByDefault, setDiffExpandedByDefault] = useState<boolean>(() => {
    try {
      return localStorage.getItem('diffExpandedByDefault') === 'true';
    } catch {
      return false;
    }
  });

  // History completion toggle configuration
  const [historyCompletionEnabled, setHistoryCompletionEnabled] = useState<boolean>(() => {
    const saved = localStorage.getItem('historyCompletionEnabled');
    return saved !== 'false'; // Enabled by default
  });

  // "Skip new-session confirm dialog" preference (localStorage-only, default: false).
  // Synced bidirectionally with the dialog checkbox via CustomEvent so toggling
  // either surface (dialog or settings page) updates the other immediately.
  const [skipNewSessionConfirm, setSkipNewSessionConfirm] = useState<boolean>(() =>
    getSkipNewSessionConfirm()
  );
  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<SkipNewSessionConfirmChangedDetail>;
      if (custom.detail && typeof custom.detail.enabled === 'boolean') {
        setSkipNewSessionConfirm(custom.detail.enabled);
      }
    };
    window.addEventListener(SKIP_NEW_SESSION_CONFIRM_EVENT, handler);
    return () => window.removeEventListener(SKIP_NEW_SESSION_CONFIRM_EVENT, handler);
  }, []);

  // AI commit generation toggle (default: true)
  const [commitGenerationEnabled, setCommitGenerationEnabled] = useState<boolean>(true);

  // AI session title generation toggle (default: true)
  const [aiTitleGenerationEnabled, setAiTitleGenerationEnabled] = useState<boolean>(true);

  // Status bar widget toggle (default: true)
  const [statusBarWidgetEnabled, setStatusBarWidgetEnabled] = useState<boolean>(true);

  // Task completion notification toggle (default: false, opt-in feature)
  const [taskCompletionNotificationEnabled, setTaskCompletionNotificationEnabled] = useState<boolean>(false);

  // AskUserQuestion reminder notification toggle (default: false, opt-in feature)
  const [askUserQuestionNotificationEnabled, setAskUserQuestionNotificationEnabled] = useState<boolean>(false);

  // Detailed message footer output (localStorage-only, default: false to preserve original footer style)
  const [detailedOutputEnabled, setDetailedOutputEnabledState] = useState<boolean>(() =>
    getDetailedOutputEnabled()
  );

  useEffect(() => {
    const handler = (event: Event) => {
      const custom = event as CustomEvent<DetailedOutputEnabledChangedDetail>;
      if (custom.detail && typeof custom.detail.enabled === 'boolean') {
        setDetailedOutputEnabledState(custom.detail.enabled);
      }
    };
    window.addEventListener(DETAILED_OUTPUT_ENABLED_EVENT, handler);
    return () => window.removeEventListener(DETAILED_OUTPUT_ENABLED_EVENT, handler);
  }, []);

  // Permission dialog timeout — owned by App.tsx; we treat the prop as authoritative.
  // We intentionally do NOT keep a local copy: it would be dead state because the
  // prop is always provided in production, and a divergent local copy could be read
  // by accident in future refactors.
  const permissionDialogTimeoutSeconds =
    permissionDialogTimeoutSecondsProp ?? DEFAULT_PERMISSION_DIALOG_TIMEOUT_SECONDS;

  const [commitAiConfig, setCommitAiConfig] = useState<CommitAiConfig>(
    DEFAULT_COMMIT_AI_CONFIG
  );
  const [promptEnhancerConfig, setPromptEnhancerConfig] = useState<PromptEnhancerConfig>(
    DEFAULT_PROMPT_ENHANCER_CONFIG
  );

  // Diff expanded by default handler
  useEffect(() => {
    try {
      if (diffExpandedByDefault) {
        localStorage.setItem('diffExpandedByDefault', 'true');
      } else {
        localStorage.removeItem('diffExpandedByDefault');
      }
    } catch { /* ignore storage errors */ }
  }, [diffExpandedByDefault]);

  const handleSaveNodePath = useCallback(() => {
    setSavingNodePath(true);
    const payload = { path: (nodePath || '').trim() };
    sendToJava(`set_node_path:${JSON.stringify(payload)}`);
  }, [nodePath]);

  const handleSaveClaudeCliPath = useCallback(() => {
    setSavingClaudeCliPath(true);
    const payload = { path: (claudeCliPath || '').trim() };
    sendToJava(`set_claude_cli_path:${JSON.stringify(payload)}`);
  }, [claudeCliPath]);

  const handleSaveWorkingDirectory = useCallback(() => {
    setSavingWorkingDirectory(true);
    const payload = { customWorkingDir: (workingDirectory || '').trim() };
    sendToJava(`set_working_directory:${JSON.stringify(payload)}`);
  }, [workingDirectory]);

  const handleUiFontSelectionChange = useCallback((selection: string) => {
    if (selection === 'followEditor') {
      sendToJava(`set_ui_font_config:${JSON.stringify({ mode: 'followEditor' })}`);
      return;
    }

    if (selection === 'customFile' && uiFontConfig?.customFontPath) {
      sendToJava(`set_ui_font_config:${JSON.stringify({
        mode: 'customFile',
        customFontPath: uiFontConfig.customFontPath,
      })}`);
    }
  }, [uiFontConfig?.customFontPath]);

  const handleSaveUiFontCustomPath = useCallback((path: string) => {
    sendToJava(`set_ui_font_config:${JSON.stringify({
      mode: 'customFile',
      customFontPath: path,
    })}`);
  }, []);

  const handleBrowseUiFontFile = useCallback(() => {
    sendToJava('browse_ui_font_file:');
  }, []);

  const handleCodeFontSelectionChange = useCallback((selection: string) => {
    if (selection === 'followEditor') {
      sendToJava(`set_code_font_config:${JSON.stringify({ mode: 'followEditor' })}`);
      return;
    }

    if (selection === 'customFile' && codeFontConfig?.customFontPath) {
      sendToJava(`set_code_font_config:${JSON.stringify({
        mode: 'customFile',
        customFontPath: codeFontConfig.customFontPath,
      })}`);
    }
  }, [codeFontConfig?.customFontPath]);

  const handleSaveCodeFontCustomPath = useCallback((path: string) => {
    sendToJava(`set_code_font_config:${JSON.stringify({
      mode: 'customFile',
      customFontPath: path,
    })}`);
  }, []);

  const handleBrowseCodeFontFile = useCallback(() => {
    sendToJava('browse_code_font_file:');
  }, []);

  // Streaming toggle change handler
  const handleStreamingEnabledChange = useCallback((enabled: boolean) => {
    // If prop callback is provided (from App.tsx), use it for centralized state management
    if (onStreamingEnabledChangeProp) {
      onStreamingEnabledChangeProp(enabled);
    } else {
      // Fallback to local state if no prop callback provided
      setLocalStreamingEnabled(enabled);
      const payload = { streamingEnabled: enabled };
      sendToJava(`set_streaming_enabled:${JSON.stringify(payload)}`);
    }
  }, [onStreamingEnabledChangeProp]);

  const handleCodexSandboxModeChange = useCallback((mode: 'workspace-write' | 'danger-full-access') => {
    setCodexSandboxMode(mode);
    const payload = { sandboxMode: mode };
    sendToJava(`set_codex_sandbox_mode:${JSON.stringify(payload)}`);
  }, []);

  // Send shortcut change handler
  const handleSendShortcutChange = useCallback((shortcut: 'enter' | 'cmdEnter') => {
    // If prop callback is provided (from App.tsx), use it for centralized state management
    if (onSendShortcutChangeProp) {
      onSendShortcutChangeProp(shortcut);
    } else {
      // Fallback to local state if no prop callback provided
      setLocalSendShortcut(shortcut);
      const payload = { sendShortcut: shortcut };
      sendToJava(`set_send_shortcut:${JSON.stringify(payload)}`);
    }
  }, [onSendShortcutChangeProp]);

  // Auto open file toggle change handler
  const handleAutoOpenFileEnabledChange = useCallback((enabled: boolean) => {
    // If prop callback is provided (from App.tsx), use it for centralized state management
    if (onAutoOpenFileEnabledChangeProp) {
      onAutoOpenFileEnabledChangeProp(enabled);
    } else {
      // Fallback to local state if no prop callback provided
      setLocalAutoOpenFileEnabled(enabled);
      const payload = { autoOpenFileEnabled: enabled };
      sendToJava(`set_auto_open_file_enabled:${JSON.stringify(payload)}`);
    }
  }, [onAutoOpenFileEnabledChangeProp]);

  // Sound notification toggle change handler
  const handleSoundNotificationEnabledChange = useCallback((enabled: boolean) => {
    setSoundNotificationEnabled(enabled);
    const payload = { enabled };
    sendToJava(`set_sound_notification_enabled:${JSON.stringify(payload)}`);
  }, []);

  // Sound only-when-unfocused toggle change handler
  const handleSoundOnlyWhenUnfocusedChange = useCallback((enabled: boolean) => {
    setSoundOnlyWhenUnfocused(enabled);
    const payload = { onlyWhenUnfocused: enabled };
    sendToJava(`set_sound_only_when_unfocused:${JSON.stringify(payload)}`);
  }, []);

  // Selected sound change handler
  const handleSelectedSoundChange = useCallback((soundId: string) => {
    setSelectedSound(soundId);
    const payload = { soundId };
    sendToJava(`set_selected_sound:${JSON.stringify(payload)}`);
  }, []);

  // Custom sound path change handler
  const handleCustomSoundPathChange = useCallback((path: string) => {
    setCustomSoundPath(path);
  }, []);

  // Save custom sound path
  const handleSaveCustomSoundPath = useCallback(() => {
    const payload = { path: customSoundPath };
    sendToJava(`set_custom_sound_path:${JSON.stringify(payload)}`);
  }, [customSoundPath]);

  // Test sound
  const handleTestSound = useCallback(() => {
    const payload = { soundId: selectedSound, path: customSoundPath };
    sendToJava(`test_sound:${JSON.stringify(payload)}`);
  }, [selectedSound, customSoundPath]);

  // Browse sound file
  const handleBrowseSound = useCallback(() => {
    sendToJava('browse_sound_file:');
  }, []);

  // AI commit generation toggle change handler
  const handleCommitGenerationEnabledChange = useCallback((enabled: boolean) => {
    setCommitGenerationEnabled(enabled);
    const payload = { commitGenerationEnabled: enabled };
    sendToJava(`set_commit_generation_enabled:${JSON.stringify(payload)}`);
  }, []);

  // AI session title generation toggle change handler
  const handleAiTitleGenerationEnabledChange = useCallback((enabled: boolean) => {
    setAiTitleGenerationEnabled(enabled);
    const payload = { aiTitleGenerationEnabled: enabled };
    sendToJava(`set_ai_title_generation_enabled:${JSON.stringify(payload)}`);
  }, []);

  // Status bar widget toggle change handler
  const handleStatusBarWidgetEnabledChange = useCallback((enabled: boolean) => {
    setStatusBarWidgetEnabled(enabled);
    const payload = { statusBarWidgetEnabled: enabled };
    sendToJava(`set_status_bar_widget_enabled:${JSON.stringify(payload)}`);
  }, []);

  // Task completion notification toggle change handler
  const handleTaskCompletionNotificationEnabledChange = useCallback((enabled: boolean) => {
    setTaskCompletionNotificationEnabled(enabled);
    const payload = { taskCompletionNotificationEnabled: enabled };
    sendToJava(`set_task_completion_notification_enabled:${JSON.stringify(payload)}`);
  }, []);

  // AskUserQuestion reminder notification toggle change handler
  const handleAskUserQuestionNotificationEnabledChange = useCallback((enabled: boolean) => {
    setAskUserQuestionNotificationEnabled(enabled);
    const payload = { askUserQuestionNotificationEnabled: enabled };
    sendToJava(`set_ask_user_question_notification_enabled:${JSON.stringify(payload)}`);
  }, []);

  const handleDetailedOutputEnabledChange = useCallback((enabled: boolean) => {
    setDetailedOutputEnabledState(enabled);
    setDetailedOutputEnabled(enabled);
  }, []);

  // Permission dialog timeout change handler
  const handlePermissionDialogTimeoutChange = useCallback((seconds: number) => {
    const clamped = clampPermissionDialogTimeoutSeconds(seconds);
    // App.tsx owns the canonical state and provides the callback in production.
    onPermissionDialogTimeoutChangeProp?.(clamped);
    const payload = { permissionDialogTimeoutSeconds: clamped };
    sendToJava(`set_permission_dialog_timeout:${JSON.stringify(payload)}`);
  }, [onPermissionDialogTimeoutChangeProp]);

  const handleCommitAiProviderChange = useCallback((provider: CommitAiProvider) => {
    const providerAvailable = commitAiConfig.availability[provider];
    const nextConfig: CommitAiConfig = {
      ...commitAiConfig,
      provider,
      effectiveProvider: providerAvailable ? provider : null,
      resolutionSource: providerAvailable ? 'manual' : 'unavailable',
    };
    setCommitAiConfig(nextConfig);
    sendToJava(`set_commit_ai_config:${JSON.stringify({
      provider,
      models: nextConfig.models,
    })}`);
  }, [commitAiConfig]);

  const handleCommitAiModelChange = useCallback((model: string) => {
    const activeProvider = commitAiConfig.provider ?? commitAiConfig.effectiveProvider ?? 'codex';
    const nextConfig: CommitAiConfig = {
      ...commitAiConfig,
      models: {
        ...commitAiConfig.models,
        [activeProvider]: model,
      },
    };
    setCommitAiConfig(nextConfig);
    sendToJava(`set_commit_ai_config:${JSON.stringify({
      provider: commitAiConfig.provider,
      models: nextConfig.models,
    })}`);
  }, [commitAiConfig]);

  const handleCommitAiResetToDefault = useCallback(() => {
    const nextConfig: CommitAiConfig = {
      ...commitAiConfig,
      provider: null,
      effectiveProvider: commitAiConfig.availability.codex
        ? 'codex'
        : (commitAiConfig.availability.claude ? 'claude' : null),
      resolutionSource: commitAiConfig.availability.codex || commitAiConfig.availability.claude
        ? 'auto'
        : 'unavailable',
    };
    setCommitAiConfig(nextConfig);
    sendToJava(`set_commit_ai_config:${JSON.stringify({
      provider: null,
      models: nextConfig.models,
    })}`);
  }, [commitAiConfig]);

  const handlePromptEnhancerProviderChange = useCallback((provider: PromptEnhancerProvider) => {
    const providerAvailable = promptEnhancerConfig.availability[provider];
    const nextConfig: PromptEnhancerConfig = {
      ...promptEnhancerConfig,
      provider,
      effectiveProvider: providerAvailable ? provider : null,
      resolutionSource: providerAvailable ? 'manual' : 'unavailable',
    };
    setPromptEnhancerConfig(nextConfig);
    sendToJava(`set_prompt_enhancer_config:${JSON.stringify({
      provider,
      models: nextConfig.models,
    })}`);
  }, [promptEnhancerConfig]);

  const handlePromptEnhancerModelChange = useCallback((model: string) => {
    const activeProvider = promptEnhancerConfig.provider ?? promptEnhancerConfig.effectiveProvider ?? 'claude';
    const nextConfig: PromptEnhancerConfig = {
      ...promptEnhancerConfig,
      models: {
        ...promptEnhancerConfig.models,
        [activeProvider]: model,
      },
    };
    setPromptEnhancerConfig(nextConfig);
    sendToJava(`set_prompt_enhancer_config:${JSON.stringify({
      provider: promptEnhancerConfig.provider,
      models: nextConfig.models,
    })}`);
  }, [promptEnhancerConfig]);

  const handlePromptEnhancerResetToDefault = useCallback(() => {
    const nextConfig: PromptEnhancerConfig = {
      ...promptEnhancerConfig,
      provider: null,
      effectiveProvider: promptEnhancerConfig.availability.codex
        ? 'codex'
        : (promptEnhancerConfig.availability.claude ? 'claude' : null),
      resolutionSource: promptEnhancerConfig.availability.codex || promptEnhancerConfig.availability.claude
        ? 'auto'
        : 'unavailable',
    };
    setPromptEnhancerConfig(nextConfig);
    sendToJava(`set_prompt_enhancer_config:${JSON.stringify({
      provider: null,
      models: nextConfig.models,
    })}`);
  }, [promptEnhancerConfig]);

  // Commit AI prompt save handler
  const handleSaveCommitPrompt = useCallback(() => {
    setSavingCommitPrompt(true);
    const payload = { prompt: commitPrompt };
    sendToJava(`set_commit_prompt:${JSON.stringify(payload)}`);
  }, [commitPrompt]);

  // Project-level commit AI prompt save handler
  const handleSaveProjectCommitPrompt = useCallback(() => {
    setSavingProjectCommitPrompt(true);
    const payload = { prompt: projectCommitPrompt };
    sendToJava(`set_project_commit_prompt:${JSON.stringify(payload)}`);
  }, [projectCommitPrompt]);

  return {
    nodePath,
    setNodePath,
    nodeVersion,
    setNodeVersion,
    minNodeVersion,
    setMinNodeVersion,
    savingNodePath,
    setSavingNodePath,
    claudeCliPath,
    setClaudeCliPath,
    savingClaudeCliPath,
    setSavingClaudeCliPath,
    workingDirectory,
    setWorkingDirectory,
    savingWorkingDirectory,
    setSavingWorkingDirectory,
    editorFontConfig,
    setEditorFontConfig,
    uiFontConfig,
    setUiFontConfig,
    codeFontConfig,
    setCodeFontConfig,
    localStreamingEnabled,
    setLocalStreamingEnabled,
    streamingEnabled,
    codexSandboxMode,
    setCodexSandboxMode,
    localSendShortcut,
    setLocalSendShortcut,
    sendShortcut,
    localAutoOpenFileEnabled,
    setLocalAutoOpenFileEnabled,
    autoOpenFileEnabled,
    commitPrompt,
    setCommitPrompt,
    savingCommitPrompt,
    setSavingCommitPrompt,
    soundNotificationEnabled,
    setSoundNotificationEnabled,
    soundOnlyWhenUnfocused,
    setSoundOnlyWhenUnfocused,
    selectedSound,
    setSelectedSound,
    customSoundPath,
    setCustomSoundPath,
    diffExpandedByDefault,
    setDiffExpandedByDefault,
    historyCompletionEnabled,
    setHistoryCompletionEnabled,
    skipNewSessionConfirm,
    setSkipNewSessionConfirm,
    handleSaveNodePath,
    handleSaveClaudeCliPath,
    handleSaveWorkingDirectory,
    handleUiFontSelectionChange,
    handleSaveUiFontCustomPath,
    handleBrowseUiFontFile,
    handleCodeFontSelectionChange,
    handleSaveCodeFontCustomPath,
    handleBrowseCodeFontFile,
    handleStreamingEnabledChange,
    handleCodexSandboxModeChange,
    handleSendShortcutChange,
    handleAutoOpenFileEnabledChange,
    handleSoundNotificationEnabledChange,
    handleSoundOnlyWhenUnfocusedChange,
    handleSelectedSoundChange,
    handleCustomSoundPathChange,
    handleSaveCustomSoundPath,
    handleTestSound,
    handleBrowseSound,
    handleSaveCommitPrompt,
    projectCommitPrompt,
    setProjectCommitPrompt,
    savingProjectCommitPrompt,
    setSavingProjectCommitPrompt,
    handleSaveProjectCommitPrompt,
    commitGenerationEnabled,
    setCommitGenerationEnabled,
    handleCommitGenerationEnabledChange,
    aiTitleGenerationEnabled,
    setAiTitleGenerationEnabled,
    handleAiTitleGenerationEnabledChange,
    statusBarWidgetEnabled,
    setStatusBarWidgetEnabled,
    handleStatusBarWidgetEnabledChange,
    taskCompletionNotificationEnabled,
    setTaskCompletionNotificationEnabled,
    handleTaskCompletionNotificationEnabledChange,
    askUserQuestionNotificationEnabled,
    setAskUserQuestionNotificationEnabled,
    handleAskUserQuestionNotificationEnabledChange,
    detailedOutputEnabled,
    handleDetailedOutputEnabledChange,
    permissionDialogTimeoutSeconds,
    handlePermissionDialogTimeoutChange,
    commitAiConfig,
    setCommitAiConfig,
    handleCommitAiProviderChange,
    handleCommitAiModelChange,
    handleCommitAiResetToDefault,
    promptEnhancerConfig,
    setPromptEnhancerConfig,
    handlePromptEnhancerProviderChange,
    handlePromptEnhancerModelChange,
    handlePromptEnhancerResetToDefault,
  };
}
