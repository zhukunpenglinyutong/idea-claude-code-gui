package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.CodexMessageConverter;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.codex.CodexHistoryReader;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.SessionState;
import com.github.claudecodegui.util.JsUtils;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.Base64;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Consumer;

/**
 * Service for loading session messages and injecting them into the frontend.
 * Handles both Claude and Codex session loading.
 */
public class HistoryMessageInjector {

    private static final Logger LOG = Logger.getInstance(HistoryMessageInjector.class);
    static final int HISTORY_USER_TURN_LIMIT = 30;
    static final int HISTORY_BATCH_MESSAGE_LIMIT = 50;
    static final int HISTORY_BATCH_TARGET_CHAR_LIMIT = 180_000;
    private static final String CODEX_RECORD_KIND = "_codexRecordKind";
    private static final String EVENT_USER_RECORD = "event_user";
    private static final String RESPONSE_USER_RECORD = "response_user";
    private static final String DUAL_USER_RECORD = "dual_user";

    private final HandlerContext context;
    private final AtomicLong sessionLoadGeneration = new AtomicLong();

    HistoryMessageInjector(HandlerContext context) {
        this.context = context;
    }

    /**
     * Load a history session.
     */
    void handleLoadSession(String sessionId, String currentProvider, HistoryHandler.SessionLoadCallback sessionLoadCallback) {
        // Every session selection invalidates asynchronous Codex loads from the previous selection.
        sessionLoadGeneration.incrementAndGet();
        String provider = currentProvider;
        String resolvedSessionId = sessionId;

        try {
            JsonObject payload = new Gson().fromJson(sessionId, JsonObject.class);
            if (payload != null) {
                if (payload.has("sessionId") && !payload.get("sessionId").isJsonNull()) {
                    resolvedSessionId = payload.get("sessionId").getAsString();
                }
                if (payload.has("provider") && !payload.get("provider").isJsonNull()) {
                    provider = payload.get("provider").getAsString();
                }
            }
        } catch (Exception ignored) {
            // Backward compatible: legacy payload is the raw sessionId string.
        }

        String rawPath = context.resolveEffectiveWorkingDirectory();
        String nodePath = NodeDetector.getInstance().getCachedNodePath();
        String projectPath = NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(rawPath) : rawPath;
        if (projectPath == null) {
            LOG.warn("[HistoryHandler] Project base path is null");
            notifyHistoryLoadComplete();
            return;
        }
        LOG.info("[HistoryHandler] Loading history session: " + resolvedSessionId
                + " from project: " + projectPath + ", provider: " + provider);

        if ("codex".equals(provider)) {
            // Codex session: read session info and restore session state
            loadCodexSession(resolvedSessionId);
        } else {
            // Claude session: use existing callback mechanism
            if (sessionLoadCallback != null) {
                sessionLoadCallback.onLoadSession(resolvedSessionId, projectPath, provider);
            } else {
                LOG.warn("[HistoryHandler] WARNING: No session load callback set");
                notifyHistoryLoadComplete();
            }
        }
    }

    /**
     * Load a Codex session.
     * Reads session messages directly and injects them into the frontend, while restoring session state.
     */
    void loadCodexSession(String sessionId) {
        long generation = sessionLoadGeneration.incrementAndGet();
        CompletableFuture.runAsync(() -> {
            LOG.info("[HistoryHandler] ========== 开始加载 Codex 会话 ==========");
            LOG.info("[HistoryHandler] SessionId: " + sessionId);

            try {
                CodexHistoryReader codexReader = new CodexHistoryReader();
                CodexHistoryPage page = scanCodexHistoryPage(
                        codexReader, sessionId, null, HISTORY_USER_TURN_LIMIT);
                if (generation != sessionLoadGeneration.get()) {
                    LOG.info("[HistoryHandler] Discarding stale Codex session load: " + sessionId);
                    return;
                }
                String threadIdToUse = page.threadId != null ? page.threadId : sessionId;
                String cwd = page.cwd;

                context.getSession().setSessionInfo(threadIdToUse, cwd);
                restoreCodexFrontendMessagesToSessionState(context.getSession().getState(), page.messages);
                LOG.info("[HistoryHandler] 恢复 Codex 会话状态: threadId=" + threadIdToUse + " (from sessionId=" + sessionId + "), cwd=" + cwd);

                injectCodexHistoryPage(sessionId, page, true);

                notifyHistoryLoadComplete();

                LOG.info("[HistoryHandler] ========== Codex 会话加载完成 ==========");

            } catch (Exception e) {
                if (generation != sessionLoadGeneration.get()) {
                    LOG.info("[HistoryHandler] Ignoring stale Codex session load failure: " + sessionId);
                    return;
                }
                LOG.error("[HistoryHandler] 加载 Codex 会话失败: " + e.getMessage(), e);

                ApplicationManager.getApplication().invokeLater(() -> {
                    String errorMsg = context.escapeJs(e.getMessage() != null ? e.getMessage() : "未知错误");
                    String jsCode = "if (window.addErrorMessage) { " +
                                            "  window.addErrorMessage('加载 Codex 会话失败: " + errorMsg + "'); " +
                                            "}";
                    context.executeJavaScriptOnEDT(jsCode);
                });
                notifyHistoryLoadComplete();
            }
        });
    }

    void loadEarlierCodexHistoryPage(String content) {
        long generation = sessionLoadGeneration.get();
        CompletableFuture.runAsync(() -> {
            String sessionId = null;
            Integer beforeTurn = null;
            try {
                JsonObject request = new Gson().fromJson(content, JsonObject.class);
                if (request == null || !request.has("sessionId") || !request.has("beforeTurn")) {
                    throw new IllegalArgumentException("Invalid Codex history page request");
                }
                sessionId = request.get("sessionId").getAsString();
                beforeTurn = request.get("beforeTurn").getAsInt();
                if (sessionId.isBlank() || sessionId.length() > 200 || beforeTurn < 0) {
                    throw new IllegalArgumentException("Invalid Codex history page cursor");
                }

                CodexHistoryPage page = scanCodexHistoryPage(
                        new CodexHistoryReader(), sessionId, beforeTurn, HISTORY_USER_TURN_LIMIT);
                String activeSessionId = context.getSession() != null
                        ? context.getSession().getSessionId() : null;
                boolean activeSessionMatches = sessionId.equals(activeSessionId)
                        || (page.threadId != null && page.threadId.equals(activeSessionId));
                if (generation != sessionLoadGeneration.get() || !activeSessionMatches) {
                    LOG.info("[HistoryHandler] Discarding stale Codex history page: " + sessionId);
                    return;
                }
                boolean replace = page.cursorReset;
                if (replace) {
                    restoreCodexFrontendMessagesToSessionState(context.getSession().getState(), page.messages);
                }
                injectCodexHistoryPage(sessionId, page, replace);
                notifyCodexHistoryPageRenderComplete();
            } catch (Exception e) {
                LOG.error("[HistoryHandler] 加载更早 Codex 历史失败: " + e.getMessage(), e);
                notifyCodexHistoryPageError(sessionId, beforeTurn, e.getMessage());
            }
        });
    }

    private void notifyCodexHistoryPageRenderComplete() {
        context.callJavaScript("codexHistoryPageRenderComplete");
    }

    static CodexHistoryPage scanCodexHistoryPage(CodexHistoryReader reader,
                                                  String sessionId,
                                                  Integer beforeTurn,
                                                  int pageSize) throws IOException {
        if (pageSize <= 0) {
            throw new IllegalArgumentException("Codex history page size must be positive");
        }

        CodexTurnPageCollector turnCollector = new CodexTurnPageCollector(beforeTurn, pageSize);
        CodexFrontendMessageAccumulator accumulator = new CodexFrontendMessageAccumulator(turnCollector::accept);
        CodexHistoryPage page = new CodexHistoryPage();
        page.rawRecordCount = reader.forEachSessionMessage(sessionId, rawMessage -> {
            extractSessionMeta(rawMessage, page);
            accumulator.accept(rawMessage);
        });
        accumulator.finish();
        turnCollector.finish(page);

        LOG.info("[HistoryHandler] Scanned Codex history records=" + page.rawRecordCount
                + ", totalUserTurns=" + page.totalTurns
                + ", page=[" + page.fromTurn + ", " + page.toTurn + ")"
                + ", messages=" + page.messages.size()
                + ", cursorReset=" + page.cursorReset);
        return page;
    }

    static CodexHistoryPage paginateCodexMessages(JsonArray messages,
                                                   Integer beforeTurn,
                                                   int pageSize) {
        CodexTurnPageCollector turnCollector = new CodexTurnPageCollector(beforeTurn, pageSize);
        CodexFrontendMessageAccumulator accumulator = new CodexFrontendMessageAccumulator(turnCollector::accept);
        CodexHistoryPage page = new CodexHistoryPage();
        page.rawRecordCount = messages.size();
        for (JsonElement element : messages) {
            JsonObject rawMessage = element.getAsJsonObject();
            extractSessionMeta(rawMessage, page);
            accumulator.accept(rawMessage);
        }
        accumulator.finish();
        turnCollector.finish(page);
        return page;
    }

    private static void extractSessionMeta(JsonObject rawMessage, CodexHistoryPage page) {
        if (!"session_meta".equals(getStringProperty(rawMessage, "type"))
                || !rawMessage.has("payload") || !rawMessage.get("payload").isJsonObject()) {
            return;
        }
        JsonObject payload = rawMessage.getAsJsonObject("payload");
        if (page.cwd == null) {
            page.cwd = getStringProperty(payload, "cwd");
        }
        if (page.threadId == null) {
            page.threadId = getStringProperty(payload, "id");
        }
    }

    static final class CodexHistoryPage {
        List<JsonObject> messages = new ArrayList<>();
        int fromTurn;
        int toTurn;
        int totalTurns;
        int rawRecordCount;
        boolean cursorReset;
        String threadId;
        String cwd;
    }

    private static final class IndexedTurn {
        private final int index;
        private final List<JsonObject> messages;

        private IndexedTurn(int index, List<JsonObject> messages) {
            this.index = index;
            this.messages = messages;
        }
    }

    private static final class CodexTurnPageCollector {
        private final Integer requestedBeforeTurn;
        private final int pageSize;
        private final int requestedFromTurn;
        private final Deque<IndexedTurn> recentTurns;
        private final List<JsonObject> selectedMessages = new ArrayList<>();
        private List<JsonObject> currentTurn;
        private int currentTurnIndex = -1;
        private int totalTurns;

        private CodexTurnPageCollector(Integer requestedBeforeTurn, int pageSize) {
            this.requestedBeforeTurn = requestedBeforeTurn;
            this.pageSize = pageSize;
            this.requestedFromTurn = requestedBeforeTurn == null
                    ? -1 : Math.max(0, requestedBeforeTurn - pageSize);
            this.recentTurns = new ArrayDeque<>(pageSize);
        }

        private void accept(JsonObject message) {
            if (isHumanUserMessage(message)) {
                finishCurrentTurn();
                currentTurnIndex = totalTurns++;
                currentTurn = new ArrayList<>();
            }
            if (currentTurn != null) {
                currentTurn.add(message);
            }
        }

        private void finish(CodexHistoryPage page) {
            finishCurrentTurn();
            page.totalTurns = totalTurns;

            if (requestedBeforeTurn == null) {
                copyRecentTurns(page);
                return;
            }

            if (requestedBeforeTurn > totalTurns) {
                page.cursorReset = true;
                copyRecentTurns(page);
                return;
            }

            page.fromTurn = requestedFromTurn;
            page.toTurn = requestedBeforeTurn;
            page.messages = new ArrayList<>(selectedMessages);
        }

        private void finishCurrentTurn() {
            if (currentTurn == null) {
                return;
            }

            IndexedTurn completed = new IndexedTurn(currentTurnIndex, currentTurn);
            recentTurns.addLast(completed);
            if (recentTurns.size() > pageSize) {
                recentTurns.removeFirst();
            }
            if (requestedBeforeTurn != null
                    && currentTurnIndex >= requestedFromTurn
                    && currentTurnIndex < requestedBeforeTurn) {
                selectedMessages.addAll(currentTurn);
            }
            currentTurn = null;
        }

        private void copyRecentTurns(CodexHistoryPage page) {
            page.messages = new ArrayList<>();
            for (IndexedTurn turn : recentTurns) {
                page.messages.addAll(turn.messages);
            }
            page.fromTurn = recentTurns.isEmpty() ? 0 : recentTurns.getFirst().index;
            page.toTurn = totalTurns;
        }
    }

    void notifyHistoryLoadComplete() {
        ApplicationManager.getApplication().invokeLater(() -> {
            String jsCode = "if (window.historyLoadComplete) { " +
                                    "  try { " +
                                    "    window.historyLoadComplete(); " +
                                    "  } catch(e) { " +
                                    "    console.error('[HistoryHandler] historyLoadComplete callback failed:', e); " +
                                    "  } " +
                                    "}";
            context.executeJavaScriptOnEDT(jsCode);
        });
    }

    /**
     * 将 Codex 历史消息批量转换为前端消息列表。
     * 只统一前端注入协议，不改变 Codex 历史文件格式与标题数据来源。
     */
    public static List<JsonObject> convertCodexMessagesToFrontendBatch(JsonArray messages) {
        List<JsonObject> frontendMessages = new ArrayList<>();
        CodexFrontendMessageAccumulator accumulator = new CodexFrontendMessageAccumulator(frontendMessages::add);
        for (int i = 0; i < messages.size(); i++) {
            accumulator.accept(messages.get(i).getAsJsonObject());
        }
        accumulator.finish();
        return frontendMessages;
    }

    private static final class CodexFrontendMessageAccumulator {
        private final Consumer<JsonObject> consumer;
        private JsonObject pending;

        private CodexFrontendMessageAccumulator(Consumer<JsonObject> consumer) {
            this.consumer = consumer;
        }

        private void accept(JsonObject rawMessage) {
            JsonObject incoming = convertCodexMessageToFrontend(rawMessage);
            if (incoming == null) {
                return;
            }

            String recordKind = getCodexUserRecordKind(rawMessage);
            if (recordKind != null && isUserMessage(incoming)) {
                incoming.addProperty(CODEX_RECORD_KIND, recordKind);
            }
            if (pending != null && isDuplicateAdjacentCodexUserMessage(pending, incoming)) {
                pending = preferRicherUserMessage(pending, incoming);
                pending.addProperty(CODEX_RECORD_KIND, DUAL_USER_RECORD);
                return;
            }

            emitPending();
            pending = incoming;
        }

        private void finish() {
            emitPending();
        }

        private void emitPending() {
            if (pending == null) {
                return;
            }
            pending.remove(CODEX_RECORD_KIND);
            consumer.accept(pending);
            pending = null;
        }
    }

    private static String getCodexUserRecordKind(JsonObject message) {
        String recordType = getStringProperty(message, "type");
        if (!message.has("payload") || !message.get("payload").isJsonObject()) {
            return null;
        }
        JsonObject payload = message.getAsJsonObject("payload");
        String payloadType = getStringProperty(payload, "type");
        if ("event_msg".equals(recordType) && "user_message".equals(payloadType)) {
            return EVENT_USER_RECORD;
        }
        if ("response_item".equals(recordType)
                && "message".equals(payloadType)
                && "user".equals(getStringProperty(payload, "role"))) {
            return RESPONSE_USER_RECORD;
        }
        return null;
    }

    private static boolean isDuplicateAdjacentCodexUserMessage(JsonObject previous, JsonObject incoming) {
        if (!isUserMessage(previous) || !isUserMessage(incoming)) {
            return false;
        }

        String previousRecordKind = getStringProperty(previous, CODEX_RECORD_KIND);
        String incomingRecordKind = getStringProperty(incoming, CODEX_RECORD_KIND);
        boolean dualRecordedPair = (EVENT_USER_RECORD.equals(previousRecordKind)
                && RESPONSE_USER_RECORD.equals(incomingRecordKind))
                || (RESPONSE_USER_RECORD.equals(previousRecordKind)
                && EVENT_USER_RECORD.equals(incomingRecordKind));
        if (!dualRecordedPair) {
            return false;
        }

        String previousContent = getStringProperty(previous, "content");
        String incomingContent = getStringProperty(incoming, "content");
        return previousContent != null
            && normalizeDuplicateUserContent(previousContent).equals(normalizeDuplicateUserContent(incomingContent));
    }

    private static JsonObject preferRicherUserMessage(JsonObject previous, JsonObject incoming) {
        return getRawContentBlockCount(incoming) > getRawContentBlockCount(previous) ? incoming : previous;
    }

    private static String normalizeDuplicateUserContent(String content) {
        if (content == null) {
            return "";
        }
        return content
            .replaceAll("(?m)^<image[^\\r\\n]*>\\R?", "")
            .replaceAll("(?m)^</image>\\R?", "")
            .trim();
    }

    private static boolean isUserMessage(JsonObject message) {
        return "user".equals(getStringProperty(message, "type"));
    }

    private static String getStringProperty(JsonObject object, String propertyName) {
        if (object == null || !object.has(propertyName) || object.get(propertyName).isJsonNull()) {
            return null;
        }
        return object.get(propertyName).getAsString();
    }

    private static int getRawContentBlockCount(JsonObject message) {
        if (message == null || !message.has("raw") || !message.get("raw").isJsonObject()) {
            return 0;
        }

        JsonObject raw = message.getAsJsonObject("raw");
        if (raw.has("content") && raw.get("content").isJsonArray()) {
            return raw.getAsJsonArray("content").size();
        }
        if (raw.has("message") && raw.get("message").isJsonObject()) {
            JsonObject rawMessage = raw.getAsJsonObject("message");
            if (rawMessage.has("content") && rawMessage.get("content").isJsonArray()) {
                return rawMessage.getAsJsonArray("content").size();
            }
        }
        return 0;
    }

    /**
     * 将 Codex 历史消息恢复到后端 SessionState，保证历史加载后继续发送时，
     * 后端内存态与前端显示态使用同一份消息基线。
     */
    static void restoreCodexMessagesToSessionState(SessionState state, JsonArray messages) {
        restoreCodexFrontendMessagesToSessionState(
                state, convertCodexMessagesToFrontendBatch(messages));
    }

    private static void restoreCodexFrontendMessagesToSessionState(SessionState state,
                                                                    List<JsonObject> frontendMessages) {
        state.clearMessages();
        for (JsonObject frontendMsg : frontendMessages) {
            ClaudeSession.Message restoredMessage = toSessionMessage(frontendMsg);
            if (restoredMessage != null) {
                state.addMessage(restoredMessage);
            }
        }
    }

    private static boolean isHumanUserMessage(JsonObject message) {
        if (!isUserMessage(message)) {
            return false;
        }
        if (!message.has("raw") || !message.get("raw").isJsonObject()) {
            return !"[tool_result]".equals(getStringProperty(message, "content"));
        }

        JsonObject raw = message.getAsJsonObject("raw");
        if (!raw.has("content") || !raw.get("content").isJsonArray()) {
            return !"[tool_result]".equals(getStringProperty(message, "content"));
        }
        for (JsonElement blockElement : raw.getAsJsonArray("content")) {
            if (!blockElement.isJsonObject()) {
                continue;
            }
            String blockType = getStringProperty(blockElement.getAsJsonObject(), "type");
            if ("text".equals(blockType) || "image".equals(blockType)) {
                return true;
            }
        }
        return false;
    }

    /**
     * 将前端统一消息结构恢复为会话内存消息结构。
     */
    private static ClaudeSession.Message toSessionMessage(JsonObject frontendMsg) {
        if (frontendMsg == null || !frontendMsg.has("type")) {
            return null;
        }

        String type = frontendMsg.get("type").getAsString();
        ClaudeSession.Message.Type messageType;
        switch (type) {
            case "user":
                messageType = ClaudeSession.Message.Type.USER;
                break;
            case "assistant":
                messageType = ClaudeSession.Message.Type.ASSISTANT;
                break;
            case "system":
                messageType = ClaudeSession.Message.Type.SYSTEM;
                break;
            case "error":
                messageType = ClaudeSession.Message.Type.ERROR;
                break;
            default:
                return null;
        }

        String content = frontendMsg.has("content") ? frontendMsg.get("content").getAsString() : "";
        JsonObject raw = frontendMsg.has("raw") && frontendMsg.get("raw").isJsonObject()
            ? frontendMsg.getAsJsonObject("raw")
            : null;
        return raw != null
            ? new ClaudeSession.Message(messageType, content, raw.deepCopy())
            : new ClaudeSession.Message(messageType, content);
    }

    /**
     * 将单条 Codex 历史消息转换为前端消息。
     * Handles both event_msg (user messages) and response_item (assistant/tool messages).
     */
    public static JsonObject convertCodexMessageToFrontend(JsonObject msg) {
        if (!msg.has("type")) {
            return null;
        }

        String type = msg.get("type").getAsString();
        JsonObject payload = msg.has("payload") && msg.get("payload").isJsonObject()
                ? msg.getAsJsonObject("payload") : null;
        if (payload == null) {
            return null;
        }

        String timestamp = msg.has("timestamp") ? msg.get("timestamp").getAsString() : null;

        // Handle event_msg containing user_message
        if ("event_msg".equals(type)) {
            return convertEventMsgToFrontend(payload, timestamp);
        }

        // Handle response_item (assistant messages, function calls, etc.)
        if ("response_item".equals(type)) {
            if (!payload.has("type")) {
                return null;
            }
            String payloadType = payload.get("type").getAsString();

            if ("message".equals(payloadType)) {
                return CodexMessageConverter.convertCodexMessageToFrontend(payload, timestamp);
            }
            if ("function_call".equals(payloadType)) {
                return CodexMessageConverter.convertFunctionCallToToolUse(payload, timestamp);
            }
            if ("function_call_output".equals(payloadType)) {
                return CodexMessageConverter.convertFunctionCallOutputToToolResult(payload, timestamp);
            }
            if ("custom_tool_call".equals(payloadType)) {
                return CodexMessageConverter.convertCustomToolCallToToolUse(payload, timestamp);
            }
            if ("custom_tool_call_output".equals(payloadType)) {
                return CodexMessageConverter.convertCustomToolCallOutputToToolResult(payload, timestamp);
            }
        }

        return null;
    }

    /**
     * Convert event_msg with user_message payload to frontend format.
     */
    private static JsonObject convertEventMsgToFrontend(JsonObject payload, String timestamp) {
        if (!payload.has("type") || !"user_message".equals(payload.get("type").getAsString())) {
            return null;
        }
        boolean hasLocalImages = hasLocalImages(payload);
        if (!payload.has("message") || payload.get("message").isJsonNull()) {
            if (!hasLocalImages) {
                return null;
            }
        }

        String content = "";
        if (payload.has("message") && !payload.get("message").isJsonNull()) {
            content = CodexMessageConverter.stripSystemTags(payload.get("message").getAsString());
        }
        if ((content == null || content.isBlank()) && !hasLocalImages) {
            return null;
        }
        if (content == null) {
            content = "";
        }

        JsonObject frontendMsg = new JsonObject();
        frontendMsg.addProperty("type", "user");
        frontendMsg.addProperty("content", content);

        // Build raw structure compatible with MessageParser
        JsonObject rawObj = new JsonObject();
        JsonArray contentBlocks = buildUserMessageContentBlocks(payload, content);
        rawObj.add("content", contentBlocks);
        rawObj.addProperty("role", "user");
        frontendMsg.add("raw", rawObj);

        if (timestamp != null) {
            frontendMsg.addProperty("timestamp", timestamp);
        }

        return frontendMsg;
    }

    private static JsonArray buildUserMessageContentBlocks(JsonObject payload, String content) {
        JsonArray contentBlocks = new JsonArray();
        appendLocalImageBlocks(payload, contentBlocks);

        if (content != null && !content.isBlank()) {
            JsonObject textBlock = new JsonObject();
            textBlock.addProperty("type", "text");
            textBlock.addProperty("text", content);
            contentBlocks.add(textBlock);
        }
        return contentBlocks;
    }

    private static boolean hasLocalImages(JsonObject payload) {
        return payload.has("local_images")
            && payload.get("local_images").isJsonArray()
            && payload.getAsJsonArray("local_images").size() > 0;
    }

    private static void appendLocalImageBlocks(JsonObject payload, JsonArray contentBlocks) {
        if (!payload.has("local_images") || !payload.get("local_images").isJsonArray()) {
            return;
        }

        JsonArray localImages = payload.getAsJsonArray("local_images");
        for (JsonElement imageElement : localImages) {
            if (!imageElement.isJsonPrimitive()) {
                continue;
            }
            String imagePath = imageElement.getAsString();
            JsonObject imageBlock = createLocalImageBlock(imagePath);
            if (imageBlock != null) {
                contentBlocks.add(imageBlock);
            }
        }
    }

    private static JsonObject createLocalImageBlock(String imagePath) {
        if (imagePath == null || imagePath.trim().isEmpty()) {
            return null;
        }

        try {
            Path path = Path.of(imagePath);
            if (!Files.isRegularFile(path)) {
                LOG.debug("[HistoryMessageInjector] Skip missing local image: " + imagePath);
                return null;
            }

            String mediaType = Files.probeContentType(path);
            if (mediaType == null || mediaType.isBlank()) {
                mediaType = guessImageMediaType(path);
            }
            if (mediaType == null || mediaType.isBlank()) {
                mediaType = "image/png";
            }

            String base64Data = Base64.getEncoder().encodeToString(Files.readAllBytes(path));
            JsonObject imageBlock = new JsonObject();
            imageBlock.addProperty("type", "image");
            imageBlock.addProperty("src", "data:" + mediaType + ";base64," + base64Data);
            imageBlock.addProperty("mediaType", mediaType);
            imageBlock.addProperty("alt", path.getFileName() != null ? path.getFileName().toString() : "image");
            return imageBlock;
        } catch (Exception e) {
            LOG.warn("[HistoryMessageInjector] Failed to restore local image from Codex history: " + imagePath, e);
            return null;
        }
    }

    private static String guessImageMediaType(Path path) {
        String fileName = path.getFileName() != null ? path.getFileName().toString().toLowerCase() : "";
        if (fileName.endsWith(".png")) {
            return "image/png";
        }
        if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) {
            return "image/jpeg";
        }
        if (fileName.endsWith(".gif")) {
            return "image/gif";
        }
        if (fileName.endsWith(".webp")) {
            return "image/webp";
        }
        if (fileName.endsWith(".bmp")) {
            return "image/bmp";
        }
        if (fileName.endsWith(".svg")) {
            return "image/svg+xml";
        }
        return null;
    }

    /**
     * 分批注入前端消息，避免长历史单次传输阻塞 WebView。
     */
    private void injectCodexHistoryPage(String sessionId, CodexHistoryPage page, boolean replace) {
        String pageId = UUID.randomUUID().toString();
        Gson gson = new Gson();
        JsonObject startInfo = new JsonObject();
        startInfo.addProperty("pageId", pageId);
        startInfo.addProperty("sessionId", sessionId);
        startInfo.addProperty("mode", replace ? "replace" : "prepend");

        if (replace) {
            // Keep the session-transition barrier active until historyLoadComplete.
            context.executeJavaScriptOnEDT("if (window.clearMessages) { window.clearMessages(); }");
        }
        context.callJavaScript("beginCodexHistoryPage", context.escapeJs(gson.toJson(startInfo)));

        int batchCount = 0;
        int largestBatchChars = 0;
        for (List<JsonObject> batch : partitionHistoryMessages(page.messages)) {
            largestBatchChars = Math.max(largestBatchChars, sendCodexHistoryPageBatch(gson, pageId, batch));
            batchCount++;
        }

        JsonObject pageInfo = new JsonObject();
        pageInfo.addProperty("pageId", pageId);
        pageInfo.addProperty("sessionId", sessionId);
        pageInfo.addProperty("mode", replace ? "replace" : "prepend");
        pageInfo.addProperty("fromTurn", page.fromTurn);
        pageInfo.addProperty("toTurn", page.toTurn);
        pageInfo.addProperty("totalTurns", page.totalTurns);
        pageInfo.addProperty("hasMore", page.fromTurn > 0);
        pageInfo.addProperty("loadedMessageCount", page.messages.size());
        pageInfo.addProperty("cursorReset", page.cursorReset);
        context.callJavaScript("completeCodexHistoryPage", context.escapeJs(gson.toJson(pageInfo)));

        LOG.info("[HistoryHandler] Injected Codex history page in " + batchCount
                + " batches, mode=" + (replace ? "replace" : "prepend")
                + ", messages=" + page.messages.size()
                + ", largestBatchChars=" + largestBatchChars);
    }

    private void notifyCodexHistoryPageError(String sessionId, Integer beforeTurn, String errorMessage) {
        JsonObject error = new JsonObject();
        if (sessionId != null) {
            error.addProperty("sessionId", sessionId);
        }
        if (beforeTurn != null) {
            error.addProperty("beforeTurn", beforeTurn);
        }
        error.addProperty("message", errorMessage != null ? errorMessage : "Unknown error");
        context.callJavaScript("codexHistoryPageError", context.escapeJs(new Gson().toJson(error)));
    }

    static List<List<JsonObject>> partitionHistoryMessages(List<JsonObject> frontendMessages) {
        List<List<JsonObject>> batches = new ArrayList<>();
        if (frontendMessages == null || frontendMessages.isEmpty()) {
            return batches;
        }
        Gson gson = new Gson();
        List<JsonObject> batch = new ArrayList<>(HISTORY_BATCH_MESSAGE_LIMIT);
        int estimatedChars = 2;
        for (JsonObject message : frontendMessages) {
            int messageChars = JsUtils.escapeJs(gson.toJson(message)).length() + 1;
            if (!batch.isEmpty() && (batch.size() >= HISTORY_BATCH_MESSAGE_LIMIT
                    || estimatedChars + messageChars > HISTORY_BATCH_TARGET_CHAR_LIMIT)) {
                batches.add(List.copyOf(batch));
                batch = new ArrayList<>(HISTORY_BATCH_MESSAGE_LIMIT);
                estimatedChars = 2;
            }
            batch.add(message);
            estimatedChars += messageChars;
        }
        if (!batch.isEmpty()) {
            batches.add(List.copyOf(batch));
        }
        return batches;
    }

    private int sendCodexHistoryPageBatch(Gson gson, String pageId, List<JsonObject> batch) {
        String batchJson = gson.toJson(batch);
        String escapedBatch = JsUtils.escapeJs(batchJson);
        if (escapedBatch.length() <= HISTORY_BATCH_TARGET_CHAR_LIMIT) {
            context.callJavaScript("appendCodexHistoryPageBatch", pageId, escapedBatch);
            return escapedBatch.length();
        }

        String transferId = UUID.randomUUID().toString();
        int largestChunkChars = 0;
        List<String> chunks = splitHistoryPayload(batchJson);
        for (int i = 0; i < chunks.size(); i++) {
            String escapedChunk = JsUtils.escapeJs(chunks.get(i));
            context.callJavaScript(
                    "appendCodexHistoryPageChunk",
                    pageId,
                    escapedChunk,
                    transferId,
                    String.valueOf(i == chunks.size() - 1));
            largestChunkChars = Math.max(largestChunkChars, escapedChunk.length());
        }
        return largestChunkChars;
    }

    static List<String> splitHistoryPayload(String payload) {
        List<String> chunks = new ArrayList<>();
        if (payload == null || payload.isEmpty()) {
            return chunks;
        }

        StringBuilder current = new StringBuilder(HISTORY_BATCH_TARGET_CHAR_LIMIT);
        int escapedChars = 0;
        for (int i = 0; i < payload.length(); i++) {
            char value = payload.charAt(i);
            int charCount = escapedCharCount(current, value);
            boolean surrogatePair = Character.isHighSurrogate(value)
                    && i + 1 < payload.length()
                    && Character.isLowSurrogate(payload.charAt(i + 1));
            if (surrogatePair) {
                charCount += 1;
            }

            if (escapedChars + charCount > HISTORY_BATCH_TARGET_CHAR_LIMIT && current.length() > 0) {
                chunks.add(current.toString());
                current.setLength(0);
                escapedChars = 0;
                charCount = escapedCharCount(current, value) + (surrogatePair ? 1 : 0);
            }

            current.append(value);
            if (surrogatePair) {
                current.append(payload.charAt(++i));
            }
            escapedChars += charCount;
        }
        if (current.length() > 0) {
            chunks.add(current.toString());
        }
        return chunks;
    }

    private static int escapedCharCount(StringBuilder current, char value) {
        if (value == '\u0085' || value == '\u2028' || value == '\u2029') {
            return 6;
        }
        if (value == '\\' || value == '\'' || value == '"' || value == '`'
                || value == '\n' || value == '\r' || value == '\t'
                || value == '\b' || value == '\f' || value == '\0') {
            return 2;
        }
        if (value == '/' && current.length() > 0 && current.charAt(current.length() - 1) == '<') {
            return 2;
        }
        return 1;
    }
}
