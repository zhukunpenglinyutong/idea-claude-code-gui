package com.github.claudecodegui.handler;

import com.google.gson.JsonObject;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

public class CodexMcpServerHandlerWorkingDirectoryTest {

    @Test
    public void injectsSessionWorkingDirectoryWithoutMutatingStoredConfig() {
        JsonObject storedConfig = new JsonObject();
        storedConfig.addProperty("command", "node");

        JsonObject effectiveConfig = CodexMcpServerHandler.prepareServerConfig(
                storedConfig, "C:/project/session", "C:/project/base");

        assertEquals("C:/project/session", effectiveConfig.get("cwd").getAsString());
        assertFalse(storedConfig.has("cwd"));
    }

    @Test
    public void fallsBackToProjectBasePathWhenSessionDirectoryIsBlank() {
        JsonObject effectiveConfig = CodexMcpServerHandler.prepareServerConfig(
                new JsonObject(), "  ", "C:/project/base");

        assertEquals("C:/project/base", effectiveConfig.get("cwd").getAsString());
    }

    @Test
    public void preservesExplicitServerWorkingDirectory() {
        JsonObject storedConfig = new JsonObject();
        storedConfig.addProperty("cwd", "C:/explicit/server");

        JsonObject effectiveConfig = CodexMcpServerHandler.prepareServerConfig(
                storedConfig, "C:/project/session", "C:/project/base");

        assertEquals("C:/explicit/server", effectiveConfig.get("cwd").getAsString());
    }
}
