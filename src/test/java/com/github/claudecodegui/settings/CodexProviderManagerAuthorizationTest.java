package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CodexProviderManagerAuthorizationTest {

    @Test
    public void cliLoginProviderExposesAuthorizationSeparatelyFromActiveState() {
        JsonObject config = new JsonObject();
        JsonObject codex = new JsonObject();
        codex.addProperty("current", "managed-provider");
        codex.addProperty("localConfigAuthorized", true);
        codex.add("providers", new JsonObject());
        config.add("codex", codex);

        List<JsonObject> providers = manager(config).getCodexProviders();

        assertTrue(providers.get(0).get("localConfigAuthorized").getAsBoolean());
        assertFalse(providers.get(0).get("isActive").getAsBoolean());
    }

    @Test
    public void cliLoginProviderReportsUnauthorizedState() {
        JsonObject config = new JsonObject();

        List<JsonObject> providers = manager(config).getCodexProviders();

        assertFalse(providers.get(0).get("localConfigAuthorized").getAsBoolean());
        assertFalse(providers.get(0).get("isActive").getAsBoolean());
    }

    private CodexProviderManager manager(JsonObject config) {
        return new CodexProviderManager(new Gson(), ignored -> config, ignored -> {
        }, null, null);
    }
}
