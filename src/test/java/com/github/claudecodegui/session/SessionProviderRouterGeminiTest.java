package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.gemini.GeminiSDKBridge;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.Collections;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class SessionProviderRouterGeminiTest {

    private static final class StubClaude extends ClaudeSDKBridge {
        final AtomicBoolean interruptCalled = new AtomicBoolean(false);
        final AtomicReference<String> lastLaunchChannel = new AtomicReference<>();

        @Override
        public JsonObject launchChannel(String channelId, String sessionId, String cwd) {
            lastLaunchChannel.set("claude:" + channelId);
            JsonObject r = new JsonObject();
            r.addProperty("success", true);
            r.addProperty("provider", "claude");
            return r;
        }

        @Override
        public void interruptChannel(String channelId) {
            interruptCalled.set(true);
        }

        @Override
        public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
            return Collections.emptyList();
        }
    }

    private static final class StubCodex extends CodexSDKBridge {
        final AtomicBoolean interruptCalled = new AtomicBoolean(false);

        @Override
        public JsonObject launchChannel(String channelId, String sessionId, String cwd) {
            JsonObject r = new JsonObject();
            r.addProperty("success", true);
            r.addProperty("provider", "codex");
            return r;
        }

        @Override
        public void interruptChannel(String channelId) {
            interruptCalled.set(true);
        }

        @Override
        public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
            return Collections.emptyList();
        }
    }

    private static final class StubGemini extends GeminiSDKBridge {
        final AtomicBoolean interruptCalled = new AtomicBoolean(false);
        final AtomicReference<String> lastLaunch = new AtomicReference<>();

        @Override
        public JsonObject launchChannel(String channelId, String sessionId, String cwd) {
            lastLaunch.set(channelId + "|" + sessionId + "|" + cwd);
            JsonObject r = new JsonObject();
            r.addProperty("success", true);
            r.addProperty("provider", "gemini");
            r.addProperty("channelId", channelId);
            return r;
        }

        @Override
        public void interruptChannel(String channelId) {
            interruptCalled.set(true);
        }

        @Override
        public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
            JsonObject m = new JsonObject();
            m.addProperty("type", "assistant");
            m.addProperty("sessionId", sessionId);
            return List.of(m);
        }
    }

    @Test
    public void launchChannelRoutesGemini() {
        StubClaude claude = new StubClaude();
        StubCodex codex = new StubCodex();
        StubGemini gemini = new StubGemini();
        SessionProviderRouter router = new SessionProviderRouter(claude, codex, null, null, gemini);

        JsonObject result = router.launchChannel("gemini", "ch-1", "sid-1", "/tmp/p");
        assertTrue(result.get("success").getAsBoolean());
        assertEquals("gemini", result.get("provider").getAsString());
        assertEquals("ch-1|sid-1|/tmp/p", gemini.lastLaunch.get());
    }

    @Test
    public void interruptChannelRoutesGemini() {
        StubClaude claude = new StubClaude();
        StubCodex codex = new StubCodex();
        StubGemini gemini = new StubGemini();
        SessionProviderRouter router = new SessionProviderRouter(claude, codex, null, null, gemini);

        router.interruptChannel("gemini", "ch-9");
        assertTrue(gemini.interruptCalled.get());
        assertTrue(!claude.interruptCalled.get());
        assertTrue(!codex.interruptCalled.get());
    }

    @Test
    public void getSessionMessagesRoutesGemini() {
        StubClaude claude = new StubClaude();
        StubCodex codex = new StubCodex();
        StubGemini gemini = new StubGemini();
        SessionProviderRouter router = new SessionProviderRouter(claude, codex, null, null, gemini);

        List<JsonObject> msgs = router.getSessionMessages("gemini", "sid-g", "/cwd");
        assertEquals(1, msgs.size());
        assertEquals("sid-g", msgs.get(0).get("sessionId").getAsString());
    }

    @Test
    public void nullGeminiBridgeFallsBackToClaude() {
        StubClaude claude = new StubClaude();
        StubCodex codex = new StubCodex();
        SessionProviderRouter router = new SessionProviderRouter(claude, codex, null, null, null);

        JsonObject result = router.launchChannel("gemini", "ch", "s", "/c");
        assertEquals("claude", result.get("provider").getAsString());
        assertEquals("claude:ch", claude.lastLaunchChannel.get());
    }
}
