package com.github.claudecodegui.remote;

/**
 * Thrown by {@link BoundedBodyReader} when the incoming HTTP body exceeds
 * {@link RemoteChatLimits#MAX_BODY_BYTES}. The caller maps this to HTTP 413.
 *
 * <p>Carries no body content, so it is safe to log.
 */
public final class PayloadTooLargeException extends Exception {

    private static final long serialVersionUID = 1L;

    public PayloadTooLargeException(String message) {
        super(message);
    }
}
