package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.google.gson.JsonObject;

import java.util.List;

/**
 * Centralizes provider-specific bridge routing for session operations.
 */
public class SessionProviderRouter {

    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;

    public SessionProviderRouter(ClaudeSDKBridge claudeSDKBridge, CodexSDKBridge codexSDKBridge) {
        this.claudeSDKBridge = claudeSDKBridge;
        this.codexSDKBridge = codexSDKBridge;
    }

    public JsonObject launchChannel(String provider, String channelId, String sessionId, String cwd) {
        if ("codex".equals(provider)) {
            return codexSDKBridge.launchChannel(channelId, sessionId, cwd);
        }
        return claudeSDKBridge.launchChannel(channelId, sessionId, cwd);
    }

    public void interruptChannel(String provider, String channelId) {
        if ("codex".equals(provider)) {
            codexSDKBridge.interruptChannel(channelId);
            return;
        }
        claudeSDKBridge.interruptChannel(channelId);
    }

    /**
     * Clear provider abort state on turn completion (provider-abort final closure), so
     * the next turn is not falsely aborted by a stale interrupt. Claude clears the
     * daemon bridge flag + per-channel pending interrupt; Codex clears the per-channel
     * pending interrupt.
     */
    public void clearAbort(String provider, String channelId) {
        try {
            if ("codex".equals(provider)) {
                codexSDKBridge.clearAbort(channelId);
            } else {
                claudeSDKBridge.clearAbort(channelId);
            }
        } catch (Throwable t) {
            // Best-effort cleanup; never destabilize the send path.
        }
    }

    public List<JsonObject> getSessionMessages(String provider, String sessionId, String cwd) {
        if ("codex".equals(provider)) {
            return codexSDKBridge.getSessionMessages(sessionId, cwd);
        }
        return claudeSDKBridge.getSessionMessages(sessionId, cwd);
    }
}
