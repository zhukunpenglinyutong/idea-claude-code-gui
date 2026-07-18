package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.AiProviderBridge;
import com.github.claudecodegui.provider.common.AiProviderRegistry;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.ppcc.PpccSDKBridge;
import com.google.gson.JsonObject;

import java.util.List;

/** Centralizes provider-specific bridge routing for session operations. */
public class SessionProviderRouter {

    private final AiProviderRegistry registry;

    public SessionProviderRouter(
            ClaudeSDKBridge claudeSDKBridge,
            CodexSDKBridge codexSDKBridge,
            PpccSDKBridge ppccSDKBridge
    ) {
        this(new AiProviderRegistry()
                .register(claudeSDKBridge)
                .register(codexSDKBridge)
                .register(ppccSDKBridge));
    }

    SessionProviderRouter(AiProviderRegistry registry) {
        this.registry = registry;
    }

    public JsonObject launchChannel(String provider, String channelId, String sessionId, String cwd) {
        return registry.launchChannel(provider, channelId, sessionId, cwd);
    }

    public void interruptChannel(String provider, String channelId) {
        registry.interruptChannel(provider, channelId);
    }

    public List<JsonObject> getSessionMessages(String provider, String sessionId, String cwd) {
        AiProviderBridge bridge = registry.require(provider);
        return bridge.getSessionMessages(sessionId, cwd);
    }
}
