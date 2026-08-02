package com.github.claudecodegui.remote;

import com.google.gson.JsonObject;

/**
 * Canonical JSON error envelope used by every Remote Gateway endpoint.
 *
 * <pre>
 * { "error": { "code": "UNAUTHORIZED", "message": "Unauthorized" } }
 * </pre>
 *
 * <p>HTTP responses never carry Java stack traces or local secrets; the
 * {@link #message} is a short, stable human-readable string. Internal
 * diagnostics for 500s are logged server-side instead.
 */
public final class RemoteErrors {

    private RemoteErrors() {
    }

    /** Stable error codes mirrored in the HTTP status line. */
    public enum Code {
        BAD_REQUEST(400, "BAD_REQUEST", "Bad request"),
        UNAUTHORIZED(401, "UNAUTHORIZED", "Unauthorized"),
        FORBIDDEN(403, "FORBIDDEN", "Forbidden"),
        NOT_FOUND(404, "NOT_FOUND", "Not found"),
        METHOD_NOT_ALLOWED(405, "METHOD_NOT_ALLOWED", "Method not allowed"),
        TAB_BUSY(409, "TAB_BUSY", "Tab is busy"),
        PAYLOAD_TOO_LARGE(413, "PAYLOAD_TOO_LARGE", "Payload too large"),
        GATEWAY_UNAVAILABLE(503, "GATEWAY_UNAVAILABLE", "Gateway unavailable"),
        INTERACTION_NOT_FOUND(404, "INTERACTION_NOT_FOUND", "Interaction not found"),
        INTERACTION_ALREADY_RESOLVED(409, "INTERACTION_ALREADY_RESOLVED", "Interaction already resolved"),
        INTERACTION_TYPE_MISMATCH(409, "INTERACTION_TYPE_MISMATCH", "Interaction type mismatch"),
        INTERACTION_MISMATCH(409, "INTERACTION_MISMATCH", "Interaction does not match task"),
        TASK_NOT_FOUND(404, "TASK_NOT_FOUND", "Task not found"),
        TASK_NOT_ACTIVE(409, "TASK_NOT_ACTIVE", "Task is not active"),
        INVALID_MODE(400, "INVALID_MODE", "Invalid permission mode"),
        INTERNAL_ERROR(500, "INTERNAL_ERROR", "Internal error");

        private final int status;
        private final String code;
        private final String message;

        Code(int status, String code, String message) {
            this.status = status;
            this.code = code;
            this.message = message;
        }

        public int status() {
            return status;
        }

        public String code() {
            return code;
        }

        public String message() {
            return message;
        }
    }

    /**
     * Build the error JSON body for a code, overriding the default message.
     */
    public static String body(Code code, String message) {
        JsonObject error = new JsonObject();
        error.addProperty("code", code.code());
        error.addProperty("message", message == null ? code.message() : message);
        JsonObject envelope = new JsonObject();
        envelope.add("error", error);
        return envelope.toString();
    }

    /**
     * Build the error JSON body with the code's default message.
     */
    public static String body(Code code) {
        return body(code, code.message());
    }
}
