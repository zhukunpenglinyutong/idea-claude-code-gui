package com.github.claudecodegui.settings;

import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

public class CodemossSettingsServicePromptEnhancerConfigTest {
    private String originalHomeDir;

    @After
    public void tearDown() throws Exception {
        if (originalHomeDir != null) {
            setCachedHomeDirectory(originalHomeDir);
            originalHomeDir = null;
        }
    }

    @Test
    public void shouldDefaultToCodexWhenBothProvidersAreConfiguredAndInstalled() throws Exception {
        Path tempHome = Files.createTempDirectory("prompt-enhancer-default-codex-home");
        useTemporaryHomeDirectory(tempHome);
        writeConfig(tempHome, "claude-a", "codex-a");
        installSdk(tempHome, "claude-sdk", "@anthropic-ai/claude-agent-sdk", "0.2.88");
        installSdk(tempHome, "codex-sdk", "@openai/codex-sdk", "0.117.0");

        CodemossSettingsService service = new CodemossSettingsService();

        JsonObject config = invokeGetPromptEnhancerConfig(service);

        assertTrue(config.get("provider").isJsonNull());
        assertEquals("codex", config.get("effectiveProvider").getAsString());
        assertEquals("auto", config.get("resolutionSource").getAsString());
        assertTrue(config.getAsJsonObject("availability").get("claude").getAsBoolean());
        assertTrue(config.getAsJsonObject("availability").get("codex").getAsBoolean());
        assertEquals("claude-sonnet-5", config.getAsJsonObject("models").get("claude").getAsString());
        assertEquals("gpt-5.5", config.getAsJsonObject("models").get("codex").getAsString());
        // Same CLI set as the main chat selector
        assertEquals("grok", config.getAsJsonObject("models").get("grok").getAsString());
        assertEquals("auto", config.getAsJsonObject("models").get("kimi").getAsString());
        assertEquals("opencode-default", config.getAsJsonObject("models").get("opencode").getAsString());
        assertEquals("auto", config.getAsJsonObject("models").get("pi").getAsString());
        assertEquals("auto", config.getAsJsonObject("models").get("omp").getAsString());
        assertTrue(config.getAsJsonObject("availability").has("grok"));
        assertTrue(config.getAsJsonObject("availability").has("kimi"));
        assertTrue(config.getAsJsonObject("availability").has("opencode"));
        assertTrue(config.getAsJsonObject("availability").has("pi"));
        assertTrue(config.getAsJsonObject("availability").has("omp"));
    }

    @Test
    public void shouldPreferCurrentChatProviderInAutoModeWhenAvailable() throws Exception {
        Path tempHome = Files.createTempDirectory("prompt-enhancer-prefer-chat-home");
        useTemporaryHomeDirectory(tempHome);
        writeConfig(tempHome, "claude-a", "codex-a");
        installSdk(tempHome, "claude-sdk", "@anthropic-ai/claude-agent-sdk", "0.2.88");
        installSdk(tempHome, "codex-sdk", "@openai/codex-sdk", "0.117.0");

        CodemossSettingsService service = new CodemossSettingsService();

        // Preferred provider unavailable → still Codex
        JsonObject withoutGrok = invokeGetPromptEnhancerConfig(service, "grok");
        assertTrue(withoutGrok.get("provider").isJsonNull());
        // Grok CLI may or may not be installed on the machine; if not, fall back to codex.
        String effectiveWithoutInstalledGrok = withoutGrok.get("effectiveProvider").isJsonNull()
                ? null
                : withoutGrok.get("effectiveProvider").getAsString();
        if (!withoutGrok.getAsJsonObject("availability").get("grok").getAsBoolean()) {
            assertEquals("codex", effectiveWithoutInstalledGrok);
        } else {
            assertEquals("grok", effectiveWithoutInstalledGrok);
        }

        // Preferred Claude is installed → follow chat provider over Codex
        JsonObject preferClaude = invokeGetPromptEnhancerConfig(service, "claude");
        assertTrue(preferClaude.get("provider").isJsonNull());
        assertEquals("claude", preferClaude.get("effectiveProvider").getAsString());
        assertEquals("auto", preferClaude.get("resolutionSource").getAsString());

        // Preferred Codex still works
        JsonObject preferCodex = invokeGetPromptEnhancerConfig(service, "codex");
        assertEquals("codex", preferCodex.get("effectiveProvider").getAsString());
    }

    @Test
    public void shouldDefaultToClaudeWhenOnlyClaudeIsAvailable() throws Exception {
        Path tempHome = Files.createTempDirectory("prompt-enhancer-default-claude-home");
        useTemporaryHomeDirectory(tempHome);
        writeConfig(tempHome, "claude-a", "");
        installSdk(tempHome, "claude-sdk", "@anthropic-ai/claude-agent-sdk", "0.2.88");

        CodemossSettingsService service = new CodemossSettingsService();

        JsonObject config = invokeGetPromptEnhancerConfig(service);

        assertTrue(config.get("provider").isJsonNull());
        assertEquals("claude", config.get("effectiveProvider").getAsString());
        assertEquals("auto", config.get("resolutionSource").getAsString());
        assertTrue(config.getAsJsonObject("availability").get("claude").getAsBoolean());
        assertFalse(config.getAsJsonObject("availability").get("codex").getAsBoolean());
    }

    @Test
    public void shouldPersistManualProviderAndProviderSpecificModels() throws Exception {
        Path tempHome = Files.createTempDirectory("prompt-enhancer-manual-home");
        useTemporaryHomeDirectory(tempHome);
        writeConfig(tempHome, "claude-a", "codex-a");
        installSdk(tempHome, "claude-sdk", "@anthropic-ai/claude-agent-sdk", "0.2.88");
        installSdk(tempHome, "codex-sdk", "@openai/codex-sdk", "0.117.0");

        CodemossSettingsService service = new CodemossSettingsService();

        invokeSetPromptEnhancerConfig(service, "claude", "claude-opus-5", "gpt-5.4");
        JsonObject config = invokeGetPromptEnhancerConfig(service);

        assertEquals("claude", config.get("provider").getAsString());
        assertEquals("claude", config.get("effectiveProvider").getAsString());
        assertEquals("manual", config.get("resolutionSource").getAsString());
        assertEquals("claude-opus-5", config.getAsJsonObject("models").get("claude").getAsString());
        assertEquals("gpt-5.4", config.getAsJsonObject("models").get("codex").getAsString());
        // Partial legacy set keeps default CLI models
        assertEquals("grok", config.getAsJsonObject("models").get("grok").getAsString());
    }

    @Test
    public void shouldPersistManualGrokProviderAndModel() throws Exception {
        Path tempHome = Files.createTempDirectory("prompt-enhancer-grok-home");
        useTemporaryHomeDirectory(tempHome);
        writeConfig(tempHome, "claude-a", "codex-a");
        installSdk(tempHome, "claude-sdk", "@anthropic-ai/claude-agent-sdk", "0.2.88");
        installSdk(tempHome, "codex-sdk", "@openai/codex-sdk", "0.117.0");

        CodemossSettingsService service = new CodemossSettingsService();
        JsonObject models = new JsonObject();
        models.addProperty("claude", "claude-sonnet-5");
        models.addProperty("codex", "gpt-5.5");
        models.addProperty("grok", "grok");

        Method setMethod = CodemossSettingsService.class.getMethod(
                "setPromptEnhancerConfig", String.class, JsonObject.class);
        setMethod.invoke(service, "grok", models);

        JsonObject config = invokeGetPromptEnhancerConfig(service);
        assertEquals("grok", config.get("provider").getAsString());
        assertEquals("grok", config.getAsJsonObject("models").get("grok").getAsString());
        // effectiveProvider depends on whether Grok CLI is installed on the machine
        String source = config.get("resolutionSource").getAsString();
        assertTrue("manual".equals(source) || "unavailable".equals(source));
    }

    @Test
    public void shouldReturnUnavailableWhenManualProviderIsNotAvailable() throws Exception {
        Path tempHome = Files.createTempDirectory("prompt-enhancer-unavailable-home");
        useTemporaryHomeDirectory(tempHome);
        writeConfig(tempHome, "", "");

        CodemossSettingsService service = new CodemossSettingsService();

        invokeSetPromptEnhancerConfig(service, "claude", "claude-opus-5", "gpt-5.4");
        JsonObject config = invokeGetPromptEnhancerConfig(service);

        assertEquals("claude", config.get("provider").getAsString());
        assertTrue(config.get("effectiveProvider").isJsonNull());
        assertEquals("unavailable", config.get("resolutionSource").getAsString());
        assertFalse(config.getAsJsonObject("availability").get("claude").getAsBoolean());
        assertFalse(config.getAsJsonObject("availability").get("codex").getAsBoolean());
    }

    private JsonObject invokeGetPromptEnhancerConfig(CodemossSettingsService service) throws Exception {
        Method method;
        try {
            method = CodemossSettingsService.class.getMethod("getPromptEnhancerConfig");
        } catch (NoSuchMethodException e) {
            fail("CodemossSettingsService should expose getPromptEnhancerConfig()");
            throw e;
        }
        return (JsonObject) method.invoke(service);
    }

    private JsonObject invokeGetPromptEnhancerConfig(
            CodemossSettingsService service,
            String preferredProvider
    ) throws Exception {
        Method method;
        try {
            method = CodemossSettingsService.class.getMethod("getPromptEnhancerConfig", String.class);
        } catch (NoSuchMethodException e) {
            fail("CodemossSettingsService should expose getPromptEnhancerConfig(String preferredProvider)");
            throw e;
        }
        return (JsonObject) method.invoke(service, preferredProvider);
    }

    private void invokeSetPromptEnhancerConfig(
            CodemossSettingsService service,
            String provider,
            String claudeModel,
            String codexModel
    ) throws Exception {
        Method method;
        try {
            method = CodemossSettingsService.class.getMethod(
                    "setPromptEnhancerConfig",
                    String.class,
                    String.class,
                    String.class
            );
        } catch (NoSuchMethodException e) {
            fail("CodemossSettingsService should expose setPromptEnhancerConfig(provider, claudeModel, codexModel)");
            throw e;
        }
        method.invoke(service, provider, claudeModel, codexModel);
    }

    private void useTemporaryHomeDirectory(Path tempHome) throws Exception {
        if (originalHomeDir == null) {
            originalHomeDir = getCachedHomeDirectory();
        }
        setCachedHomeDirectory(tempHome.toString());
        Files.createDirectories(tempHome.resolve(".codemoss"));
    }

    private void writeConfig(Path tempHome, String currentClaude, String currentCodex) throws Exception {
        JsonObject config = new JsonObject();

        JsonObject claude = new JsonObject();
        claude.addProperty("current", currentClaude);
        JsonObject claudeProviders = new JsonObject();
        if (currentClaude != null && !currentClaude.isEmpty()) {
            JsonObject provider = new JsonObject();
            provider.addProperty("name", "Claude A");
            provider.add("settingsConfig", new JsonObject());
            claudeProviders.add(currentClaude, provider);
        }
        claude.add("providers", claudeProviders);
        config.add("claude", claude);

        JsonObject codex = new JsonObject();
        codex.addProperty("current", currentCodex);
        codex.addProperty("localConfigAuthorized", false);
        JsonObject codexProviders = new JsonObject();
        if (currentCodex != null && !currentCodex.isEmpty()) {
            JsonObject provider = new JsonObject();
            provider.addProperty("name", "Codex A");
            provider.add("configToml", new JsonObject());
            provider.add("authJson", new JsonObject());
            codexProviders.add(currentCodex, provider);
        }
        codex.add("providers", codexProviders);
        config.add("codex", codex);

        Files.writeString(
                tempHome.resolve(".codemoss").resolve("config.json"),
                config.toString()
        );
    }

    private void installSdk(Path tempHome, String sdkId, String npmPackage, String version) throws Exception {
        Path packageDir = tempHome.resolve(".codemoss")
                .resolve("dependencies")
                .resolve(sdkId)
                .resolve("node_modules");

        for (String segment : npmPackage.split("/")) {
            packageDir = packageDir.resolve(segment);
        }

        Files.createDirectories(packageDir);
        JsonObject pkgJson = new JsonObject();
        pkgJson.addProperty("name", npmPackage);
        pkgJson.addProperty("version", version);
        Files.writeString(packageDir.resolve("package.json"), pkgJson.toString());
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
