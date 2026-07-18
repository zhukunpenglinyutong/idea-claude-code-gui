package com.github.claudecodegui.provider.common;

import com.google.gson.JsonObject;

import java.util.List;

/** Minimal lifecycle/history contract used by session routing. */
public interface AiProviderBridge {
    String providerId();
    JsonObject launchChannel(String channelId, String sessionId, String cwd);
    void interruptChannel(String channelId);
    List<JsonObject> getSessionMessages(String sessionId, String cwd);
}
