package com.github.claudecodegui.handler.provider;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class ModelProviderHandlerGeminiTest {

    @Test
    public void geminiCatalogModelsHaveOneMillionContext() {
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("gemini-3.5-flash-medium"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("gemini-3.6-flash-high"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("gemini-3.1-pro-high"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("gemini-3.1-pro-low"));
    }

    @Test
    public void genericGeminiFallbackIsOneMillion() {
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("gemini"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("gemini-unknown-future-model"));
    }

    @Test
    public void agyClaudeCatalogModelsKeepTwoHundredK() {
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-sonnet-4-6"));
        assertEquals(200_000, ModelProviderHandler.getModelContextLimit("claude-opus-4-6-thinking"));
    }

    @Test
    public void effortSuffixDoesNotChangeContextLimit() {
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("gemini-3.6-flash-medium"));
        assertEquals(1_000_000, ModelProviderHandler.getModelContextLimit("gemini-3.6-flash"));
        assertEquals(128_000, ModelProviderHandler.getModelContextLimit("gpt-oss-120b-medium"));
        assertEquals(128_000, ModelProviderHandler.getModelContextLimit("gpt-oss-120b"));
    }

    @Test
    public void switchingFromClaudeToGeminiShutsDownDaemon() {
        assertTrue(ModelProviderHandler.shouldShutdownClaudeDaemonOnProviderSwitch("claude", "gemini"));
    }

    @Test
    public void geminiModelChangeResetsSession() {
        assertTrue(ModelProviderHandler.shouldResetGeminiSessionOnModelChange(
                "gemini", "gemini-3.5-flash-low", "gemini-3.6-flash-medium"));
    }

    @Test
    public void geminiSameModelDoesNotResetSession() {
        assertTrue(!ModelProviderHandler.shouldResetGeminiSessionOnModelChange(
                "gemini", "gemini-3.6-flash-medium", "gemini-3.6-flash-medium"));
    }

    @Test
    public void nonGeminiModelChangeDoesNotResetSession() {
        assertTrue(!ModelProviderHandler.shouldResetGeminiSessionOnModelChange(
                "claude", "claude-sonnet-4-6", "claude-opus-4-6-thinking"));
        assertTrue(!ModelProviderHandler.shouldResetGeminiSessionOnModelChange(
                "codex", "gpt-5.2", "gpt-5.3"));
    }

    @Test
    public void emptyPreviousGeminiModelDoesNotReset() {
        assertTrue(!ModelProviderHandler.shouldResetGeminiSessionOnModelChange(
                "gemini", null, "gemini-3.6-flash-medium"));
        assertTrue(!ModelProviderHandler.shouldResetGeminiSessionOnModelChange(
                "gemini", "", "gemini-3.6-flash-medium"));
    }

    @Test
    public void providerSwitchClearsSession() {
        assertTrue(ModelProviderHandler.shouldClearSessionOnProviderSwitch("claude", "gemini"));
        assertTrue(ModelProviderHandler.shouldClearSessionOnProviderSwitch("gemini", "codex"));
        assertTrue(!ModelProviderHandler.shouldClearSessionOnProviderSwitch("gemini", "gemini"));
        assertTrue(!ModelProviderHandler.shouldClearSessionOnProviderSwitch(null, "gemini"));
        assertTrue(!ModelProviderHandler.shouldClearSessionOnProviderSwitch("gemini", ""));
    }
}
