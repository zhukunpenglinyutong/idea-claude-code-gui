package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class CodexContextWindowConfigTest {

    @Test
    public void defaultPresetDoesNotCreateMissingConfig() throws Exception {
        Path codexDir = Files.createTempDirectory("codex-context-default");
        CodexSettingsManager manager = new CodexSettingsManager(new Gson(), codexDir);

        CodexSettingsManager.CodexContextWindowConfig config =
                manager.updateContextWindowPreset("default");

        assertEquals("default", config.getPreset());
        assertEquals(Integer.valueOf(272_000), config.getContextWindow());
        assertEquals(Integer.valueOf(244_800), config.getAutoCompactTokenLimit());
        assertFalse(Files.exists(codexDir.resolve("config.toml")));
    }

    @Test
    public void writes500kAndPreservesBomCrLfCommentsAndSections() throws Exception {
        Path codexDir = Files.createTempDirectory("codex-context-500k");
        Path configPath = codexDir.resolve("config.toml");
        String original = "\uFEFF# keep this comment\r\n"
                + "model_context_window = 1000000 # old\r\n"
                + "model_context_window = 900000 # duplicate\r\n"
                + "model_auto_compact_token_limit = 900000\r\n"
                + "custom_key = \"keep\"\r\n"
                + "\r\n"
                + "[profiles.work]\r\n"
                + "model_context_window = 123456\r\n";
        Files.writeString(configPath, original, StandardCharsets.UTF_8);
        CodexSettingsManager manager = new CodexSettingsManager(new Gson(), codexDir);

        CodexSettingsManager.CodexContextWindowConfig config =
                manager.updateContextWindowPreset("500k");

        String written = Files.readString(configPath, StandardCharsets.UTF_8);
        assertTrue(written.startsWith("\uFEFF# keep this comment\r\n"));
        assertTrue(written.contains("model_context_window = 500000\r\n"));
        assertTrue(written.contains("model_auto_compact_token_limit = 450000\r\n"));
        assertTrue(written.contains("custom_key = \"keep\"\r\n"));
        assertTrue(written.contains("[profiles.work]\r\nmodel_context_window = 123456\r\n"));
        assertEquals(2, countOccurrences(written, "model_context_window ="));
        assertEquals("500k", config.getPreset());
        assertFalse(config.isCustom());
    }

    @Test
    public void writes1mPresetWithNinetyPercentCompaction() throws Exception {
        Path codexDir = Files.createTempDirectory("codex-context-1m");
        CodexSettingsManager manager = new CodexSettingsManager(new Gson(), codexDir);

        CodexSettingsManager.CodexContextWindowConfig config =
                manager.updateContextWindowPreset("1m");

        String written = Files.readString(codexDir.resolve("config.toml"), StandardCharsets.UTF_8);
        assertEquals("model_context_window = 1000000\n"
                + "model_auto_compact_token_limit = 900000\n", written);
        assertEquals("1m", config.getPreset());
        assertEquals(Integer.valueOf(1_000_000), config.getContextWindow());
        assertEquals(Integer.valueOf(900_000), config.getAutoCompactTokenLimit());
    }

    @Test
    public void replacesQuotedTopLevelKeysWithoutCreatingTomlDuplicates() throws Exception {
        Path codexDir = Files.createTempDirectory("codex-context-quoted");
        Path configPath = codexDir.resolve("config.toml");
        Files.writeString(
                configPath,
                "\"model_context_window\" = 1000000\n"
                        + "'model_auto_compact_token_limit' = 900000\n",
                StandardCharsets.UTF_8
        );
        CodexSettingsManager manager = new CodexSettingsManager(new Gson(), codexDir);

        CodexSettingsManager.CodexContextWindowConfig before = manager.readContextWindowConfig();
        CodexSettingsManager.CodexContextWindowConfig after =
                manager.updateContextWindowPreset("500k");

        String written = Files.readString(configPath, StandardCharsets.UTF_8);
        assertEquals("1m", before.getPreset());
        assertEquals("500k", after.getPreset());
        assertEquals("model_context_window = 500000\n"
                + "model_auto_compact_token_limit = 450000\n", written);
        assertFalse(written.contains("\"model_context_window\""));
        assertFalse(written.contains("'model_auto_compact_token_limit'"));
    }

    @Test
    public void defaultRemovesOnlyTopLevelOverrides() throws Exception {
        Path codexDir = Files.createTempDirectory("codex-context-remove");
        Path configPath = codexDir.resolve("config.toml");
        Files.writeString(
                configPath,
                "# context settings\n"
                        + "model_context_window = 500000\n"
                        + "model_auto_compact_token_limit = 450000\n"
                        + "model = \"gpt-5.6-sol\"\n"
                        + "\n"
                        + "[profiles.large]\n"
                        + "model_context_window = 1000000\n"
                        + "model_auto_compact_token_limit = 900000\n",
                StandardCharsets.UTF_8
        );
        CodexSettingsManager manager = new CodexSettingsManager(new Gson(), codexDir);

        CodexSettingsManager.CodexContextWindowConfig config =
                manager.updateContextWindowPreset("default");

        String written = Files.readString(configPath, StandardCharsets.UTF_8);
        String topLevel = written.substring(0, written.indexOf("[profiles.large]"));
        assertFalse(topLevel.contains("model_context_window"));
        assertFalse(topLevel.contains("model_auto_compact_token_limit"));
        assertTrue(written.contains("model = \"gpt-5.6-sol\""));
        assertTrue(written.contains("[profiles.large]\nmodel_context_window = 1000000"));
        assertEquals("default", config.getPreset());
    }

    @Test
    public void readsMismatchedValuesAsCustomWithoutChangingFile() throws Exception {
        Path codexDir = Files.createTempDirectory("codex-context-custom");
        Path configPath = codexDir.resolve("config.toml");
        String original = "model_context_window = 640000\n"
                + "model_auto_compact_token_limit = 500000\n";
        Files.writeString(configPath, original, StandardCharsets.UTF_8);
        CodexSettingsManager manager = new CodexSettingsManager(new Gson(), codexDir);

        CodexSettingsManager.CodexContextWindowConfig config = manager.readContextWindowConfig();

        assertEquals("custom", config.getPreset());
        assertTrue(config.isCustom());
        assertEquals(Integer.valueOf(640_000), config.getContextWindow());
        assertEquals(Integer.valueOf(500_000), config.getAutoCompactTokenLimit());
        assertEquals(original, Files.readString(configPath, StandardCharsets.UTF_8));
    }

    @Test
    public void invalidPresetLeavesConfigUnchanged() throws Exception {
        Path codexDir = Files.createTempDirectory("codex-context-invalid");
        Path configPath = codexDir.resolve("config.toml");
        String original = "model_context_window = 500000\n"
                + "model_auto_compact_token_limit = 450000\n";
        Files.writeString(configPath, original, StandardCharsets.UTF_8);
        CodexSettingsManager manager = new CodexSettingsManager(new Gson(), codexDir);

        try {
            manager.updateContextWindowPreset("2m");
            fail("Expected invalid preset to be rejected");
        } catch (IllegalArgumentException expected) {
            assertTrue(expected.getMessage().contains("2m"));
        }

        assertEquals(original, Files.readString(configPath, StandardCharsets.UTF_8));
    }

    @Test
    public void serviceBroadcastsSuccessfulWritesAndUnregistersCallbacks() throws Exception {
        Path codexDir = Files.createTempDirectory("codex-context-service");
        CodexSettingsManager manager = new CodexSettingsManager(new Gson(), codexDir);
        CodexContextWindowConfigService service =
                CodexContextWindowConfigService.createForTests(manager);
        AtomicInteger firstCalls = new AtomicInteger();
        AtomicInteger secondCalls = new AtomicInteger();
        CodexContextWindowConfigService.RegisteredCallback first =
                service.registerCallback(config -> firstCalls.incrementAndGet());
        service.registerCallback(config -> secondCalls.incrementAndGet());

        CodexContextWindowConfigService.OperationResult firstResult = service.updatePreset("500k");
        service.unregisterCallback(first);
        CodexContextWindowConfigService.OperationResult secondResult = service.updatePreset("1m");

        assertTrue(firstResult.isSuccess());
        assertTrue(secondResult.isSuccess());
        assertEquals(1, firstCalls.get());
        assertEquals(2, secondCalls.get());
        assertNull(secondResult.getError());
        assertEquals("1m", service.readCurrent().getConfig().getPreset());
    }

    @Test
    public void serviceRejectsInvalidPresetWithoutBroadcasting() throws Exception {
        Path codexDir = Files.createTempDirectory("codex-context-service-invalid");
        CodexSettingsManager manager = new CodexSettingsManager(new Gson(), codexDir);
        CodexContextWindowConfigService service =
                CodexContextWindowConfigService.createForTests(manager);
        AtomicInteger calls = new AtomicInteger();
        service.registerCallback(config -> calls.incrementAndGet());

        CodexContextWindowConfigService.OperationResult result = service.updatePreset("invalid");

        assertFalse(result.isSuccess());
        assertEquals(0, calls.get());
        assertFalse(Files.exists(codexDir.resolve("config.toml")));
        assertEquals("default", result.getConfig().getPreset());
    }

    private int countOccurrences(String value, String needle) {
        int count = 0;
        int index = 0;
        while ((index = value.indexOf(needle, index)) >= 0) {
            count++;
            index += needle.length();
        }
        return count;
    }
}
