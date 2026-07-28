package com.github.claudecodegui.settings;

import com.github.claudecodegui.model.PromptScope;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonObject;
import org.junit.After;
import org.junit.Test;

import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

public class CodemossSettingsServicePromptProviderTest {
    private String originalHome;

    @After
    public void restoreHome() throws Exception {
        if (originalHome != null) {
            setHome(originalHome);
        }
    }

    @Test
    public void isolatesProviderReadsAndProtectsCrossProviderDeletes() throws Exception {
        Path home = Files.createTempDirectory("prompt-provider-home");
        originalHome = getHome();
        setHome(home.toString());
        Files.createDirectories(home.resolve(".codemoss"));

        JsonObject config = new JsonObject();
        JsonObject prompts = new JsonObject();
        prompts.add("same-id", prompt("Claude", "claude"));
        prompts.add("codex-id", prompt("Codex", "codex"));
        config.add("prompts", prompts);
        Files.writeString(home.resolve(".codemoss/prompt.json"), config.toString());

        CodemossSettingsService service = new CodemossSettingsService();
        List<JsonObject> codexPrompts = service.getPrompts(PromptScope.GLOBAL, null, "codex");
        assertEquals(1, codexPrompts.size());
        assertEquals("codex-id", codexPrompts.get(0).get("id").getAsString());

        assertFalse(service.deletePrompt("same-id", PromptScope.GLOBAL, null, "codex"));
        assertEquals(2, service.getPromptManager(PromptScope.GLOBAL, null).getPrompts().size());
    }

    private static JsonObject prompt(String name, String provider) {
        JsonObject prompt = new JsonObject();
        prompt.addProperty("id", provider + "-id");
        if ("claude".equals(provider)) {
            prompt.addProperty("id", "same-id");
        }
        prompt.addProperty("name", name);
        prompt.addProperty("content", provider);
        prompt.addProperty("provider", provider);
        return prompt;
    }

    private static String getHome() throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        return (String) field.get(null);
    }

    private static void setHome(String home) throws Exception {
        Field field = PlatformUtils.class.getDeclaredField("cachedRealHomeDir");
        field.setAccessible(true);
        field.set(null, home);
    }
}
