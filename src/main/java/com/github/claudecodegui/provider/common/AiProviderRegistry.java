package com.github.claudecodegui.provider.common;

import com.google.gson.JsonObject;

import java.util.HashMap;
import java.util.Map;

/** Explicit provider registry; unknown providers never fall back to Claude. */
public final class AiProviderRegistry {
    private final Map<String, AiProviderBridge> bridges = new HashMap<>();

    public AiProviderRegistry register(AiProviderBridge bridge) {
        if (bridge != null) {
            bridges.put(bridge.providerId(), bridge);
        }
        return this;
    }

    public AiProviderBridge require(String providerId) {
        AiProviderBridge bridge = bridges.get(providerId);
        if (bridge == null) {
            throw new IllegalArgumentException("Unknown AI provider: " + providerId);
        }
        return bridge;
    }

    public JsonObject launchChannel(String providerId, String channelId, String sessionId, String cwd) {
        return require(providerId).launchChannel(channelId, sessionId, cwd);
    }

    public void interruptChannel(String providerId, String channelId) {
        require(providerId).interruptChannel(channelId);
    }
}
