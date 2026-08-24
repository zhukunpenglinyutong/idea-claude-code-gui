package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.SDKResult;
import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.github.claudecodegui.provider.gemini.GeminiSDKBridge;
import com.github.claudecodegui.provider.grok.GrokSDKBridge;
import com.github.claudecodegui.provider.kimi.KimiCliBridge;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.util.Collections;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/**
 * Pins the gemini null-onward cwd contract: the Java guard must never pass
 * a rejected cwd down the bridge — the JS side then applies its own safe
 * default instead of anchoring the session to the value just rejected.
 * Fake-bridge pattern from SessionProviderRouterGeminiTest. The grok/CLI
 * send sites carry the same guard — same fake pattern, same contract.
 */
public class SessionSendServiceGeminiCwdTest {

    @Rule
    public TemporaryFolder tempDir = new TemporaryFolder();

    private static final class CapturingGeminiBridge extends GeminiSDKBridge {
        final AtomicReference<String> lastCwd = new AtomicReference<>("(never called)");

        @Override
        public CompletableFuture<SDKResult> sendMessage(
                String channelId,
                String message,
                String sessionId,
                String runtimeSessionEpoch,
                String cwd,
                java.util.List<com.github.claudecodegui.session.ClaudeSession.Attachment> attachments,
                String permissionMode,
                String model,
                JsonObject openedFiles,
                String agentPrompt,
                Boolean streaming,
                boolean disableThinking,
                String reasoningEffort,
                com.github.claudecodegui.provider.common.MessageCallback callback
        ) {
            lastCwd.set(cwd);
            return CompletableFuture.completedFuture(SDKResult.success("ok"));
        }
    }

    /** Captures the cwd of the 14-arg Claude-shaped overload sendToGrok invokes. */
    private static final class CapturingGrokBridge extends GrokSDKBridge {
        final AtomicReference<String> lastCwd = new AtomicReference<>("(never called)");

        @Override
        public CompletableFuture<SDKResult> sendMessage(
                String channelId,
                String message,
                String sessionId,
                String runtimeSessionEpoch,
                String cwd,
                java.util.List<com.github.claudecodegui.session.ClaudeSession.Attachment> attachments,
                String permissionMode,
                String model,
                JsonObject openedFiles,
                String agentPrompt,
                Boolean streaming,
                boolean disableThinking,
                String reasoningEffort,
                com.github.claudecodegui.provider.common.MessageCallback callback
        ) {
            lastCwd.set(cwd);
            return CompletableFuture.completedFuture(SDKResult.success("ok"));
        }
    }

    /** Captures the cwd of the full overload the CLI send path delegates to. */
    private static final class CapturingKimiBridge extends KimiCliBridge {
        final AtomicReference<String> lastCwd = new AtomicReference<>("(never called)");

        @Override
        public CompletableFuture<SDKResult> sendMessage(
                String channelId,
                String message,
                String sessionId,
                String cwd,
                String model,
                String reasoningEffort,
                java.util.List<com.github.claudecodegui.session.ClaudeSession.Attachment> attachments,
                String permissionMode,
                String dshPreset,
                com.github.claudecodegui.provider.common.MessageCallback callback
        ) {
            lastCwd.set(cwd);
            return CompletableFuture.completedFuture(SDKResult.success("ok"));
        }
    }

    private SessionSendService newService(SessionState state, CapturingGeminiBridge bridge) {
        return new SessionSendService(
                null, // project — readStreamingEnabled/getBasePath null-guarded
                state,
                new SessionCallbackFacade(null),
                new MessageParser(),
                new MessageMerger(),
                new Gson(),
                null,
                null,
                Collections.emptyMap(),
                new SessionContextService(null),
                null,
                bridge
        );
    }

    private SessionSendService newServiceWithGrok(SessionState state, CapturingGrokBridge bridge) {
        return new SessionSendService(
                null,
                state,
                new SessionCallbackFacade(null),
                new MessageParser(),
                new MessageMerger(),
                new Gson(),
                null,
                null,
                Collections.emptyMap(),
                new SessionContextService(null),
                bridge,
                null
        );
    }

    private SessionSendService newServiceWithCliBridges(SessionState state, Map<String, MarkerCliBridge> cliBridges) {
        return new SessionSendService(
                null,
                state,
                new SessionCallbackFacade(null),
                new MessageParser(),
                new MessageMerger(),
                new Gson(),
                null,
                null,
                cliBridges,
                new SessionContextService(null),
                null,
                null
        );
    }

    @Test
    public void unsafeCwdIsPassedOnwardAsNull() throws Exception {
        SessionState state = new SessionState();
        state.setProvider("gemini");
        // Real dir with an unsafe name ("/.gemini" suffix is on the Java
        // guard's reject list) — existing-but-rejected must become null, not
        // fall through to the bridge unchanged. (The bridge install tree is
        // rejected by the resolver anchor, not by the "ai-bridge" name, so
        // the fixture uses the name-literal path.)
        File unsafeDir = tempDir.newFolder("work", ".gemini");
        state.setCwd(unsafeDir.getAbsolutePath());

        CapturingGeminiBridge bridge = new CapturingGeminiBridge();
        newService(state, bridge).sendMessageToProvider(
                "ch-1", "hi", null, null, "agent prompt", null, null, null, null, null);

        assertNull("rejected cwd must reach the bridge as null", bridge.lastCwd.get());
    }

    @Test
    public void safeOutOfProjectCwdIsPassedUnclamped() throws Exception {
        SessionState state = new SessionState();
        state.setProvider("gemini");
        // A cwd outside the (null) project is a legitimate custom working
        // directory — it must pass through unchanged, never clamped to a
        // project default.
        File customDir = tempDir.newFolder("custom-workdir");
        state.setCwd(customDir.getAbsolutePath());

        CapturingGeminiBridge bridge = new CapturingGeminiBridge();
        newService(state, bridge).sendMessageToProvider(
                "ch-2", "hi", null, null, "agent prompt", null, null, null, null, null);

        assertEquals(customDir.getAbsolutePath(), bridge.lastCwd.get());
    }

    @Test
    public void grokUnsafeCwdIsPassedOnwardAsNull() throws Exception {
        SessionState state = new SessionState();
        state.setProvider("grok");
        // Same contract as gemini: an existing-but-rejected dir must reach the
        // grok bridge as null, never as the value just rejected.
        File unsafeDir = tempDir.newFolder("work", ".gemini");
        state.setCwd(unsafeDir.getAbsolutePath());

        CapturingGrokBridge bridge = new CapturingGrokBridge();
        newServiceWithGrok(state, bridge).sendMessageToProvider(
                "ch-3", "hi", null, null, "agent prompt", null, null, null, null, null);

        assertNull("rejected cwd must reach the grok bridge as null", bridge.lastCwd.get());
    }

    @Test
    public void grokSafeOutOfProjectCwdIsPassedUnclamped() throws Exception {
        SessionState state = new SessionState();
        state.setProvider("grok");
        File customDir = tempDir.newFolder("grok-custom-workdir");
        state.setCwd(customDir.getAbsolutePath());

        CapturingGrokBridge bridge = new CapturingGrokBridge();
        newServiceWithGrok(state, bridge).sendMessageToProvider(
                "ch-4", "hi", null, null, "agent prompt", null, null, null, null, null);

        assertEquals(customDir.getAbsolutePath(), bridge.lastCwd.get());
    }

    @Test
    public void cliUnsafeCwdIsPassedOnwardAsNull() throws Exception {
        SessionState state = new SessionState();
        state.setProvider("kimi");
        File unsafeDir = tempDir.newFolder("work", ".gemini");
        state.setCwd(unsafeDir.getAbsolutePath());

        CapturingKimiBridge bridge = new CapturingKimiBridge();
        newServiceWithCliBridges(state, Map.of("kimi", bridge)).sendMessageToProvider(
                "ch-5", "hi", null, null, "agent prompt", null, null, null, null, null);

        assertNull("rejected cwd must reach the CLI bridge as null", bridge.lastCwd.get());
    }

    @Test
    public void cliSafeOutOfProjectCwdIsPassedUnclamped() throws Exception {
        SessionState state = new SessionState();
        state.setProvider("kimi");
        File customDir = tempDir.newFolder("cli-custom-workdir");
        state.setCwd(customDir.getAbsolutePath());

        CapturingKimiBridge bridge = new CapturingKimiBridge();
        newServiceWithCliBridges(state, Map.of("kimi", bridge)).sendMessageToProvider(
                "ch-6", "hi", null, null, "agent prompt", null, null, null, null, null);

        assertEquals(customDir.getAbsolutePath(), bridge.lastCwd.get());
    }
}
