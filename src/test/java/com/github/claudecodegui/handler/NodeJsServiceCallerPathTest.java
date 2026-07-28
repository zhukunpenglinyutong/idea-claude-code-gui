package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;

public class NodeJsServiceCallerPathTest {

    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    private TestClaudeSDKBridge bridge;
    private HandlerContext context;

    @Before
    public void setUp() throws Exception {
        Path bridgeDir = temporaryFolder.newFolder("bridge'quoted").toPath();
        Path servicesDir = Files.createDirectories(bridgeDir.resolve("services"));
        writeService(servicesDir.resolve("session-titles-service.cjs"),
                "module.exports = {"
                        + " loadTitles: () => ({}),"
                        + " updateTitle: (sessionId, title) => ({ sessionId, title }),"
                        + " deleteTitle: () => true"
                        + " };\n");
        writeService(servicesDir.resolve("favorites-service.cjs"),
                "module.exports = {"
                        + " loadFavorites: sessionId => ({ sessionId }),"
                        + " toggleFavorite: sessionId => ({ sessionId })"
                        + " };\n");
        writeService(servicesDir.resolve("input-history-service.cjs"),
                "module.exports = {"
                        + " getAllHistoryData: () => ({ items: ['ok'], counts: {} })"
                        + " };\n");

        bridge = new TestClaudeSDKBridge(bridgeDir.toFile());
        context = new HandlerContext(null, bridge, null, null, new HandlerContext.JsCallback() {
            @Override
            public void callJavaScript(String functionName, String... args) {
            }

            @Override
            public String escapeJs(String str) {
                return str;
            }
        });
    }

    @Test
    public void titleServiceLoadsFromPathContainingSingleQuote() throws Exception {
        String result = new NodeJsServiceCaller(context)
                .callNodeJsTitlesServiceWithParams("updateTitle", "session-1", "Quoted title");

        JsonObject json = JsonParser.parseString(result).getAsJsonObject();
        assertEquals("session-1", json.get("sessionId").getAsString());
        assertEquals("Quoted title", json.get("title").getAsString());
        assertEquals(0, bridge.getProcessManager().getActiveProcessCount());
    }

    @Test
    public void favoritesServiceLoadsFromPathContainingSingleQuote() throws Exception {
        String result = new NodeJsServiceCaller(context)
                .callNodeJsFavoritesService("loadFavorites", "session-2");

        JsonObject json = JsonParser.parseString(result).getAsJsonObject();
        assertEquals("session-2", json.get("sessionId").getAsString());
        assertEquals(0, bridge.getProcessManager().getActiveProcessCount());
    }

    @Test
    public void inputHistoryServiceLoadsFromPathContainingSingleQuote() throws Exception {
        String result = new InputHistoryHandler(context)
                .callInputHistoryService("getAllHistoryData", null);

        JsonObject json = JsonParser.parseString(result).getAsJsonObject();
        assertEquals("ok", json.getAsJsonArray("items").get(0).getAsString());
        assertEquals(0, bridge.getProcessManager().getActiveProcessCount());
    }

    @Test
    public void servicePathIsConvertedForWslNode() {
        Assume.assumeTrue(NodeDetector.isWslPath("/usr/bin/node"));

        assertEquals(
                "/mnt/c/Users/g'f'd/bridge/services/session-titles-service.cjs",
                NodeJsServiceCaller.resolveServicePath(
                        "/usr/bin/node", "C:\\Users\\g'f'd\\bridge", "session-titles-service.cjs"));
    }

    private static void writeService(Path path, String content) throws IOException {
        Files.writeString(path, content, StandardCharsets.UTF_8);
    }

    private static final class TestClaudeSDKBridge extends ClaudeSDKBridge {
        private final File sdkDir;
        private final ProcessManager processManager = new ProcessManager();

        private TestClaudeSDKBridge(File sdkDir) {
            this.sdkDir = sdkDir;
        }

        @Override
        public File getSdkTestDir() {
            return sdkDir;
        }

        @Override
        public String getNodeExecutable() {
            return "node";
        }

        @Override
        public ProcessManager getProcessManager() {
            return processManager;
        }
    }
}
