package com.github.claudecodegui.provider.claude.usage;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class RelayUsageEnvTest {

    private static JsonObject env(String json) {
        JsonObject settings = new JsonObject();
        settings.add("env", JsonParser.parseString(json).getAsJsonObject());
        return settings;
    }

    @Test
    public void token_prefersAuthTokenFallsBackToApiKey() {
        assertEquals("auth-tok", RelayUsageEnv.from(env(
                "{\"ANTHROPIC_BASE_URL\":\"https://api.z.ai\",\"ANTHROPIC_AUTH_TOKEN\":\"auth-tok\",\"ANTHROPIC_API_KEY\":\"sk-key\"}")).token());
        assertEquals("sk-key", RelayUsageEnv.from(env(
                "{\"ANTHROPIC_BASE_URL\":\"https://api.z.ai\",\"ANTHROPIC_API_KEY\":\"sk-key\"}")).token());
        assertNull(RelayUsageEnv.from(env("{\"ANTHROPIC_BASE_URL\":\"https://api.z.ai\"}")).token());
    }

    @Test
    public void model_followsEnvTierChain() {
        assertEquals("glm-4.7", RelayUsageEnv.from(env(
                "{\"ANTHROPIC_MODEL\":\"glm-4.7\",\"ANTHROPIC_DEFAULT_SONNET_MODEL\":\"other\"}")).model());
        assertEquals("sonnet-model", RelayUsageEnv.from(env(
                "{\"ANTHROPIC_DEFAULT_SONNET_MODEL\":\"sonnet-model\",\"ANTHROPIC_DEFAULT_HAIKU_MODEL\":\"haiku\"}")).model());
        assertEquals("fable-model", RelayUsageEnv.from(env(
                "{\"ANTHROPIC_DEFAULT_FABLE_MODEL\":\"fable-model\"}")).model());
        assertNull(RelayUsageEnv.from(env("{}")).model());
    }

    @Test
    public void from_nullOrMissingEnvBlockYieldsEmptySnapshot() {
        assertNull(RelayUsageEnv.from(null).baseUrl());
        assertNull(RelayUsageEnv.from(new JsonObject()).token());
    }
}
