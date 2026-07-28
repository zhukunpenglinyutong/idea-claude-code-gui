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

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class CodexSettingsManagerModelAliasTest {
    private String originalHome;

    @After
    public void restoreHome() throws Exception {
        if (originalHome != null) {
            setHome(originalHome);
        }
    }

    @Test
    public void resolvesQuotedModelAliases() throws Exception {
        prepareHome("[model_aliases]\n\"gpt-5.5\" = \"proxy-gpt-5.5\"\n");
        CodexSettingsManager manager = new CodexSettingsManager(new Gson());

        assertEquals("proxy-gpt-5.5", manager.resolveModelAlias("gpt-5.5"));
        assertEquals("gpt-5.4", manager.resolveModelAlias("gpt-5.4"));
    }

    @Test
    public void resolvesInlineTableAliases() throws Exception {
        prepareHome("model_aliases = { \"gpt-5.5\" = \"proxy-gpt-5.5\" }\n");
        CodexSettingsManager manager = new CodexSettingsManager(new Gson());

        assertEquals("proxy-gpt-5.5", manager.resolveModelAlias("gpt-5.5"));
    }

    @Test
    public void preservesLiteralBackslashesInAliasKeysAndValues() throws Exception {
        prepareHome("[model_aliases]\n'gpt\\\\5.6' = 'vendor\\\\gpt'\n");
        CodexSettingsManager manager = new CodexSettingsManager(new Gson());

        assertEquals("vendor\\\\gpt", manager.resolveModelAlias("gpt\\\\5.6"));
    }

    @Test
    public void preservesAliasesAndExistingMcpServersWhenApplyingProvider() throws Exception {
        Path home = prepareHome("[mcp_servers.codegraph]\ncommand = \"uvx\"\n");
        CodexSettingsManager manager = new CodexSettingsManager(new Gson());
        JsonObject provider = new JsonObject();
        provider.addProperty("id", "proxy");
        provider.addProperty("configToml", "model = \"gpt-5.5\"\n\n[model_aliases]\n\"gpt-5.5\" = \"proxy-gpt-5.5\"\n");

        manager.applyProviderToCodexSettings(provider);

        String written = Files.readString(home.resolve(".codex/config.toml"), StandardCharsets.UTF_8);
        assertTrue(written.contains("[model_aliases]"));
        assertTrue(written.contains("\"gpt-5.5\" = \"proxy-gpt-5.5\""));
        assertTrue(written.contains("[mcp_servers.codegraph]"));
        assertEquals("proxy-gpt-5.5", manager.resolveModelAlias("gpt-5.5"));
    }

    private Path prepareHome(String configToml) throws Exception {
        Path home = Files.createTempDirectory("codex-model-alias-home");
        if (originalHome == null) {
            originalHome = getHome();
        }
        setHome(home.toString());
        Path codexDir = home.resolve(".codex");
        Files.createDirectories(codexDir);
        Files.writeString(codexDir.resolve("config.toml"), configToml, StandardCharsets.UTF_8);
        return home;
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
