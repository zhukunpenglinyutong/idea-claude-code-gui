/**
 * Global window interface extensions for IDEA plugin communication
 */
interface Window {
  /**
   * Send message to Java backend
   */
  sendToJava?: (message: string) => void;

  /**
   * Get clipboard file path from Java
   */
  getClipboardFilePath?: () => Promise<string>;

  /**
   * Handle file path(s) dropped from Java (supports batch files)
   */
  handleFilePathFromJava?: (filePathInput: string | string[]) => void;

  /**
   * Update messages from backend
   */
  updateMessages?: (json: string, sequence?: string | number) => void;

  /**
   * Patch a single message UUID without re-sending the full message list.
   */
  patchMessageUuid?: (content: string, uuid: string) => void;

  /**
   * Update status message
   */
  updateStatus?: (text: string) => void;

  /**
   * Show loading indicator
   */
  showLoading?: (value: string | boolean) => void;

  /**
   * Show thinking status
   */
  showThinkingStatus?: (value: string | boolean) => void;

  /**
   * Show conversation summary/compaction notice
   */
  showSummary?: (summary: string) => void;

  /**
   * Set history data
   */
  setHistoryData?: (data: any) => void;

  /**
   * Export session data callback
   */
  onExportSessionData?: (json: string) => void;

  /**
   * Clear all messages. The optional barrier sequence (the backend coalescer's
   * post-reset updateSequence) advances __minAcceptedUpdateSequence so stale
   * in-flight updateMessages from the previous session are rejected.
   */
  clearMessages?: (barrierSequence?: string | number) => void;

  /**
   * Add error message
   */
  addErrorMessage?: (message: string) => void;

  /**
   * Context usage dialog callback - receives JSON string with context usage data to show in a dialog.
   */
  showContextUsageDialog?: (json: string) => void;

  /**
   * Context usage error callback - shows error toast.
   */
  onContextUsageError?: (message: string, requestId?: string) => void;

  /**
   * Add single history message (used for Codex session loading)
   */
  addHistoryMessage?: (message: any) => void;

  /**
   * History load complete callback - invoked when history messages finish loading.
   * Triggers Markdown re-rendering to fix incorrect rendering on first history load.
   */
  historyLoadComplete?: () => void;

  /**
   * Subagent sidechain history callback.
   */
  onSubagentHistoryLoaded?: (json: string) => void;

  /**
   * SDK-to-CLI session conversion result callback.
   * Called by the Java backend after attempting to convert entrypoint from "sdk-cli" to "cli".
   * Payload: { success: boolean, infoCode?: string, errorCode?: string }.
   * infoCode carries extra context on success (e.g. ALREADY_CLI_SESSION);
   * errorCode identifies the failure reason for i18n lookup.
   */
  onConversionResult?: (json: string) => void;

  /**
   * Add user message to chat (used for external Quick Fix feature)
   * Immediately shows the user's message in the chat UI before AI response
   */
  addUserMessage?: (content: string) => void;

  /**
   * Set current session ID (for rewind feature)
   */
  setSessionId?: (sessionId: string) => void;

  /**
   * Add toast notification (called from backend)
   */
  addToast?: (message: string, type: 'success' | 'error' | 'warning' | 'info') => void;

  /**
   * Toast deferred until a session transition finishes, because backend
   * clearMessages resets transient UI state during new-session creation.
   */
  __pendingSessionTransitionToast?: {
    message: string;
    type?: 'success' | 'error' | 'warning' | 'info';
  };

  /**
   * Usage statistics update callback
   */
  onUsageUpdate?: (json: string) => void;

  /**
   * Mode changed callback
   */
  onModeChanged?: (mode: string) => void;

  /**
   * Mode received callback - backend pushes the permission mode (called during window initialization)
   */
  onModeReceived?: (mode: string) => void;

  /**
   * Model changed callback
   */
  onModelChanged?: (modelId: string) => void;

  /**
   * Model confirmed callback - called after the backend confirms the model was set successfully
   * @param modelId The confirmed model ID
   * @param provider The current provider
   */
  onModelConfirmed?: (modelId: string, provider: string) => void;

  /**
   * Show permission dialog
   */
  showPermissionDialog?: (json: string) => void;

  /**
   * Show AskUserQuestion dialog
   */
  showAskUserQuestionDialog?: (json: string) => void;
  updateCodexPets?: (json: string) => void;
  updateCodexPetPreview?: (json: string) => void;
  onCodexPetAssetsChanged?: () => void;
  updateCodexPetConfig?: (json: string) => void;
  updatePetdexCatalog?: (json: string) => void;
  updatePetdexPreview?: (json: string) => void;
  onCodexPetOperation?: (json: string) => void;
  updateHatchPetStatus?: (json: string) => void;
  updateHatchPetReference?: (json: string) => void;
  onHatchPetCommandPrepared?: (json: string) => void;

  /**
   * Show PlanApproval dialog
   */
  showPlanApprovalDialog?: (json: string) => void;

  /**
   * Force-close the open AskUserQuestion dialog matching the given requestId.
   * Sent by the Java backend when its safety-net timer fires and resolves the
   * pending future with an empty answer — the WebView dialog (if still visible)
   * must be torn down too, otherwise its open-refs stay set and every
   * subsequent showAskUserQuestionDialog call is silently enqueued behind the
   * orphaned dialog (issue #1360). When requestId is null/empty, every open
   * dialog is closed.
   */
  forceCloseAskUserQuestionDialog?: (requestId?: string | null) => void;

  /**
   * Force-close the open permission dialog matching the given channelId, or
   * every open dialog when channelId is null/empty. Same rationale as
   * forceCloseAskUserQuestionDialog.
   */
  forceClosePermissionDialog?: (channelId?: string | null) => void;

  /**
   * Force-close the open plan approval dialog matching the given requestId, or
   * every open dialog when requestId is null/empty.
   */
  forceClosePlanApprovalDialog?: (requestId?: string | null) => void;

  /**
   * Add selection info (file and line numbers) - auto-tracked, only updates ContextBar
   */
  addSelectionInfo?: (selectionInfo: string) => void;

  /**
   * Add code snippet to input box - manually triggered, inserts a code snippet tag into the input box
   */
  addCodeSnippet?: (selectionInfo: string) => void;

  /**
   * Insert code snippet at cursor position - registered by ChatInputBox
   */
  insertCodeSnippetAtCursor?: (selectionInfo: string) => void;

  /**
   * Focus the chat input box - registered by ChatInputBox
   */
  focusChatInput?: () => void;

  /**
   * Clear selection info
   */
  clearSelectionInfo?: () => void;

  /**
   * File list result callback (for file reference provider)
   */
  onFileListResult?: (json: string) => void;

  /**
   * Update MCP marketplace sources.
   */
  updateMcpMarketplaceSources?: (json: string) => void;

  /**
   * Update MCP marketplace entries.
   */
  updateMcpMarketplaceEntries?: (json: string) => void;

  /**
   * Preview of MCP servers parsed from an external (e.g. GitHub Copilot) configuration.
   */
  updateCopilotImportPreview?: (json: string) => void;

  /**
   * Update MCP servers list
   */
  updateMcpServers?: (json: string) => void;

  /**
   * Update MCP server connection status
   */
  updateMcpServerStatus?: (json: string) => void;

  /**
   * Update MCP server tools list
   */
  updateMcpServerTools?: (json: string) => void;

  mcpServerToggled?: (json: string) => void;

  /**
   * Update Codex MCP servers list (from ~/.codex/config.toml)
   */
  updateCodexMcpServers?: (json: string) => void;

  /**
   * Update Codex MCP server connection status
   */
  updateCodexMcpServerStatus?: (json: string) => void;

  /**
   * Codex MCP server toggled callback
   */
  codexMcpServerToggled?: (json: string) => void;

  /**
   * Codex MCP server added callback
   */
  codexMcpServerAdded?: (json: string) => void;

  /**
   * Codex MCP server updated callback
   */
  codexMcpServerUpdated?: (json: string) => void;

  /**
   * Codex MCP server deleted callback
   */
  codexMcpServerDeleted?: (json: string) => void;

  /**
   * Update providers list
   */
  updateProviders?: (json: string) => void;

  /**
   * Update active provider
   */
  updateActiveProvider?: (providerId: string) => void;

  updateThinkingEnabled?: (json: string) => void;

  /**
   * Update streaming enabled setting
   */
  updateStreamingEnabled?: (json: string) => void;

  /**
   * Update Codex sandbox mode setting
   */
  updateCodexSandboxMode?: (json: string) => void;

  /**
   * Update send shortcut setting
   */
  updateSendShortcut?: (json: string) => void;

  /**
   * Update auto open file enabled setting
   */
  updateAutoOpenFileEnabled?: (json: string) => void;

  /**
   * Update commit AI prompt configuration
   */
  updateCommitPrompt?: (json: string) => void;

  /**
   * Update project-level commit AI prompt configuration
   */
  updateProjectCommitPrompt?: (json: string) => void;

  /**
   * Update sound notification configuration
   */
  updateSoundNotificationConfig?: (json: string) => void;

  /**
   * Update AI commit generation enabled state
   */
  updateCommitGenerationEnabled?: (json: string) => void;

  /**
   * Update AI session title generation enabled state
   */
  updateAiTitleGenerationEnabled?: (json: string) => void;

  /**
   * Update status bar widget enabled state
   */
  updateStatusBarWidgetEnabled?: (json: string) => void;

  /**
   * Update task completion notification enabled state
   */
  updateTaskCompletionNotificationEnabled?: (json: string) => void;

  /**
   * Update AskUserQuestion reminder notification enabled state
   */
  updateAskUserQuestionNotificationEnabled?: (json: string) => void;

  /**
   * Update permission dialog timeout setting
   */
  updatePermissionDialogTimeout?: (json: string) => void;

  /**
   * Update current Claude config
   */
  updateCurrentClaudeConfig?: (json: string) => void;

  /**
   * Show error message
   */
  showError?: (message: string) => void;

  /**
   * Show switch success message
   */
  showSwitchSuccess?: (message: string) => void;

  /**
   * Update Node.js path
   */
  updateNodePath?: (path: string) => void;

  /**
   * Update custom Claude CLI path
   */
  updateClaudeCliPath?: (path: string) => void;

  /**
   * Update working directory configuration
   */
  updateWorkingDirectory?: (json: string) => void;

  /**
   * Update linkify/navigation capabilities used by Markdown rendering.
   */
  updateLinkifyCapabilities?: (json: string) => void;

  /**
   * File path resolved callback - receives the resolved absolute path for a file link tooltip.
   */
  onFilePathResolved?: (json: string) => void;

  /**
   * Show success message
   */
  showSuccess?: (message: string) => void;

  /**
   * Show success message with i18n key
   */
  showSuccessI18n?: (i18nKey: string) => void;

  /**
   * Update skills list
   */
  updateSkills?: (json: string) => void;

  /**
   * Skill import result callback
   */
  skillImportResult?: (json: string) => void;

  /**
   * Skill delete result callback
   */
  skillDeleteResult?: (json: string) => void;

  /**
   * Skill toggle result callback
   */
  skillToggleResult?: (json: string) => void;

  /**
   * Update usage statistics
   */
  updateUsageStatistics?: (json: string) => void;

  /**
   * Pending usage statistics before component mounts
   */
  __pendingUsageStatistics?: string;

  /**
   * Update slash commands list (from SDK)
   */
  updateSlashCommands?: (json: string) => void;

  /**
   * Update dollar commands list (for $ autocomplete)
   */
  updateDollarCommands?: (json: string) => void;

  /**
   * Pending dollar commands payload before callback registration
   */
  __pendingDollarCommands?: string;

  /**
   * Pending slash commands payload before provider initialization
   */
  __pendingSlashCommands?: string;

  /**
   * Pending session ID before App component mounts (for rewind feature)
   */
  __pendingSessionId?: string;

  /**
   * Apply IDEA editor font configuration (called from Java backend)
   * @param config Font configuration object containing fontFamily, fontSize, lineSpacing, fallbackFonts
   */
  applyIdeaFontConfig?: (config: {
    fontFamily: string;
    fontSize: number;
    lineSpacing: number;
    fallbackFonts?: string[];
  }) => void;

  /**
   * Pending font config before applyIdeaFontConfig is registered
   */
  __pendingFontConfig?: {
    fontFamily: string;
    fontSize: number;
    lineSpacing: number;
    fallbackFonts?: string[];
  };

  /**
   * Apply effective plugin UI font configuration (called from Java backend)
   */
  applyUiFontConfig?: (config: import('./types/uiFontConfig').UiFontConfig | string) => void;

  /**
   * Apply effective plugin code font configuration (called from Java backend)
   */
  applyCodeFontConfig?: (config: import('./types/uiFontConfig').CodeFontConfig | string) => void;

  /**
   * Pending effective UI font config before applyUiFontConfig is registered
   */
  __pendingUiFontConfig?: import('./types/uiFontConfig').UiFontConfig;

  /**
   * Pending effective code font config before applyCodeFontConfig is registered
   */
  __pendingCodeFontConfig?: import('./types/uiFontConfig').CodeFontConfig;

  /**
   * Apply IDEA language configuration (called from Java backend)
   * @param config Language configuration object containing language code and IDEA locale
   */
  applyIdeaLanguageConfig?: (config: {
    language: string;
    source?: string;
    ideaLocale?: string;
  } | string) => void;

  /**
   * Pending language config before applyIdeaLanguageConfig is registered
   */
  __pendingLanguageConfig?: {
    language: string;
    source?: string;
    ideaLocale?: string;
  };

  /**
   * Update enhanced prompt result (for prompt enhancer feature)
   */
  updateEnhancedPrompt?: (result: string) => void;

  /**
   * Update prompt enhancer settings config from backend
   */
  updatePromptEnhancerConfig?: (json: string) => void;

  /**
   * Update commit AI settings config from backend
   */
  updateCommitAiConfig?: (json: string) => void;

  /**
   * Update session title (called when AI generates a title).
   * @param sessionId - The session ID the title belongs to
   * @param title - The generated title text
   */
  updateSessionTitle?: (sessionId: string, title: string) => void;

  /**
   * Editor font config received callback - receives IDEA editor font configuration
   */
  onEditorFontConfigReceived?: (json: string) => void;

  /**
   * Effective UI font config received callback
   */
  onUiFontConfigReceived?: (json: string) => void;

  /**
   * Effective code font config received callback
   */
  onCodeFontConfigReceived?: (json: string) => void;

  /**
   * IDE theme received callback - receives IDE theme configuration
   */
  onIdeThemeReceived?: (json: string) => void;

  /**
   * IDE theme changed callback - invoked when the IDE theme changes
   */
  onIdeThemeChanged?: (json: string) => void;

  /**
   * Update agents list
   */
  updateAgents?: (json: string) => void;

  /**
   * Agent operation result callback
   */
  agentOperationResult?: (json: string) => void;

  /**
   * Agent import preview result callback
   */
  agentImportPreviewResult?: (json: string) => void;

  /**
   * Agent import result callback
   */
  agentImportResult?: (json: string) => void;

  /**
   * Update prompts list
   */
  updatePrompts?: (json: string) => void;

  /**
   * Update global prompts list
   */
  updateGlobalPrompts?: (json: string) => void;

  /**
   * Update project prompts list
   */
  updateProjectPrompts?: (json: string) => void;

  /**
   * Update project info
   */
  updateProjectInfo?: (json: string) => void;

  /**
   * Prompt operation result callback
   */
  promptOperationResult?: (json: string) => void;

  /**
   * Prompt import preview result callback
   */
  promptImportPreviewResult?: (json: string) => void;

  /**
   * Prompt import result callback
   */
  promptImportResult?: (json: string) => void;

  /**
   * Selected agent received callback - receives the currently selected agent during initialization
   */
  onSelectedAgentReceived?: (json: string) => void;

  /**
   * Selected agent changed callback - invoked after an agent is selected
   */
  onSelectedAgentChanged?: (json: string) => void;

  /**
   * Update Codex providers list
   */
  updateCodexProviders?: (json: string) => void;

  /**
   * Update Codex subscription quota snapshot.
   */
  updateCodexSubscriptionQuota?: (json: string) => void;

  /**
   * Update active Codex provider
   */
  updateActiveCodexProvider?: (json: string) => void;

  /**
   * Update Node process management snapshot.
   * Payload: { snapshotAt, totals: { daemon, channel, orphan, all }, processes: NodeProcessInfo[] }
   */
  updateNodeProcesses?: (json: string) => void;

  /**
   * Result of a kill_node_process / kill_all_orphans / restart_node_daemon call.
   * Payload: { pid?, success?, killed?, restart?, error? }
   */
  nodeProcessKillResult?: (json: string) => void;

  /**
   * Update current Codex config (from ~/.codex/)
   */
  updateCurrentCodexConfig?: (json: string) => void;

// ============================================================================
  // Streaming Callbacks
  // ============================================================================

  /**
   * Stream start callback - called when streaming begins
   */
  onStreamStart?: (mode?: string | boolean) => void;

  /**
   * Content delta callback - called when a content delta is received
   * @param delta The content delta string
   */
  onContentDelta?: (delta: string) => void;

  /**
   * Thinking delta callback - called when a thinking delta is received
   * @param delta The thinking delta string
   */
  onThinkingDelta?: (delta: string) => void;

  /**
   * Block reset callback - called when a new assistant message starts within
   * an ongoing stream (e.g., after a tool_use loop iteration). Frontend should
   * clear streaming content refs to prevent cross-turn content merging.
   */
  onBlockReset?: () => void;

  /**
   * Stream end callback - called when streaming ends
   */
  onStreamEnd?: (sequence?: string | number) => void;

  /**
   * Streaming heartbeat callback - lightweight signal from backend during
   * tool execution phases to prevent the stall watchdog from falsely triggering.
   */
  onStreamingHeartbeat?: () => void;

  /**
   * Permission denied callback - called when permission is denied.
   * Marks incomplete tool calls as "interrupted".
   */
  onPermissionDenied?: () => void;

  /**
   * Set of denied tool call IDs.
   * Used by tool blocks to determine which tool calls had their permission denied by the user.
   */
  __deniedToolIds?: Set<string>;

  /**
   * Session transition suppression flag.
   * Set to true during new session creation to prevent stale callbacks from writing old messages via updateMessages.
   */
  __sessionTransitioning?: boolean;

  /**
   * Session transition token (debug/logging only).
   * Regenerated for each logical transition so callbacks can identify the active transition
   * generation in logs. NOT used for guard logic — the boolean __sessionTransitioning flag
   * is the actual guard.
   */
  __sessionTransitionToken?: string | null;

  /**
   * Resets all transient UI state (loading, streaming, toasts, refs) in one shot.
   * Called by beginSessionTransition (useSessionManagement) to synchronously
   * clear both React state AND internal refs before starting a new session.
   */
  __resetTransientUiState?: () => void;

  /**
   * Timestamp of the last streaming activity (content/thinking delta or message update).
   * Used by the stream stall watchdog to detect when the backend→frontend bridge is broken.
   */
  __lastStreamActivityAt?: number;

  /**
   * The __turnId of the most recently ended streaming turn.
   * Used by mergeConsecutiveAssistantMessages to distinguish recently-ended
   * streaming messages from true history messages and prevent incorrect merging.
   * Cleared after 5 seconds or when a new turn starts.
   * @default undefined (no recently ended turn)
   */
  __lastStreamEndedTurnId?: number;

  /**
   * Timestamp when the last streaming turn ended (via onStreamEnd).
   * Used with __lastStreamEndedTurnId to implement a time-based cleanup.
   * @default undefined (no stream end recorded)
   */
   __lastStreamEndedAt?: number;

   /**
    * Turn ID for which onStreamEnd has already been processed.
    * Used as an idempotency guard: when dual-path delivery sends onStreamEnd
    * twice (primary via flush callback + fallback via Alarm), only the first
    * arrival takes effect; the second is a no-op.
    * Cleared in onStreamStart to allow the next turn.
    * @default undefined (no processed turn)
    */
   __streamEndProcessedTurnId?: number;

   /**
   * Timestamp when the current streaming turn started.
   * Used to calculate durationMs on the assistant message when the stream ends.
   */
  __turnStartedAt?: number;

  /**
   * Interval handle for the stream stall watchdog.
   * Stored on window so re-registration of streaming callbacks clears the previous interval.
   */
  __stallWatchdogInterval?: ReturnType<typeof setInterval> | null;

  /**
   * Pending rAF handle and JSON for deferred updateMessages processing.
   * Stored on window so re-registration of message callbacks cancels stale rAFs.
   */
  __pendingUpdateRaf?: number | null;
  __pendingUpdateJson?: string | null;
  __pendingUpdateSequence?: number | null;
  __minAcceptedUpdateSequence?: number;
  /** Cancel pending rAF-deferred updateMessages (set by messageCallbacks, called by onStreamEnd). */
  __cancelPendingUpdateMessages?: () => void;

  /**
   * Rewind result callback - returns the result of a rewind operation
   */
  onRewindResult?: (json: string) => void;

  /**
   * Undo file result callback - returns the result of a single-file undo operation
   */
  onUndoFileResult?: (json: string) => void;

  /**
   * Undo all files result callback - returns the result of a batch undo operation
   */
  onUndoAllFileResult?: (json: string) => void;

  /**
   * Handle remove file from edits list - removes a file from the edits list (called when the user fully reverts changes in the diff view)
   */
  handleRemoveFileFromEdits?: (json: string) => void;

  /**
   * Handle interactive diff result - processes the result of an interactive diff action (Apply/Reject)
   * @param json JSON string containing { filePath, action, content?, error? }
   */
  handleDiffResult?: (json: string) => void;

  // ============================================================================
  // Dependency Management Callbacks
  // ============================================================================

  /**
   * Update dependency status callback
   */
  updateDependencyStatus?: (json: string) => void;

  /**
   * Dependency install progress callback
   */
  dependencyInstallProgress?: (json: string) => void;

  /**
   * Dependency install result callback
   */
  dependencyInstallResult?: (json: string) => void;

  /**
   * Dependency uninstall result callback
   */
  dependencyUninstallResult?: (json: string) => void;

  /**
   * Node environment status callback
   */
  nodeEnvironmentStatus?: (json: string) => void;

  /**
   * Trigger Node environment re-check.
   */
  checkNodeEnvironment?: () => void;

  /**
   * Trigger concurrent Node environment checks for diagnostics.
   */
  runNodeEnvironmentStressTest?: (count?: number) => void;

  /**
   * Dependency update available callback
   */
  dependencyUpdateAvailable?: (json: string) => void;

  /**
   * Dependency versions loaded callback
   */
  dependencyVersionsLoaded?: (json: string) => void;

  /**
   * Pending dependency versions payload before settings initialization
   */
  __pendingDependencyVersions?: string;

  /**
   * Pending dependency updates payload before settings initialization
   */
  __pendingDependencyUpdates?: string;

  /**
   * Pending dependency status payload before React initialization
   */
  __pendingDependencyStatus?: string;

  /**
   * Pending streaming enabled status before React initialization
   */
  __pendingStreamingEnabled?: string;

  /**
   * Pending send shortcut status before React initialization
   */
  __pendingSendShortcut?: string;

  /**
   * Pending auto open file enabled status before React initialization
   */
  __pendingAutoOpenFileEnabled?: string;

  /**
   * Pending permission dialog timeout before React initialization
   */
  __pendingPermissionDialogTimeout?: string;

  __pendingPermissionDialogRequests?: string[];

  __pendingAskUserQuestionDialogRequests?: string[];

  __pendingPlanApprovalDialogRequests?: string[];

  /**
   * Pending updateMessages payload before React initialization
   */
  __pendingUpdateMessages?: string | { json: string; sequence?: number | null };

  /**
   * Pending status text before React initialization
   */
  __pendingStatusText?: string;

  /**
   * Pending summary text before React initialization
   */
  __pendingSummaryText?: string;

  /**
   * Pending user message before addUserMessage is registered (for Quick Fix feature)
   */
  __pendingUserMessage?: string;

  /**
   * Pending loading state before showLoading is registered (for Quick Fix feature)
   */
  __pendingLoadingState?: boolean;

  /**
   * Pending mode payload before setMode is registered.
   */
  __pendingModeReceived?: string;

  /**
   * Execute context action from IDEA shortcut (copy/cut/send)
   */
  execContextAction?: (action: string) => void;

  /**
   * Clipboard read callback for paste from IDEA shortcut
   */
  onClipboardRead?: (text: string) => void;

  // ============================================================================
  // Theme initialization (Java pre-injects before React boots)
  // ============================================================================

  /**
   * Initial IDE theme injected by Java into the HTML before React boots.
   * Used by useThemeInit to avoid a flash of incorrect theme.
   */
  __INITIAL_IDE_THEME__?: 'light' | 'dark';

  /**
   * Per-tab provider id ("claude" / "codex") injected by Java into the HTML
   * before React boots. Used by useModelStatePersistence to override the
   * global localStorage snapshot ("model-selection-state") when the backend
   * has already restored a provider for this tab. Empty / unset means no
   * backend preference — fall back to localStorage. See issue #1353.
   */
  __INITIAL_TAB_PROVIDER__?: string;

  /**
   * Per-tab model id injected by Java, used the same way as
   * __INITIAL_TAB_PROVIDER__. Empty / unset means no backend preference.
   */
  __INITIAL_TAB_MODEL__?: string;

  // ============================================================================
  // Provider settings panel callbacks (registered by ProviderList)
  // ============================================================================

  /**
   * CLI login account info callback. Java pushes the logged-in account email
   * after a successful CLI login to update the settings panel.
   */
  updateCliLoginAccountInfo?: (email: string) => void;

  /**
   * Provider import preview result callback. Java pushes a JSON string or
   * parsed payload describing the providers detected during import preview.
   */
  import_preview_result?: (dataOrStr: string | { providers?: unknown }) => void;

  /**
   * Backend notification callback (variadic for backward compatibility).
   * Modern callers pass (type, title, message); legacy callers pass a single
   * JSON string or object with shape { type, title, message }.
   */
  backend_notification?: (...args: unknown[]) => void;
}
