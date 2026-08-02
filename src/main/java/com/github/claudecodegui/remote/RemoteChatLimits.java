package com.github.claudecodegui.remote;

/**
 * Centralized size limits for the Remote chat endpoint.
 *
 * <p>Both limits are enforced <em>before</em> the message is processed: the HTTP
 * body is read with a hard byte cap (see {@link BoundedBodyReader}), and the
 * parsed {@code message} string is length-checked (see {@link RemoteChatRequest}).
 * Defining them in one place keeps the bounds consistent and testable.
 */
public final class RemoteChatLimits {

    private RemoteChatLimits() {
    }

    /**
     * Maximum number of characters allowed in the {@code message} field. Generous
     * enough for a normal chat turn, small enough to reject accidental huge pastes
     * or a hostile local client trying to exhaust memory.
     */
    public static final int MAX_MESSAGE_LENGTH = 32_000;

    /**
     * Hard cap on the raw HTTP request body in bytes. The body reader aborts with
     * 413 as soon as this many bytes have been read, so an oversized body is never
     * fully buffered in memory. Deliberately larger than {@link #MAX_MESSAGE_LENGTH}
     * in UTF-8 bytes to leave room for JSON envelope overhead.
     */
    public static final int MAX_BODY_BYTES = 1_048_576; // 1 MiB

    /**
     * @return true if the message length is within the allowed bound
     */
    public static boolean isMessageLengthAllowed(int length) {
        return length >= 0 && length <= MAX_MESSAGE_LENGTH;
    }
}
