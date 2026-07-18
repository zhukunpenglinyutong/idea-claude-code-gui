package com.github.claudecodegui.provider.common;

import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

public class AiProviderRegistryTest {
    private static AiProviderBridge bridge(String id) {
        return new AiProviderBridge() {
            @Override public String providerId() { return id; }
            @Override public JsonObject launchChannel(String channelId, String sessionId, String cwd) {
                JsonObject value = new JsonObject(); value.addProperty("provider", id); return value;
            }
            @Override public void interruptChannel(String channelId) {}
            @Override public List<JsonObject> getSessionMessages(String sessionId, String cwd) { return Collections.emptyList(); }
        };
    }

    @Test
    public void routesExplicitlyAndNeverFallsBackForUnknownProvider() {
        AiProviderRegistry registry = new AiProviderRegistry().register(bridge("claude")).register(bridge("ppcc"));
        assertEquals("ppcc", registry.launchChannel("ppcc", "c", "s", "/tmp").get("provider").getAsString());
        assertThrows(IllegalArgumentException.class, () -> registry.launchChannel("unknown", "c", "s", "/tmp"));
    }
}
