package com.github.claudecodegui.session;

import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.settings.CodexSettingsManager;
import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.grok.GrokSDKBridge;
import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.github.claudecodegui.provider.common.MessageCallback;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Owns message-send orchestration while ClaudeSession remains the public session facade.
 */
public class SessionSendService {

    private static final Logger LOG = Logger.getInstance(SessionSendService.class);
    public static final String CODEX_FAST_SERVICE_TIER = "fast";

    private final Project project;
    private final SessionState state;
    private final SessionCallbackFacade callbackFacade;
    private final MessageParser messageParser;
    private final MessageMerger messageMerger;
    private final Gson gson;
    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;
    private final GrokSDKBridge grokSDKBridge;
    private final Map<String, MarkerCliBridge> cliBridges;
    private final SessionContextService contextService;

    public SessionSendService(
            Project project,
            SessionState state,
            SessionCallbackFacade callbackFacade,
            MessageParser messageParser,
            MessageMerger messageMerger,
            Gson gson,
            ClaudeSDKBridge claudeSDKBridge,
            CodexSDKBridge codexSDKBridge,
            Map<String, MarkerCliBridge> cliBridges,
            SessionContextService contextService
    ) {
        this(project, state, callbackFacade, messageParser, messageMerger, gson,
                claudeSDKBridge, codexSDKBridge, cliBridges, contextService, null);
    }

    public SessionSendService(
            Project project,
            SessionState state,
            SessionCallbackFacade callbackFacade,
            MessageParser messageParser,
            MessageMerger messageMerger,
            Gson gson,
            ClaudeSDKBridge claudeSDKBridge,
            CodexSDKBridge codexSDKBridge,
            Map<String, MarkerCliBridge> cliBridges,
            SessionContextService contextService,
            GrokSDKBridge grokSDKBridge
    ) {
        this.project = project;
        this.state = state;
        this.callbackFacade = callbackFacade;
        this.messageParser = messageParser;
        this.messageMerger = messageMerger;
        this.gson = gson;
        this.claudeSDKBridge = claudeSDKBridge;
        this.codexSDKBridge = codexSDKBridge;
        this.grokSDKBridge = grokSDKBridge;
        this.cliBridges = cliBridges != null ? cliBridges : Collections.emptyMap();
        this.contextService = contextService;
    }

    public void prepareContextCollector(EditorContextCollector contextCollector) {
        contextCollector.setPsiContextEnabled(state.isPsiContextEnabled());
        contextCollector.setAutoOpenFileEnabled(readAutoOpenFileEnabled());
    }

    public void updateSessionStateForSend(ClaudeSession.Message userMessage, String normalizedInput) {
        state.addMessage(userMessage);
        callbackFacade.notifyMessageUpdate(state.getMessages());

        if (state.getSummary() == null) {
            String baseSummary = (userMessage.content != null && !userMessage.content.isEmpty())
                    ? userMessage.content
                    : normalizedInput;
            String newSummary = baseSummary.length() > 45 ? baseSummary.substring(0, 45) + "..." : baseSummary;
            state.setSummary(newSummary);
            callbackFacade.notifySummaryReceived(newSummary);
        }

        state.updateLastModifiedTime();
        state.setError(null);
        state.setBusy(true);
        state.setLoading(true);
        ClaudeNotifier.setWaiting(project);
        callbackFacade.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    public CompletableFuture<Void> sendMessageToProvider(
            String channelId,
            String input,
            List<ClaudeSession.Attachment> attachments,
            JsonObject openedFilesJson,
            String externalAgentPrompt,
            List<String> fileTagPaths,
            String requestedPermissionMode,
            String requestedReasoningEffort,
            String requestedCodexFastMode,
            String requestedDshPreset
    ) {
        String agentPrompt = externalAgentPrompt;
        if (agentPrompt == null) {
            agentPrompt = getAgentPrompt();
            LOG.info("[Agent] Using agent from global setting (fallback)");
        } else {
            LOG.info("[Agent] Using agent from message (per-tab selection)");
        }

        String currentProvider = state.getProvider();
        String sessionModeBeforeSend = state.getPermissionMode();
        String normalizedRequestedMode = normalizeRequestedPermissionMode(requestedPermissionMode);
        String effectivePermissionMode = resolveEffectivePermissionMode(
                currentProvider,
                normalizedRequestedMode,
                sessionModeBeforeSend
        );

        LOG.info(
                "[ModeSync][Backend] provider=" + currentProvider
                        + ", requested=" + (normalizedRequestedMode != null ? normalizedRequestedMode : "(none)")
                        + ", session=" + (sessionModeBeforeSend != null ? sessionModeBeforeSend : "(none)")
                        + ", effective=" + effectivePermissionMode
        );

        String normalizedRequestedEffort = normalizeRequestedReasoningEffort(requestedReasoningEffort);

        if ("codex".equals(currentProvider)) {
            String effectiveCodexServiceTier = resolveEffectiveCodexServiceTier(
                    requestedCodexFastMode,
                    state.getCodexServiceTier()
            );
            return sendToCodex(
                    channelId,
                    input,
                    attachments,
                    openedFilesJson,
                    agentPrompt,
                    fileTagPaths,
                    effectivePermissionMode,
                    normalizedRequestedEffort,
                    effectiveCodexServiceTier
            );
        }

        if ("grok".equals(currentProvider) && grokSDKBridge != null) {
            return sendToGrok(
                    channelId,
                    input,
                    attachments,
                    openedFilesJson,
                    agentPrompt,
                    fileTagPaths,
                    effectivePermissionMode,
                    normalizedRequestedEffort
            );
        }

        if (cliBridges.containsKey(currentProvider) && !"grok".equals(currentProvider)) {
            if ("dsh".equals(currentProvider) && requestedDshPreset != null) {
                state.setDshPreset(requestedDshPreset);
            }
            return sendToCliProvider(
                    currentProvider,
                    channelId,
                    input,
                    attachments,
                    openedFilesJson,
                    agentPrompt,
                    fileTagPaths,
                    normalizedRequestedEffort,
                    effectivePermissionMode
            );
        }

        return sendToClaude(channelId, input, attachments, openedFilesJson, agentPrompt,
                effectivePermissionMode, normalizedRequestedEffort);
    }

    public static String normalizeRequestedReasoningEffort(String effort) {
        if (effort == null) {
            return null;
        }
        String trimmed = effort.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        if (SessionState.isValidReasoningEffort(trimmed)) {
            return trimmed;
        }
        LOG.warn("[ReasoningEffort][Backend] Invalid requested reasoningEffort ignored: " + effort);
        return null;
    }

    public static String normalizeRequestedPermissionMode(String mode) {
        if (mode == null) {
            return null;
        }
        String trimmed = mode.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        if ("autoEdit".equals(trimmed)) {
            return "acceptEdits";
        }
        if (SessionState.isValidPermissionMode(trimmed)) {
            return trimmed;
        }
        LOG.warn("[ModeSync][Backend] Invalid requested permissionMode ignored: " + mode);
        return null;
    }

    public static String resolveEffectivePermissionMode(String provider, String requestedMode, String sessionMode) {
        String resolvedMode = requestedMode;
        if (resolvedMode == null) {
            resolvedMode = normalizeRequestedPermissionMode(sessionMode);
        }
        if (resolvedMode == null) {
            resolvedMode = "default";
        }

        boolean isProviderWithoutPlanMode = "codex".equals(provider)
                || "grok".equals(provider)
                || (SessionProviderRouter.isCliProvider(provider) && !"omp".equals(provider));
        boolean isCliProviderWithoutNativeAuto = SessionProviderRouter.isCliProvider(provider);
        // Codex and Grok run as full SDK bridges (not MarkerCli providers, so they
        // are absent from CLI_PROVIDER_IDS), but like the headless CLI providers
        // they have no plan-mode equivalent — so plan still downgrades to default.
        // EXCEPT omp, where "plan" is a model role (`omp --model plan`), not Claude
        // plan mode. Native auto review is limited to Claude/Codex; Grok retains its
        // existing internal auto-approve alias, while the Webview still hides auto there.
        if (isProviderWithoutPlanMode
                && "plan".equals(resolvedMode)) {
            return "default";
        }
        if (isCliProviderWithoutNativeAuto && "auto".equals(resolvedMode)) {
            return "default";
        }
        return resolvedMode;
    }

    public static String getCodexRuntimeAccessError(String accessMode) {
        if (CodemossSettingsService.CODEX_RUNTIME_ACCESS_MANAGED.equals(accessMode)
                || CodemossSettingsService.CODEX_RUNTIME_ACCESS_CLI_LOGIN.equals(accessMode)) {
            return null;
        }
        return ClaudeCodeGuiBundle.message("error.codexLocalAccessNotAuthorized");
    }

    public static String normalizeRequestedCodexServiceTier(String value) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        if ("fast".equalsIgnoreCase(trimmed) || "priority".equalsIgnoreCase(trimmed)) {
            return CODEX_FAST_SERVICE_TIER;
        }
        if ("normal".equalsIgnoreCase(trimmed)
                || "standard".equalsIgnoreCase(trimmed)
                || "default".equalsIgnoreCase(trimmed)
                || "none".equalsIgnoreCase(trimmed)) {
            return null;
        }
        LOG.warn("[Codex] Invalid fast mode/service tier ignored: " + value);
        return null;
    }

    public static String resolveEffectiveCodexServiceTier(String requestedValue, String sessionValue) {
        String requested = normalizeRequestedCodexServiceTier(requestedValue);
        if (requested != null) {
            return requested;
        }
        if (isExplicitCodexStandardMode(requestedValue)) {
            return null;
        }

        String session = normalizeRequestedCodexServiceTier(sessionValue);
        return session;
    }

    public static boolean isExplicitCodexStandardMode(String value) {
        if (value == null) {
            return false;
        }
        String trimmed = value.trim();
        return "normal".equalsIgnoreCase(trimmed)
                || "standard".equalsIgnoreCase(trimmed)
                || "default".equalsIgnoreCase(trimmed)
                || "none".equalsIgnoreCase(trimmed);
    }

    private CompletableFuture<Void> sendToCodex(
            String channelId,
            String input,
            List<ClaudeSession.Attachment> attachments,
            JsonObject openedFilesJson,
            String agentPrompt,
            List<String> fileTagPaths,
            String effectivePermissionMode,
            String requestedReasoningEffort,
            String effectiveCodexServiceTier
    ) {
        CodexMessageHandler handler = new CodexMessageHandler(state, callbackFacade.getCallbackHandler());
        String accessMode = CodemossSettingsService.CODEX_RUNTIME_ACCESS_INACTIVE;
        try {
            accessMode = new CodemossSettingsService().getCodexRuntimeAccessMode();
        } catch (Exception e) {
            LOG.warn("[Codex] Failed to resolve runtime access mode: " + e.getMessage());
        }

        String accessError = getCodexRuntimeAccessError(accessMode);
        if (accessError != null) {
            handler.onError(accessError);
            return CompletableFuture.completedFuture(null);
        }

        String contextAppend = contextService.buildCodexContextAppend(openedFilesJson, fileTagPaths);
        String finalInput = (input != null ? input : "") + contextAppend;
        String configuredModel = new CodexSettingsManager(gson).resolveModelAlias(state.getModel());

        return codexSDKBridge.sendMessage(
                channelId,
                finalInput,
                state.getSessionId(),
                state.getCwd(),
                attachments,
                effectivePermissionMode,
                configuredModel,
                agentPrompt,
                requestedReasoningEffort != null ? requestedReasoningEffort : state.getReasoningEffort(),
                effectiveCodexServiceTier,
                handler
        ).thenApply(result -> null);
    }

    private CompletableFuture<Void> sendToGrok(
            String channelId,
            String input,
            List<ClaudeSession.Attachment> attachments,
            JsonObject openedFilesJson,
            String agentPrompt,
            List<String> fileTagPaths,
            String effectivePermissionMode,
            String requestedReasoningEffort
    ) {
        if (grokSDKBridge == null) {
            LOG.error("[Lifecycle] sendToGrok called but GrokSDKBridge is null");
            callbackFacade.notifyStateChange(false, false, "Grok bridge not available");
            return CompletableFuture.completedFuture(null);
        }
        GrokMessageHandler handler = new GrokMessageHandler(state, callbackFacade.getCallbackHandler());
        Boolean streaming = readStreamingEnabled();
        final String runtimeSessionEpoch = state.getRuntimeSessionEpoch();
        final String currentModel = state.getModel();
        String projectBase = project != null ? project.getBasePath() : null;
        String guardedCwd = com.github.claudecodegui.util.PathUtils.guardWorkingDirectory(
                state.getCwd(), projectBase);
        if (guardedCwd == null) {
            guardedCwd = state.getCwd();
        } else if (state.getCwd() == null || !guardedCwd.equals(state.getCwd())) {
            LOG.warn("[Lifecycle] sendToGrok cwd guard: " + state.getCwd() + " -> " + guardedCwd);
            state.setCwd(guardedCwd);
        }
        LOG.info("[Lifecycle] sendToGrok sessionId=" + (state.getSessionId() != null ? state.getSessionId() : "(new)")
                + ", epoch=" + runtimeSessionEpoch
                + ", cwd=" + guardedCwd
                + ", model=" + currentModel
                + ", fileTags=" + (fileTagPaths != null ? fileTagPaths.size() : 0));

        return grokSDKBridge.sendMessage(
                channelId,
                input,
                state.getSessionId(),
                runtimeSessionEpoch,
                guardedCwd,
                attachments,
                effectivePermissionMode,
                currentModel,
                openedFilesJson,
                agentPrompt,
                streaming,
                false,
                requestedReasoningEffort != null ? requestedReasoningEffort : state.getReasoningEffort(),
                handler
        ).thenApply(result -> null);
    }

    private CompletableFuture<Void> sendToCliProvider(
            String provider,
            String channelId,
            String input,
            List<ClaudeSession.Attachment> attachments,
            JsonObject openedFilesJson,
            String agentPrompt,
            List<String> fileTagPaths,
            String requestedReasoningEffort,
            String permissionMode
    ) {
        MarkerCliBridge bridge = cliBridges.get(provider);
        if (bridge == null) {
            MessageCallback missingHandler = createCliMessageHandler(provider);
            missingHandler.onError("CLI provider not registered: " + provider);
            return CompletableFuture.completedFuture(null);
        }

        // Grok has a dedicated handler (multi-turn assistant ownership + no user-echo
        // dupes). Other CLI providers reuse Codex streaming marker handling.
        MessageCallback handler = createCliMessageHandler(provider);

        String contextAppend = contextService.buildCodexContextAppend(openedFilesJson, fileTagPaths);
        String finalInput = (input != null ? input : "") + contextAppend;
        if (agentPrompt != null && !agentPrompt.isEmpty()) {
            finalInput = finalInput + "\n\n## Agent Role and Instructions\n\n" + agentPrompt;
            LOG.info("[Agent] ✓ Appending agentPrompt to user message for " + provider
                    + " (length: " + agentPrompt.length() + " chars)");
        }

        String effort = normalizeCliReasoningEffort(
                requestedReasoningEffort != null ? requestedReasoningEffort : state.getReasoningEffort()
        );
        String modelForCli = normalizeCliModelForProvider(provider, state.getModel());
        String effectiveMode = permissionMode != null && !permissionMode.isBlank()
                ? permissionMode
                : "default";
        int attachmentCount = attachments != null ? attachments.size() : 0;

        LOG.info("[Lifecycle] sendToCli provider=" + provider
                + " sessionId=" + (state.getSessionId() != null ? state.getSessionId() : "(new)")
                + ", cwd=" + state.getCwd()
                + ", modelRaw=" + state.getModel()
                + ", modelCli=" + (modelForCli != null ? modelForCli : "(config-default)")
                + ", effort=" + effort
                + ", permissionMode=" + effectiveMode
                + ", attachments=" + attachmentCount);

        return bridge.sendMessage(
                channelId,
                finalInput,
                state.getSessionId(),
                state.getCwd(),
                modelForCli != null ? modelForCli : "",
                effort,
                attachments,
                effectiveMode,
                "dsh".equals(provider) ? state.getDshPreset() : null,
                handler
        ).thenApply(result -> null);
    }

    /**
     * Build the marker-stream callback for a CLI provider.
     * Grok uses {@link GrokMessageHandler} so each stream owns a dedicated assistant
     * bubble and ACP user echoes never re-append the send-time user message.
     */
    MessageCallback createCliMessageHandler(String provider) {
        CallbackHandler callbacks = callbackFacade.getCallbackHandler();
        if ("grok".equals(provider)) {
            return new GrokMessageHandler(state, callbacks);
        }
        return new CodexMessageHandler(state, callbacks);
    }

    static String normalizeCliReasoningEffort(String effort) {
        if (effort == null) {
            return "medium";
        }
        String normalized = effort.trim().toLowerCase();
        if ("low".equals(normalized) || "medium".equals(normalized) || "high".equals(normalized)) {
            return normalized;
        }
        return "medium";
    }

    /**
     * Map UI model selection to CLI model flag. Returns null to omit the flag
     * (provider CLI uses its own default / config).
     */
    static String normalizeCliModelForProvider(String provider, String model) {
        if (model == null) {
            return null;
        }
        String trimmed = model.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        String lower = trimmed.toLowerCase();
        if ("__config_default__".equals(lower)
                || "auto".equals(lower)
                || "default".equals(lower)
                || "(default)".equals(lower)
                || "config-default".equals(lower)
                || "config_default".equals(lower)
                || "opencode default".equals(lower)
                || "opencode-default".equals(lower)
                || "dsh-default".equals(lower)) {
            return null;
        }
        // Leftovers after a provider switch without model reset. OpenCode
        // legitimately supports OpenAI models, so gpt-* is only filtered for
        // the other CLI providers.
        if (lower.startsWith("claude-") || (lower.startsWith("gpt-") && !"opencode".equals(provider))) {
            LOG.warn("[" + provider + "] Ignoring non-provider model leftover for CLI: " + trimmed);
            return null;
        }
        if ("grok".equals(provider)) {
            if ("grok".equals(lower) || "default".equals(lower) || "(default)".equals(lower)
                    || "grok-4.5".equals(lower)) {
                LOG.info("[Grok] Normalizing sentinel model id '" + trimmed + "' to default model 'grok-4.6'");
                return "grok-4.6";
            }
        }
        return trimmed;
    }

    /**
     * @deprecated use {@link #normalizeCliModelForProvider(String, String)}
     */
    @Deprecated
    static String normalizeGrokModelForCli(String model) {
        return normalizeCliModelForProvider("grok", model);
    }

    private CompletableFuture<Void> sendToClaude(
            String channelId,
            String input,
            List<ClaudeSession.Attachment> attachments,
            JsonObject openedFilesJson,
            String agentPrompt,
            String effectivePermissionMode,
            String requestedReasoningEffort
    ) {
        ClaudeMessageHandler handler = new ClaudeMessageHandler(
                project,
                state,
                callbackFacade.getCallbackHandler(),
                messageParser,
                messageMerger,
                gson
        );

        Boolean streaming = readStreamingEnabled();
        final String runtimeSessionEpoch = state.getRuntimeSessionEpoch();
        final String currentModel = state.getModel();
        LOG.info("[Lifecycle] sendToClaude sessionId=" + (state.getSessionId() != null ? state.getSessionId() : "(new)")
                + ", epoch=" + runtimeSessionEpoch
                + ", cwd=" + state.getCwd()
                + ", model=" + currentModel);

        return claudeSDKBridge.sendMessage(
                        channelId,
                        input,
                        state.getSessionId(),
                        runtimeSessionEpoch,
                        state.getCwd(),
                        attachments,
                        effectivePermissionMode,
                        currentModel,
                        openedFilesJson,
                        agentPrompt,
                        streaming,
                        false,
                        requestedReasoningEffort != null ? requestedReasoningEffort : state.getReasoningEffort(),
                        handler
                ).thenApply(result -> null);
    }

    private boolean readAutoOpenFileEnabled() {
        try {
            String projectPath = project.getBasePath();
            if (projectPath != null) {
                CodemossSettingsService settingsService = new CodemossSettingsService();
                boolean autoOpenFileEnabled = settingsService.getAutoOpenFileEnabled(projectPath);
                LOG.info("[EditorContext] Auto open file enabled: " + autoOpenFileEnabled);
                return autoOpenFileEnabled;
            }
        } catch (Exception e) {
            LOG.warn("[EditorContext] Failed to read autoOpenFileEnabled setting: " + e.getMessage());
        }
        return false;
    }

    private Boolean readStreamingEnabled() {
        Boolean streaming = null;
        try {
            String projectPath = project.getBasePath();
            if (projectPath != null) {
                CodemossSettingsService settingsService = new CodemossSettingsService();
                streaming = settingsService.getStreamingEnabled(projectPath);
                LOG.info("[Streaming] Read streaming config: " + streaming);
            }
        } catch (Exception e) {
            LOG.warn("[Streaming] Failed to read streaming config: " + e.getMessage());
        }
        return streaming;
    }

    private String getAgentPrompt() {
        try {
            CodemossSettingsService settingsService = new CodemossSettingsService();
            String selectedAgentId = settingsService.getSelectedAgentId();
            LOG.info("[Agent] Checking selected agent ID: " + (selectedAgentId != null ? selectedAgentId : "null"));

            if (selectedAgentId != null && !selectedAgentId.isEmpty()) {
                JsonObject agent = settingsService.getAgent(selectedAgentId);
                if (agent != null && agent.has("prompt") && !agent.get("prompt").isJsonNull()) {
                    String agentPrompt = agent.get("prompt").getAsString();
                    String agentName = agent.has("name") ? agent.get("name").getAsString() : "Unknown";
                    LOG.info("[Agent] ✓ Found agent: " + agentName);
                    LOG.info("[Agent] ✓ Prompt length: " + agentPrompt.length() + " chars");
                    LOG.info("[Agent] ✓ Prompt preview: "
                            + (agentPrompt.length() > 100 ? agentPrompt.substring(0, 100) + "..." : agentPrompt));
                    return agentPrompt;
                }
                LOG.info("[Agent] ✗ Agent found but no prompt configured");
            } else {
                LOG.info("[Agent] ✗ No agent selected");
            }
        } catch (Exception e) {
            LOG.warn("[Agent] ✗ Failed to get agent prompt: " + e.getMessage());
        }
        return null;
    }
}
