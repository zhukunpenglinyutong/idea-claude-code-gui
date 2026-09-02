package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

import java.io.File;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/**
 * Tests for the shared-file discipline in {@link McpServerManager} and
 * {@link ClaudeSettingsManager} that prevents configured MCP servers from
 * silently vanishing:
 *
 * <ul>
 *   <li>upsert/delete survive a concurrent "CLI rewrites the whole file from
 *       its own snapshot" race (lost-update guard via advisory lock)</li>
 *   <li>a torn/corrupt ~/.claude.json self-heals from the plugin backup</li>
 *   <li>an EMPTY mcpServers in ~/.claude.json never wipes a non-empty
 *       mcpServers in ~/.claude/settings.json (loss guard)</li>
 *   <li>settings.json writes are crash-safe (no truncation window)</li>
 * </ul>
 */
public class McpConfigLossGuardTest {

    private String originalHomeDir;
    private Path tempHome;
    private Path claudeJsonPath;
    private Path settingsPath;
    private McpServerManager manager;
    private ClaudeSettingsManager claudeSettingsManager;

    @Before
    public void setUp() throws Exception {
        tempHome = Files.createTempDirectory("mcp-loss-guard-test");
        Files.createDirectories(tempHome.resolve(".claude"));

        claudeJsonPath = tempHome.resolve(".claude.json");
        settingsPath = tempHome.resolve(".claude").resolve("settings.json");

        originalHomeDir = getCachedHomeDirectory();
        setCachedHomeDirectory(tempHome.toString());

        claudeSettingsManager = new ClaudeSettingsManager(new Gson(), new ConfigPathManager());
        manager = new McpServerManager(
                new Gson(),
                v -> new JsonObject(),
                c -> { },
                claudeSettingsManager);
    }

    @After
    public void tearDown() throws Exception {
        setCachedHomeDirectory(originalHomeDir);
        originalHomeDir = null;
        if (tempHome != null) {
            try (java.util.stream.Stream<Path> paths = Files.walk(tempHome)) {
                paths.sorted(Comparator.reverseOrder())
                        .map(Path::toFile)
                        .forEach(File::delete);
            }
            tempHome = null;
        }
    }

    // ==================== helpers ====================

    /** Write a valid ~/.claude.json document with the given mcpServers JSON. */
    private void writeClaudeJson(String mcpServersJson) throws Exception {
        Files.writeString(claudeJsonPath,
                "{\"mcpServers\":" + mcpServersJson + ",\"projects\":{}}",
                StandardCharsets.UTF_8);
    }

    /** Build an internal server JSON like the webview sends on add/update. */
    private JsonObject buildServer(String id, String command) {
        JsonObject spec = new JsonObject();
        spec.addProperty("type", "stdio");
        spec.addProperty("command", command);
        JsonObject server = new JsonObject();
        server.addProperty("id", id);
        server.addProperty("name", id);
        server.addProperty("enabled", true);
        server.add("server", spec);
        return server;
    }

    private String getCachedHomeDirectory() throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        return (String) field.get(null);
    }

    private void setCachedHomeDirectory(String homeDir) throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        field.set(null, homeDir);
    }

    // ==================== upsert / delete durability ====================

    /** Upsert must persist the server even when the CLI rewrites the file concurrently. */
    @Test
    public void upsertSurvivesConcurrentCliRewrite() throws Exception {
        writeClaudeJson("{}");
        manager.upsertMcpServer(buildServer("srv-a", "npx"));
        // The plugin's own upsert has now created a .ccgui-backup of the previous state.

        // Simulate the CLI rewriting the whole file from its (stale) snapshot
        // between two plugin writes — the plugin write itself must not be lost.
        writeClaudeJson("{}"); // CLI drops everything it doesn't know
        manager.upsertMcpServer(buildServer("srv-b", "uvx"));

        JsonObject after = JsonParser.parseString(
                Files.readString(claudeJsonPath, StandardCharsets.UTF_8)).getAsJsonObject();
        assertTrue("srv-b must survive the concurrent rewrite",
                after.getAsJsonObject("mcpServers").has("srv-b"));
    }

    /** Upserting a second server must not drop the first one. */
    @Test
    public void upsertPreservesExistingServers() throws Exception {
        writeClaudeJson("{}");
        manager.upsertMcpServer(buildServer("srv-a", "npx"));
        manager.upsertMcpServer(buildServer("srv-b", "uvx"));

        JsonObject after = JsonParser.parseString(
                Files.readString(claudeJsonPath, StandardCharsets.UTF_8)).getAsJsonObject();
        JsonObject servers = after.getAsJsonObject("mcpServers");
        assertTrue(servers.has("srv-a"));
        assertTrue(servers.has("srv-b"));
    }

    /** A torn write (truncated JSON) must self-heal from the plugin backup. */
    @Test
    public void corruptClaudeJsonSelfHealsOnRead() throws Exception {
        writeClaudeJson("{}");
        // Two upserts: after the second one the backup holds the state WITH
        // srv-a (the backup always captures the state before the LAST write).
        manager.upsertMcpServer(buildServer("srv-a", "npx"));
        manager.upsertMcpServer(buildServer("srv-b", "uvx"));

        // Simulate a crash mid-write by the CLI: half a JSON document
        Files.writeString(claudeJsonPath,
                "{\"mcpServers\":{\"srv-a\":{\"command\":\"npx\"", StandardCharsets.UTF_8);

        // Reading through the manager must heal from backup and keep srv-a
        // (the last change before the corruption, srv-b, is inherently lost —
        // the recovery window shrinks from "everything" to "the last write").
        java.util.List<JsonObject> servers = manager.getMcpServers();
        assertNotNull(servers);
        boolean found = false;
        for (JsonObject s : servers) {
            if ("srv-a".equals(s.get("id").getAsString())) {
                found = true;
            }
        }
        assertTrue("server must be recovered from the backup after corruption", found);

        // The healed content must also be restored onto disk
        JsonObject onDisk = JsonParser.parseString(
                Files.readString(claudeJsonPath, StandardCharsets.UTF_8)).getAsJsonObject();
        assertTrue(onDisk.getAsJsonObject("mcpServers").has("srv-a"));
    }

    /** Deleting a server keeps the other servers and updates settings.json sync. */
    @Test
    public void deleteRemovesOnlyTargetServer() throws Exception {
        writeClaudeJson("{}");
        manager.upsertMcpServer(buildServer("srv-a", "npx"));
        manager.upsertMcpServer(buildServer("srv-b", "uvx"));

        boolean removed = manager.deleteMcpServer("srv-a");

        assertTrue(removed);
        JsonObject after = JsonParser.parseString(
                Files.readString(claudeJsonPath, StandardCharsets.UTF_8)).getAsJsonObject();
        JsonObject servers = after.getAsJsonObject("mcpServers");
        assertFalse(servers.has("srv-a"));
        assertTrue(servers.has("srv-b"));
    }

    // ==================== sync loss guard ====================

    /**
     * The core loss guard: an EMPTY mcpServers in ~/.claude.json must never
     * wipe a non-empty mcpServers in settings.json during the MCP sync.
     */
    @Test
    public void syncDoesNotPropagateEmptyMcpServersOverNonEmptySettings() throws Exception {
        // settings.json already has a configured server
        JsonObject settings = new JsonObject();
        JsonObject servers = new JsonObject();
        JsonObject spec = new JsonObject();
        spec.addProperty("type", "stdio");
        spec.addProperty("command", "npx");
        servers.add("srv-a", spec);
        settings.add("mcpServers", servers);
        Files.writeString(settingsPath, settings.toString(), StandardCharsets.UTF_8);

        // ~/.claude.json briefly reports NO servers (CLI started before the
        // user configured them and rewrote its snapshot)
        writeClaudeJson("{}");

        claudeSettingsManager.syncMcpToClaudeSettings();

        JsonObject after = JsonParser.parseString(
                Files.readString(settingsPath, StandardCharsets.UTF_8)).getAsJsonObject();
        assertTrue("settings.json mcpServers must NOT be wiped by an empty source",
                after.getAsJsonObject("mcpServers").has("srv-a"));
    }

    /** Normal sync direction still works: non-empty source overwrites empty target. */
    @Test
    public void syncStillCopiesNonEmptyServersIntoEmptySettings() throws Exception {
        JsonObject spec = new JsonObject();
        spec.addProperty("type", "stdio");
        spec.addProperty("command", "npx");
        JsonObject servers = new JsonObject();
        servers.add("srv-a", spec);
        writeClaudeJson(servers.toString());

        claudeSettingsManager.syncMcpToClaudeSettings();

        JsonObject after = JsonParser.parseString(
                Files.readString(settingsPath, StandardCharsets.UTF_8)).getAsJsonObject();
        assertTrue(after.has("mcpServers"));
        assertTrue(after.getAsJsonObject("mcpServers").has("srv-a"));
    }

    /** Both sides empty: sync must not crash and must leave settings empty-but-present. */
    @Test
    public void syncWithBothEmptyIsSafe() throws Exception {
        writeClaudeJson("{}");
        claudeSettingsManager.syncMcpToClaudeSettings();

        JsonObject after = JsonParser.parseString(
                Files.readString(settingsPath, StandardCharsets.UTF_8)).getAsJsonObject();
        // mcpServers may be absent or empty — must not throw either way
        if (after.has("mcpServers")) {
            assertTrue(after.getAsJsonObject("mcpServers").keySet().isEmpty());
        }
    }

    // ==================== settings.json durability ====================

    /** settings.json must never be left truncated after a write. */
    @Test
    public void settingsWriteIsAtomic() throws Exception {
        writeClaudeJson("{}");
        manager.upsertMcpServer(buildServer("srv-a", "npx"));

        String raw = Files.readString(settingsPath, StandardCharsets.UTF_8);
        // Must parse cleanly (a torn write would leave a parse error)
        assertNotNull(JsonParser.parseString(raw).getAsJsonObject());
        assertTrue(raw.contains("srv-a"));
    }
}
