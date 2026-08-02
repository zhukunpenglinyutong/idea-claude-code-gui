package com.github.claudecodegui.remote;

/**
 * Centralized size/time limits for the Remote event infrastructure.
 *
 * <p>All bounds are local-only (loopback, a handful of connections) and tuned
 * for responsiveness without unbounded memory.
 */
public final class RemoteGatewayLimits {

    private RemoteGatewayLimits() {
    }

    /** Max buffered events per SSE subscriber before overflow closes the stream. */
    public static final int MAX_EVENTS_PER_SUBSCRIBER = 1024;

    /** SSE heartbeat interval when no events flow. */
    public static final long SSE_HEARTBEAT_MS = 20_000;

    /** Max chars accumulated in a content-delta coalescer chunk before flush. */
    public static final int COALESCER_MAX_CHUNK = 1000;

    /** Max wait (ms) for a content-delta coalescer chunk before a time-based flush. */
    public static final long COALESCER_MAX_WAIT_MS = 600;

    /** Max chars of a permission tool input value serialized into an event payload. */
    public static final int MAX_INTERACTION_INPUT_CHARS = 2000;

    /** Max chars of a plan / question payload serialized into an event payload. */
    public static final int MAX_INTERACTION_PAYLOAD_CHARS = 8000;

    /** Hard cap on a control-endpoint request body (permission/ask/plan/mode/abort). */
    public static final int MAX_CONTROL_BODY_BYTES = 65_536;

    /** Max chars of a single free-text "Other" answer (mirrors desktop limit, §13). */
    public static final int MAX_CUSTOM_INPUT_LENGTH = 2000;

    /** Max number of answer keys accepted in one ask-response body. */
    public static final int MAX_ANSWER_COUNT = 64;

    /** Max total chars across all answer values in one ask-response body. */
    public static final int MAX_TOTAL_ANSWER_CHARS = 65_536;
}
