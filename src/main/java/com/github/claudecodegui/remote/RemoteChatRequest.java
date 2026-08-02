package com.github.claudecodegui.remote;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonSyntaxException;

import java.nio.charset.StandardCharsets;

/**
 * Parses and validates the body of {@code POST .../tabs/{tabId}/chat}.
 *
 * <p>The only accepted shape is a JSON object with a single usable field:
 * <pre>
 * { "message": "..." }
 * </pre>
 * The {@code message} must be present, must be a JSON string, must be non-empty
 * after trimming, and must not exceed {@link RemoteChatLimits#MAX_MESSAGE_LENGTH}.
 * Any other field is ignored this phase (sessionId/provider/model/... are never
 * accepted from the client — the tab's current state is always used).
 *
 * <p>Pure logic (no IntelliJ, no HTTP). Parse failures never expose the body
 * text in the returned error message.
 */
public final class RemoteChatRequest {

    private RemoteChatRequest() {
    }

    /**
     * Parse a raw body. Returns a {@link Result} that is either valid (carrying
     * the trimmed message) or invalid (carrying a stable error code+message).
     *
     * @param body the raw request body bytes, possibly null/empty
     */
    public static Result parse(byte[] body) {
        if (body == null || body.length == 0) {
            return Result.invalid(RemoteErrors.Code.BAD_REQUEST, "Missing message");
        }
        String text;
        try {
            text = new String(body, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return Result.invalid(RemoteErrors.Code.BAD_REQUEST, "Invalid UTF-8 body");
        }
        return parseText(text);
    }

    /**
     * Package-private text entry point so tests do not need to encode bytes.
     */
    static Result parseText(String text) {
        if (text == null || text.trim().isEmpty()) {
            return Result.invalid(RemoteErrors.Code.BAD_REQUEST, "Missing message");
        }

        JsonObject payload;
        try {
            Gson gson = new Gson();
            JsonElement element = gson.fromJson(text, JsonElement.class);
            if (element == null || !element.isJsonObject()) {
                return Result.invalid(RemoteErrors.Code.BAD_REQUEST, "Request body must be a JSON object");
            }
            payload = element.getAsJsonObject();
        } catch (JsonSyntaxException e) {
            return Result.invalid(RemoteErrors.Code.BAD_REQUEST, "Invalid JSON");
        }

        if (!payload.has("message") || payload.get("message").isJsonNull()) {
            return Result.invalid(RemoteErrors.Code.BAD_REQUEST, "Missing message");
        }
        JsonElement messageEl = payload.get("message");
        if (!messageEl.isJsonPrimitive() || !messageEl.getAsJsonPrimitive().isString()) {
            // Reject null/array/number/object explicitly.
            return Result.invalid(RemoteErrors.Code.BAD_REQUEST, "message must be a string");
        }

        String message = messageEl.getAsString();
        if (message.length() > RemoteChatLimits.MAX_MESSAGE_LENGTH) {
            return Result.invalid(RemoteErrors.Code.BAD_REQUEST, "message too large");
        }
        String trimmed = message.trim();
        if (trimmed.isEmpty()) {
            return Result.invalid(RemoteErrors.Code.BAD_REQUEST, "message must not be empty");
        }
        return Result.valid(trimmed);
    }

    /** Outcome of parsing: either a valid trimmed message or an error. */
    public static final class Result {
        private final boolean valid;
        private final String message;
        private final RemoteErrors.Code errorCode;
        private final String errorMessage;

        private Result(boolean valid, String message, RemoteErrors.Code errorCode, String errorMessage) {
            this.valid = valid;
            this.message = message;
            this.errorCode = errorCode;
            this.errorMessage = errorMessage;
        }

        static Result valid(String message) {
            return new Result(true, message, null, null);
        }

        static Result invalid(RemoteErrors.Code code, String message) {
            return new Result(false, null, code, message);
        }

        public boolean isValid() {
            return valid;
        }

        /** The trimmed message; only valid when {@link #isValid()}. */
        public String getMessage() {
            return message;
        }

        public RemoteErrors.Code getErrorCode() {
            return errorCode;
        }

        public String getErrorMessage() {
            return errorMessage;
        }
    }
}
