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
import java.nio.file.StandardCopyOption;
import java.util.List;
import java.util.concurrent.CompletableFuture;

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
 *
 * <p>Blocking operations ({@code session.interrupt()}, daemon reset,
 * JSONL I/O) run on a background thread via {@link CompletableFuture#runAsync}.
 * Only the final JCEF callbacks are dispatched to the UI thread via
 * {@link ApplicationManager#invokeLater}.
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

    /**
     * Parse the request on the calling thread (lightweight), then offload all
     * blocking work to a background thread. Results are pushed back to the
     * frontend on the UI thread via {@code invokeLater}.
     */
    private void handleRollbackToMessage(String content) {
        // ── Parse on the calling thread (pure memory, no I/O) ─────────
        JsonObject request;
        String messageUuid;
        ClaudeSession session;
        SessionState state;
        int keepCount;

        try {
            request = gson.fromJson(content, JsonObject.class);
            messageUuid = request.has("messageUuid")
                ? request.get("messageUuid").getAsString() : null;

            if (messageUuid == null || messageUuid.isEmpty()) {
                showError("Missing message UUID");
                return;
            }

            session = context.getSession();
            if (session == null) {
                showError("No active session");
                return;
            }

            state = session.getState();

            // Find the target user message by UUID
            List<ClaudeSession.Message> messages = state.getMessagesReference();
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

            keepCount = targetIndex;
            if (keepCount >= messages.size()) {
                sendResult(true, "No messages to discard");
                return;
            }
        } catch (Exception e) {
            LOG.error("[RollbackHandler] Parse failed: " + e.getMessage(), e);
            showError("Rollback failed: " + e.getMessage());
            return;
        }

        // Snapshot values for the async block (they must be final / effectively final).
        final int finalKeepCount = keepCount;
        final String finalUuid = messageUuid;
        final SessionState finalState = state;
        final ClaudeSession finalSession = session;

        // ── Blocking work on a background thread ─────────────────────
        CompletableFuture.runAsync(() -> {
            try {
                LOG.info("[RollbackHandler] Truncating at keepCount=" + finalKeepCount
                    + ", discarding " + (finalState.getMessagesReference().size() - finalKeepCount));

                // 1. Interrupt if busy
                if (finalState.isBusy()) {
                    LOG.info("[RollbackHandler] Session is busy, interrupting");
                    finalSession.interrupt().join();
                }

                // 2. Truncate in-memory messages
                finalState.truncateMessages(finalKeepCount);
                LOG.info("[RollbackHandler] In-memory truncated to "
                    + finalState.getMessagesReference().size());

                // 3. Reset daemon runtime
                try {
                    context.getClaudeSDKBridge().resetPersistentRuntime(
                        finalState.getRuntimeSessionEpoch());
                    LOG.info("[RollbackHandler] Daemon runtime reset");
                } catch (Exception e) {
                    LOG.warn("[RollbackHandler] Daemon reset failed: " + e.getMessage());
                }

                // 4. JSONL on disk
                if (finalKeepCount == 0) {
                    deleteSessionJsonl(finalState);
                    finalState.setSessionId(null);
                    finalState.setChannelId(null);
                    finalState.rotateRuntimeSessionEpoch();
                    LOG.info("[RollbackHandler] Session reset — sessionId cleared");
                } else {
                    truncateSessionJsonl(finalState, finalUuid);
                }

                // 5. Push result to frontend (back on UI thread)
                List<ClaudeSession.Message> truncated = finalState.getMessagesReference();
                String truncatedJson = MessageJsonConverter.convertMessagesToJson(truncated);

                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("clearMessages", "");
                    callJavaScript("updateMessages", escapeJs(truncatedJson));
                    sendResult(true, null);
                });

            } catch (Exception e) {
                LOG.error("[RollbackHandler] Background work failed: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() ->
                    showError("Rollback failed: " + e.getMessage()));
            }
        });
    }

    // ── JSONL operations ────────────────────────────────────────────────

    /** Delete the session JSONL file when resetting to empty state. */
    private static void deleteSessionJsonl(SessionState state) {
        String sessionId = state.getSessionId();
        if (sessionId == null || sessionId.isEmpty()) {
            return;
        }
        try {
            Path jsonlPath = buildJsonlPath(state.getCwd(), sessionId);
            if (Files.exists(jsonlPath)) {
                Files.delete(jsonlPath);
                LOG.info("[RollbackHandler] Deleted JSONL: " + jsonlPath);
            }
        } catch (IOException | IllegalArgumentException e) {
            LOG.warn("[RollbackHandler] Failed to delete JSONL: " + e.getMessage());
        }
    }

    private static void truncateSessionJsonl(SessionState state, String messageUuid) {
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
                JsonObject obj = gson.fromJson(lines.get(i), JsonObject.class);
                String candidate = obj.has("uuid") ? obj.get("uuid").getAsString() : null;
                if (messageUuid.equals(candidate)) {
                    targetLine = i;
                    break;
                }
            }
            if (targetLine < 0 || targetLine >= lines.size()) {
                return;
            }
            // Exclude the target message itself (text is restored to input box)
            // Atomic write: write to a temp file first, then move to replace
            // the original. This prevents corruption if the process crashes or
            // loses power mid-write — only the temp file is lost, not the JSONL.
            List<String> truncated = lines.subList(0, targetLine);
            Path tmpPath = jsonlPath.resolveSibling(jsonlPath.getFileName() + ".tmp");
            Files.write(tmpPath, truncated, StandardCharsets.UTF_8);
            Files.move(tmpPath, jsonlPath, StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING);
            LOG.info("[RollbackHandler] JSONL truncated: "
                + lines.size() + " → " + targetLine + " lines");
        } catch (IOException | IllegalArgumentException e) {
            LOG.warn("[RollbackHandler] JSONL truncation failed: " + e.getMessage());
        }
    }

    /** Package-private for testability. */
    static Path buildJsonlPath(String cwd, String sessionId) {
        // Validate sessionId to prevent path traversal.
        // Session IDs are UUID-like: alphanumeric + hyphens only.
        if (sessionId == null || !sessionId.matches("[a-zA-Z0-9_-]+")) {
            throw new IllegalArgumentException("Invalid sessionId: " + sessionId);
        }
        String home = PlatformUtils.getHomeDirectory();
        String dir = sanitizeCwd(cwd);
        Path projectsDir = Paths.get(home, ".claude", "projects", dir).normalize();
        Path jsonlPath = projectsDir.resolve(sessionId + ".jsonl").normalize();
        // Defense in depth: ensure the resolved path stays within the projects directory.
        if (!jsonlPath.startsWith(projectsDir + java.io.File.separator)) {
            throw new IllegalArgumentException("Resolved path escapes projects directory");
        }
        return jsonlPath;
    }

    /** Match the SDK's CWD sanitisation. Package-private for testability. */
    static String sanitizeCwd(String cwd) {
        if (cwd == null || cwd.isEmpty()) {
            return "";
        }
        String s = cwd.replace('\\', '/').replaceAll("[^a-zA-Z0-9-]", "-");
        return s.length() > 64 ? s.substring(0, 64) : s;
    }

    // ── Frontend callbacks (always on UI thread via invokeLater) ─────

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
