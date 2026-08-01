package com.github.claudecodegui.session;

import java.util.Objects;

/**
 * Immutable provider + channel identity for a single ClaudeSession Agent turn.
 *
 * <p>Established synchronously at turn start (after {@code launchClaude()} allocates
 * the channelId) and frozen for the entire turn lifecycle — provider launch, provider
 * send, interrupt, Desktop Stop, Remote Abort, Gateway dispose, and terminal cleanup
 * all use the SAME identity. Mutable {@link SessionState} changes do NOT affect an
 * already-started turn.
 *
 * <p>Turn Identity Freeze Closure (Phase 2C-C.1): the last Core invariant before
 * Core Freeze.
 */
public final class TurnIdentity {

    private final String provider;
    private final String channelId;

    public TurnIdentity(String provider, String channelId) {
        this.provider = provider;
        this.channelId = channelId;
    }

    public String provider() {
        return provider;
    }

    public String channelId() {
        return channelId;
    }

    @Override
    public boolean equals(Object o) {
        if (this == o) { return true; }
        if (!(o instanceof TurnIdentity)) { return false; }
        TurnIdentity that = (TurnIdentity) o;
        return Objects.equals(provider, that.provider)
                && Objects.equals(channelId, that.channelId);
    }

    @Override
    public int hashCode() {
        return Objects.hash(provider, channelId);
    }

    @Override
    public String toString() {
        return "TurnIdentity{provider=" + provider + ", channelId=" + channelId + '}';
    }
}
