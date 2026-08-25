package com.github.claudecodegui.session;

import com.github.claudecodegui.handler.SettingsHandler;
import com.github.claudecodegui.notifications.ClaudeNotifier;
import com.github.claudecodegui.util.TokenUsageUtils;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;

/**
 * Owns session-history loading and post-send message reconciliation.
 */
public class SessionMessageOrchestrator {

    private static final Logger LOG = Logger.getInstance(SessionMessageOrchestrator.class);
    private static final int MAX_UUID_SYNC_RETRIES = 3;

    public interface SessionHistoryAccess {
        List<JsonObject> getProviderSessionMessages(String provider, String sessionId, String cwd);

        JsonObject getLatestClaudeUserMessage(String sessionId, String cwd);

        /**
         * Load a page of Claude session history (turn-based pagination).
         * Returns null when the provider does not support pagination or the
         * query fails; the caller should fall back to getProviderSessionMessages.
         */
        default JsonObject getProviderSessionMessagesPage(String sessionId, String cwd, Integer beforeTurn, int limit) {
            return null;
        }
    }

    @FunctionalInterface
    public interface UsageDisplay {
        void show(int usedTokens, int maxTokens);
    }

    private final SessionState state;
    private final MessageParser messageParser;
    private final SessionCallbackFacade callbackFacade;
    private final SessionHistoryAccess historyAccess;
    private final UsageDisplay usageDisplay;
    private final long initialUuidSyncDelayMs;
    private final long uuidRetryDelayMs;

    // Claude history pagination state
    private volatile int claudeHistoryFromTurn = 0;
    private volatile int claudeHistoryTotalTurns = 0;
    private volatile boolean claudeHistoryHasMore = false;

    public SessionMessageOrchestrator(
            Project project,
            SessionState state,
            MessageParser messageParser,
            SessionCallbackFacade callbackFacade,
            SessionHistoryAccess historyAccess
    ) {
        this(
                state,
                messageParser,
                callbackFacade,
                historyAccess,
                (usedTokens, maxTokens) -> {
                    if (project != null) {
                        ClaudeNotifier.setTokenUsage(project, usedTokens, maxTokens);
                    }
                    callbackFacade.notifyUsageUpdate(usedTokens, maxTokens);
                },
                100,
                50
        );
    }

    SessionMessageOrchestrator(
            SessionState state,
            MessageParser messageParser,
            SessionCallbackFacade callbackFacade,
            SessionHistoryAccess historyAccess,
            UsageDisplay usageDisplay,
            long initialUuidSyncDelayMs,
            long uuidRetryDelayMs
    ) {
        this.state = state;
        this.messageParser = messageParser;
        this.callbackFacade = callbackFacade;
        this.historyAccess = historyAccess;
        this.usageDisplay = usageDisplay;
        this.initialUuidSyncDelayMs = initialUuidSyncDelayMs;
        this.uuidRetryDelayMs = uuidRetryDelayMs;
    }

    public CompletableFuture<Void> syncUserMessageUuidsAfterSend() {
        String provider = state.getProvider();
        if ("codex".equals(provider)
                || SessionProviderRouter.isCliProvider(provider)
                || findLatestUnresolvedUserMessage() == null) {
            return CompletableFuture.completedFuture(null);
        }

        return CompletableFuture.runAsync(() -> {
            sleep(initialUuidSyncDelayMs);
            updateUserMessageUuids();
        });
    }

    void updateUserMessageUuids() {
        String sessionId = state.getSessionId();
        String cwd = state.getCwd();

        if (sessionId == null || sessionId.isEmpty()) {
            return;
        }

        if (findLatestUnresolvedUserMessage() == null) {
            return;
        }

        for (int attempt = 1; attempt <= MAX_UUID_SYNC_RETRIES; attempt++) {
            try {
                JsonObject latestClaudeUserMessage = historyAccess.getLatestClaudeUserMessage(sessionId, cwd);
                if (latestClaudeUserMessage == null) {
                    if (attempt < MAX_UUID_SYNC_RETRIES) {
                        sleep(uuidRetryDelayMs);
                        continue;
                    }
                    return;
                }

                ClaudeSession.Message matchedMessage = patchMatchingUserMessage(latestClaudeUserMessage);
                if (matchedMessage != null && matchedMessage.raw != null && matchedMessage.raw.has("uuid")) {
                    callbackFacade.notifyUserMessageUuidPatched(
                            matchedMessage.content != null ? matchedMessage.content : "",
                            matchedMessage.raw.get("uuid").getAsString()
                    );
                    return;
                }

                if (attempt < MAX_UUID_SYNC_RETRIES) {
                    sleep(uuidRetryDelayMs);
                }
            } catch (Exception e) {
                LOG.warn("[Rewind] Failed to update user message UUIDs (attempt " + attempt + "): " + e.getMessage());
                if (attempt < MAX_UUID_SYNC_RETRIES) {
                    sleep(uuidRetryDelayMs);
                }
            }
        }
    }

    public CompletableFuture<Void> loadFromServer() {
        if (state.getSessionId() == null) {
            return CompletableFuture.completedFuture(null);
        }

        state.setLoading(true);
        callbackFacade.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());

        return CompletableFuture.runAsync(() -> {
            try {
                String currentSessionId = state.getSessionId();
                String currentCwd = state.getCwd();
                String currentProvider = state.getProvider();

                LOG.info("Loading session from server: sessionId=" + currentSessionId + ", cwd=" + currentCwd);

                List<JsonObject> serverMessages;
                if ("claude".equals(currentProvider)) {
                    serverMessages = loadClaudeSessionWithPagination(currentSessionId, currentCwd);
                } else {
                    serverMessages = historyAccess.getProviderSessionMessages(currentProvider, currentSessionId, currentCwd);
                }

                if (serverMessages == null) {
                    serverMessages = List.of();
                }

                LOG.debug("Received " + serverMessages.size() + " messages from server");

                state.clearMessages();
                for (JsonObject msg : serverMessages) {
                    ClaudeSession.Message message = messageParser.parseServerMessage(msg);
                    if (message != null) {
                        state.addMessage(message);
                    }
                }

                restoreTokenUsage(serverMessages);
                callbackFacade.notifyMessageUpdate(state.getMessages());
            } catch (Exception e) {
                state.setError(e.getMessage());
                LOG.error("Error loading session: " + e.getMessage(), e);
            } finally {
                state.setLoading(false);
                callbackFacade.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
            }
        });
    }

    /**
     * Load Claude session history with turn-based pagination.
     * Falls back to the legacy full-history load when the paginated query
     * fails or returns invalid data, so a broken cursor never leaves the
     * user with an empty chat.
     */
    private List<JsonObject> loadClaudeSessionWithPagination(String sessionId, String cwd) {
        // Try the paginated path first: latest page only, then prepend earlier
        // pages as the user scrolls up.
        try {
            JsonObject page = historyAccess.getProviderSessionMessagesPage(sessionId, cwd, null, 30);
            if (page != null && page.has("success") && page.get("success").getAsBoolean()) {
                List<JsonObject> messages = new ArrayList<>();
                if (page.has("messages")) {
                    JsonArray messagesArray = page.getAsJsonArray("messages");
                    for (JsonElement msg : messagesArray) {
                        messages.add(msg.getAsJsonObject());
                    }
                }
                // Save pagination metadata for scroll-based loading
                claudeHistoryFromTurn = page.get("fromTurn").getAsInt();
                claudeHistoryTotalTurns = page.get("totalTurns").getAsInt();
                claudeHistoryHasMore = page.get("hasMore").getAsBoolean();
                LOG.info("Loaded Claude session page: " + messages.size() + " messages"
                        + ", fromTurn=" + claudeHistoryFromTurn
                        + ", toTurn=" + page.get("toTurn").getAsInt()
                        + ", totalTurns=" + claudeHistoryTotalTurns
                        + ", hasMore=" + claudeHistoryHasMore);
                // Notify frontend of pagination metadata
                callbackFacade.notifyClaudeHistoryPageInfo(sessionId, claudeHistoryFromTurn, claudeHistoryTotalTurns, claudeHistoryHasMore);
                return messages;
            }
        } catch (Exception e) {
            LOG.warn("Paginated session load failed, falling back to full history: " + e.getMessage());
        }

        // Fallback: full history load (legacy behavior)
        LOG.info("Using full-history fallback for Claude session: " + sessionId);
        claudeHistoryFromTurn = 0;
        claudeHistoryTotalTurns = 0;
        claudeHistoryHasMore = false;
        return historyAccess.getProviderSessionMessages("claude", sessionId, cwd);
    }

    /**
     * Load an earlier page of Claude history and prepend to the current session.
     * Called when the user scrolls to the top of the message list.
     */
    public CompletableFuture<Void> loadEarlierClaudeHistoryPage(String sessionId, String cwd, int beforeTurn) {
        return CompletableFuture.runAsync(() -> {
            try {
                JsonObject page = historyAccess.getProviderSessionMessagesPage(sessionId, cwd, beforeTurn, 30);
                if (page != null && page.has("success") && page.get("success").getAsBoolean()) {
                    List<JsonObject> messages = new ArrayList<>();
                    if (page.has("messages")) {
                        JsonArray messagesArray = page.getAsJsonArray("messages");
                        for (JsonElement msg : messagesArray) {
                            messages.add(msg.getAsJsonObject());
                        }
                    }
                    claudeHistoryFromTurn = page.get("fromTurn").getAsInt();
                    claudeHistoryHasMore = page.get("hasMore").getAsBoolean();

                    // Prepend older messages to the beginning
                    List<ClaudeSession.Message> newMessages = new ArrayList<>();
                    for (JsonObject msg : messages) {
                        ClaudeSession.Message message = messageParser.parseServerMessage(msg);
                        if (message != null) {
                            newMessages.add(message);
                        }
                    }
                    // Insert at the beginning
                    List<ClaudeSession.Message> currentMessages = state.getMessagesReference();
                    currentMessages.addAll(0, newMessages);
                    callbackFacade.notifyMessageUpdate(state.getMessages());
                    callbackFacade.notifyClaudeHistoryPageInfo(sessionId, claudeHistoryFromTurn, claudeHistoryTotalTurns, claudeHistoryHasMore);
                    LOG.info("Prepended Claude history page: " + newMessages.size() + " messages"
                            + ", fromTurn=" + claudeHistoryFromTurn
                            + ", hasMore=" + claudeHistoryHasMore);
                }
            } catch (Exception e) {
                LOG.error("Failed to load earlier Claude history page: " + e.getMessage(), e);
            }
        });
    }

    private ClaudeSession.Message patchMatchingUserMessage(JsonObject historyMessage) {
        if (!historyMessage.has("type") || !"user".equals(historyMessage.get("type").getAsString())) {
            return null;
        }
        if (!historyMessage.has("uuid") || historyMessage.get("uuid").isJsonNull()) {
            return null;
        }

        String historyContent = extractMessageContentForMatching(historyMessage);
        if (historyContent == null || historyContent.isEmpty()) {
            return null;
        }

        String uuid = historyMessage.get("uuid").getAsString();
        List<ClaudeSession.Message> localMessages = state.getMessagesReference();
        for (int i = localMessages.size() - 1; i >= 0; i--) {
            ClaudeSession.Message localMsg = localMessages.get(i);
            if (localMsg.type != ClaudeSession.Message.Type.USER) {
                continue;
            }
            synchronized (localMsg) {
                if (localMsg.raw != null && localMsg.raw.has("uuid") && !localMsg.raw.get("uuid").isJsonNull()) {
                    continue;
                }
                if (!historyContent.equals(localMsg.content)) {
                    continue;
                }

                if (localMsg.raw == null) {
                    localMsg.raw = createDefaultUserRaw(localMsg.content);
                }
                localMsg.raw.addProperty("uuid", uuid);
            }
            return localMsg;
        }

        return null;
    }

    static JsonObject createDefaultUserRaw(String content) {
        JsonObject raw = new JsonObject();
        JsonObject message = new JsonObject();
        JsonArray contentArray = new JsonArray();
        JsonObject textBlock = new JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", content != null ? content : "");
        contentArray.add(textBlock);
        message.add("content", contentArray);
        raw.add("message", message);
        return raw;
    }

    private ClaudeSession.Message findLatestUnresolvedUserMessage() {
        List<ClaudeSession.Message> messages = state.getMessagesReference();
        for (int i = messages.size() - 1; i >= 0; i--) {
            ClaudeSession.Message message = messages.get(i);
            if (message.type != ClaudeSession.Message.Type.USER) {
                continue;
            }
            if (message.content == null || message.content.isEmpty() || "[tool_result]".equals(message.content)) {
                continue;
            }
            if (message.raw == null) {
                return message;
            }
            if (!message.raw.has("uuid") || message.raw.get("uuid").isJsonNull()) {
                return message;
            }
        }
        return null;
    }

    String extractMessageContentForMatching(JsonObject msg) {
        if (!msg.has("message") || !msg.get("message").isJsonObject()) {
            return null;
        }
        JsonObject message = msg.getAsJsonObject("message");
        if (!message.has("content")) {
            return null;
        }

        JsonElement contentElement = message.get("content");
        if (contentElement.isJsonPrimitive()) {
            return contentElement.getAsString();
        }

        if (contentElement.isJsonArray()) {
            JsonArray contentArray = contentElement.getAsJsonArray();
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < contentArray.size(); i++) {
                JsonElement element = contentArray.get(i);
                if (!element.isJsonObject()) {
                    continue;
                }
                JsonObject block = element.getAsJsonObject();
                if (block.has("type") && "text".equals(block.get("type").getAsString()) && block.has("text")) {
                    if (sb.length() > 0) {
                        sb.append("\n");
                    }
                    sb.append(block.get("text").getAsString());
                }
            }
            return sb.toString();
        }

        return null;
    }

    private void restoreTokenUsage(List<JsonObject> serverMessages) {
        try {
            JsonObject lastUsage = TokenUsageUtils.findLastUsageFromRawMessages(serverMessages, state.getProvider());
            if (lastUsage == null) {
                return;
            }

            int usedTokens = TokenUsageUtils.extractContextTokens(lastUsage, state.getProvider());
            int fallbackMaxTokens = SettingsHandler.getModelContextLimit(
                    state.getProvider(), state.getModel());
            int maxTokens = TokenUsageUtils.extractMaxTokens(lastUsage, fallbackMaxTokens);
            usageDisplay.show(usedTokens, maxTokens);
            LOG.debug("Restored token usage from history: " + usedTokens + " / " + maxTokens);
        } catch (Exception e) {
            LOG.warn("Failed to extract token usage from history: " + e.getMessage());
        }
    }

    private void sleep(long delayMs) {
        if (delayMs <= 0) {
            return;
        }
        try {
            Thread.sleep(delayMs);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
