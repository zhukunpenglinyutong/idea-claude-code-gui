package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.Gson;
import com.google.gson.JsonObject;

import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Adapts tagged Node.js output lines into bridge callbacks and SDKResult updates.
 */
class ClaudeStreamAdapter {

    private final Gson gson;

    ClaudeStreamAdapter(Gson gson) {
        this.gson = gson;
    }

    void processOutputLine(
            String line,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent,
            AtomicBoolean hadSendError,
            AtomicReference<String> lastNodeError
    ) {
        processOutputLine(line, callback, result, assistantContent, hadSendError, lastNodeError, new AtomicBoolean(false));
    }

    void processOutputLine(
            String line,
            MessageCallback callback,
            SDKResult result,
            StringBuilder assistantContent,
            AtomicBoolean hadSendError,
            AtomicReference<String> lastNodeError,
            AtomicBoolean wasAborted
    ) {
        if (line.startsWith("[STDIN_ERROR]")
                || line.startsWith("[STDIN_PARSE_ERROR]")
                || line.startsWith("[GET_SESSION_ERROR]")
                || line.startsWith("[PERSIST_ERROR]")) {
            lastNodeError.set(line);
        }

        if (line.startsWith("[MESSAGE]")) {
            String jsonStr = line.substring("[MESSAGE]".length()).trim();
            try {
                JsonObject msg = gson.fromJson(jsonStr, JsonObject.class);
                result.messages.add(msg);
                String type = msg.has("type") ? msg.get("type").getAsString() : "unknown";
                callback.onMessage(type, jsonStr);
            } catch (Exception ignored) {
            }
            return;
        }

        if (line.startsWith("[SEND_ERROR]")) {
            // If the request was aborted by the user, suppress the SEND_ERROR
            // so the UI does not show an error toast. The abort path in
            // ClaudeDaemonRequestExecutor handles completion gracefully.
            if (wasAborted.get()) {
                return;
            }
            String jsonStr = line.substring("[SEND_ERROR]".length()).trim();
            String errorMessage = jsonStr;
            try {
                JsonObject obj = gson.fromJson(jsonStr, JsonObject.class);
                if (obj.has("error")) {
                    errorMessage = obj.get("error").getAsString();
                }
            } catch (Exception ignored) {
            }
            hadSendError.set(true);
            result.success = false;
            result.error = errorMessage;
            callback.onError(errorMessage);
            return;
        }

        if (line.startsWith("[CONTENT]")) {
            String content = line.substring("[CONTENT]".length()).trim();
            assistantContent.append(content);
            callback.onMessage("content", content);
            return;
        }

        if (line.startsWith("[CONTENT_DELTA]")) {
            String delta = decodeJsonStringPayload(line.substring("[CONTENT_DELTA]".length()));
            assistantContent.append(delta);
            callback.onMessage("content_delta", delta);
            return;
        }

        if (line.startsWith("[THINKING]")) {
            String thinkingContent = line.substring("[THINKING]".length()).trim();
            callback.onMessage("thinking", thinkingContent);
            return;
        }

        if (line.startsWith("[THINKING_DELTA]")) {
            String thinkingDelta = decodeJsonStringPayload(line.substring("[THINKING_DELTA]".length()));
            callback.onMessage("thinking_delta", thinkingDelta);
            return;
        }

        if (line.startsWith("[STREAM_START]")) {
            callback.onMessage("stream_start", "");
            return;
        }

        if (line.startsWith("[STREAM_END]")) {
            callback.onMessage("stream_end", "");
            return;
        }

        if (line.startsWith("[SESSION_ID]")) {
            callback.onMessage("session_id", line.substring("[SESSION_ID]".length()).trim());
            return;
        }

        if (line.startsWith("[TOOL_RESULT]")) {
            callback.onMessage("tool_result", line.substring("[TOOL_RESULT]".length()).trim());
            return;
        }

        if (line.startsWith("[USAGE]")) {
            callback.onMessage("usage", line.substring("[USAGE]".length()).trim());
            return;
        }

        if (line.startsWith("[LIMITS]")) {
            callback.onMessage("limits", line.substring("[LIMITS]".length()).trim());
            return;
        }

        if (line.startsWith("[MESSAGE_START]")) {
            callback.onMessage("message_start", "");
            return;
        }

        if (line.startsWith("[BLOCK_RESET]")) {
            callback.onMessage("block_reset", "");
            return;
        }

        if (line.startsWith("[MESSAGE_END]")) {
            callback.onMessage("message_end", "");
        }
    }

    private String decodeJsonStringPayload(String rawPayload) {
        String jsonStr = rawPayload.startsWith(" ") ? rawPayload.substring(1) : rawPayload;
        try {
            return gson.fromJson(jsonStr, String.class);
        } catch (Exception ignored) {
            return jsonStr;
        }
    }
}
