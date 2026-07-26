package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class CodexSettingsManagerTomlRoundTripTest {

    private String originalHomeDir;
    private boolean homeOverridden;

    @After
    public void tearDown() throws Exception {
        if (homeOverridden) {
            setCachedHomeDirectory(originalHomeDir);
            homeOverridden = false;
        }
    }

    @Test
    public void shouldPreserveQuotedKeysWhenMergingProviderAndMcpConfig() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-toml-quoted-key-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);
        Files.writeString(
                codexDir.resolve("config.toml"),
                "[mcp_servers.codegraph]\ncommand = \"uvx\"\n",
                StandardCharsets.UTF_8
        );

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        assertTrue(manager.readConfigToml().get("mcp_servers") instanceof Map);
        JsonObject provider = new JsonObject();
        provider.addProperty("id", "proxy");
        provider.addProperty("configToml", "\"provider.name\" = \"proxy\"\n"
                + "\n"
                + "[model_aliases]\n"
                + "\"gpt-5.4\" = \"vendor/gpt-5.4\"\n");

        manager.applyProviderToCodexSettings(provider);

        String writtenConfig = Files.readString(codexDir.resolve("config.toml"), StandardCharsets.UTF_8);
        assertTrue(writtenConfig.contains("\"provider.name\" = \"proxy\""));
        assertTrue(writtenConfig.contains("\"gpt-5.4\" = \"vendor/gpt-5.4\""));
        assertTrue(writtenConfig.contains("[mcp_servers.codegraph]"));
        assertTrue(writtenConfig.contains("command = \"uvx\""));
    }

    @Test
    public void shouldPreserveBackslashesInTomlLiteralStrings() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-toml-literal-home");
        useTemporaryHomeDirectory(tempHome);
        Path codexDir = tempHome.resolve(".codex");
        Files.createDirectories(codexDir);
        Files.writeString(
                codexDir.resolve("config.toml"),
                "[literals]\nwindows_path = 'C:\\tools\\codex'\npattern = '\\d+\\s'\n",
                StandardCharsets.UTF_8
        );

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        @SuppressWarnings("unchecked")
        Map<String, Object> literals = (Map<String, Object>) manager.readConfigToml().get("literals");

        assertEquals("C:\\tools\\codex", literals.get("windows_path"));
        assertEquals("\\d+\\s", literals.get("pattern"));
    }

    @Test
    public void shouldQuoteNonBareKeysAcrossSerializedStructures() throws Exception {
        Path tempHome = Files.createTempDirectory("codex-toml-serialization-home");
        useTemporaryHomeDirectory(tempHome);

        Map<String, Object> config = new LinkedHashMap<>();
        config.put("top.level", "root");
        Map<String, Object> section = new LinkedHashMap<>();
        section.put("nested.key", "nested");
        config.put("section", section);
        Map<String, Object> tableEntry = new LinkedHashMap<>();
        tableEntry.put("entry.key", "entry");
        List<Map<String, Object>> tableEntries = new ArrayList<>();
        tableEntries.add(tableEntry);
        config.put("items", tableEntries);

        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        manager.writeConfigToml(config);

        String writtenConfig = Files.readString(manager.getConfigTomlPath(), StandardCharsets.UTF_8);
        assertTrue(writtenConfig.contains("\"top.level\" = \"root\""));
        assertTrue(writtenConfig.contains("\"nested.key\" = \"nested\""));
        assertTrue(writtenConfig.contains("\"entry.key\" = \"entry\""));
    }

    private void useTemporaryHomeDirectory(Path tempHome) throws Exception {
        if (!homeOverridden) {
            originalHomeDir = getCachedHomeDirectory();
            homeOverridden = true;
        }
        setCachedHomeDirectory(tempHome.toString());
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
}
