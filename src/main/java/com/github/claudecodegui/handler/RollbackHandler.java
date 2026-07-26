package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.session.ClaudeSession;
import com.github.claudecodegui.session.SessionState;
import com.github.claudecodegui.util.MessageJsonConverter;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;

/**
 * Rollback handler — truncates the conversation at a target user message.
 *
 * <p>On {@code rollback_to_message} from the frontend:
 * <ol>
 *   <li>Find the target user message by UUID in the in-memory list.
 *   <li>Truncate in-memory {@link SessionState} messages.
 *   <li>Truncate the SDK JSONL session file on disk (survives IDE restarts).
 *   <li>Reset the daemon runtime (SDK reloads context on next send).
 *   <li>Push the truncated list to the frontend via
 *       {@code clearMessages + updateMessages} so React sees
 *       {@code prev = []} and {@code preserveLatestMessagesOnShrink} does not
 *       restore the discarded tail.
 * </ol>
 */
public class RollbackHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(RollbackHandler.class);
    private static final Gson gson = new Gson();

    private static final String[] SUPPORTED_TYPES = {"rollback_to_message"};

    public RollbackHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if ("rollback_to_message".equals(type)) {
            handleRollbackToMessage(content);
            return true;
        }
        return false;
    }

    private void handleRollbackToMessage(String content) {
        try {
            JsonObject request = gson.fromJson(content, JsonObject.class);
            String messageUuid = request.has("messageUuid")
                ? request.get("messageUuid").getAsString() : null;

            if (messageUuid == null || messageUuid.isEmpty()) {
                showError("Missing message UUID");
                return;
            }

            ClaudeSession session = context.getSession();
            if (session == null) {
                showError("No active session");
                return;
            }

            SessionState state = session.getState();
            List<ClaudeSession.Message> messages = state.getMessagesReference();

            // Find the target user message by UUID
            int targetIndex = -1;
            for (int i = 0; i < messages.size(); i++) {
                ClaudeSession.Message msg = messages.get(i);
                if (msg.type != ClaudeSession.Message.Type.USER || msg.raw == null) {
                    continue;
                }
                String uuid = msg.raw.has("uuid")
                    ? msg.raw.get("uuid").getAsString() : null;
                if (messageUuid.equals(uuid)) {
                    targetIndex = i;
                    break;
                }
            }

            if (targetIndex < 0) {
                showError("Target message not found in session");
                return;
            }

            // Remove the target user message itself from the chat — the user's
            // text is restored to the input box so they can edit and re-send.
            int keepCount = targetIndex;
            if (keepCount >= messages.size()) {
                sendResult(true, "No messages to discard");
                return;
            }

            LOG.info("[RollbackHandler] Truncating at index " + targetIndex
                + ", discarding " + (messages.size() - keepCount) + " messages");

            // 1. Interrupt if busy
            if (state.isBusy()) {
                session.interrupt().join();
            }

            // 2. Truncate in-memory messages
            state.truncateMessages(keepCount);

            // 3. Truncate JSONL on disk (survives IDE restart)
            truncateSessionJsonl(state, messageUuid);

            // 4. Reset daemon runtime
            try {
                context.getClaudeSDKBridge().resetPersistentRuntime(
                    state.getRuntimeSessionEpoch());
            } catch (Exception e) {
                LOG.warn("[RollbackHandler] Daemon reset failed: " + e.getMessage());
            }

            // 5. Push truncated list to frontend
            List<ClaudeSession.Message> truncated = state.getMessagesReference();
            String truncatedJson = MessageJsonConverter.convertMessagesToJson(truncated);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("clearMessages", "");
                callJavaScript("updateMessages", escapeJs(truncatedJson));
                sendResult(true, null);
            });

        } catch (Exception e) {
            LOG.error("[RollbackHandler] Failed: " + e.getMessage(), e);
            showError("Rollback failed: " + e.getMessage());
        }
    }

    // ── JSONL truncation ────────────────────────────────────────────────

    private void truncateSessionJsonl(SessionState state, String messageUuid) {
        String sessionId = state.getSessionId();
        if (sessionId == null || sessionId.isEmpty()) {
            return;
        }
        try {
            Path jsonlPath = buildJsonlPath(state.getCwd(), sessionId);
            if (!Files.exists(jsonlPath)) {
                LOG.warn("[RollbackHandler] JSONL not found: " + jsonlPath);
                return;
            }
            List<String> lines = Files.readAllLines(jsonlPath, StandardCharsets.UTF_8);
            int targetLine = -1;
            for (int i = 0; i < lines.size(); i++) {
                if (lines.get(i).contains(messageUuid)) {
                    targetLine = i;
                    break;
                }
            }
            if (targetLine < 0 || targetLine >= lines.size()) {
                return;
            }
            // Exclude the target message itself (text is restored to input box)
            Files.write(jsonlPath, lines.subList(0, targetLine), StandardCharsets.UTF_8);
            LOG.info("[RollbackHandler] JSONL truncated: "
                + lines.size() + " → " + targetLine + " lines");
        } catch (IOException e) {
            LOG.warn("[RollbackHandler] JSONL truncation failed: " + e.getMessage());
        }
    }

    private static Path buildJsonlPath(String cwd, String sessionId) {
        String home = PlatformUtils.getHomeDirectory();
        String dir = sanitizeCwd(cwd);
        return Paths.get(home, ".claude", "projects", dir, sessionId + ".jsonl");
    }

    /** Match the SDK's CWD sanitisation. */
    private static String sanitizeCwd(String cwd) {
        if (cwd == null || cwd.isEmpty()) {
            return "";
        }
        String s = cwd.replace('\\', '/').replaceAll("[^a-zA-Z0-9-]", "-");
        return s.length() > 64 ? s.substring(0, 64) : s;
    }

    // ── Frontend callbacks ──────────────────────────────────────────────

    private void sendResult(boolean success, String message) {
        JsonObject r = new JsonObject();
        r.addProperty("success", success);
        if (message != null) {
            r.addProperty("message", message);
        }
        ApplicationManager.getApplication().invokeLater(() ->
            callJavaScript("onRollbackResult", escapeJs(gson.toJson(r))));
    }

    private void showError(String message) {
        sendResult(false, message);
    }
}
