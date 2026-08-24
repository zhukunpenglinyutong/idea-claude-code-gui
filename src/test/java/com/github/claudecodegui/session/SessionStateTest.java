package com.github.claudecodegui.session;

import org.junit.Assert;
import org.junit.Test;

/**
 * Regression tests for retired Claude model id migration on session state writes
 * (persisted tab / history restore self-heal) - see #1678.
 */
public class SessionStateTest {

    @Test
    public void setModelMigratesRetiredSonnet47ToSonnet5() {
        SessionState state = new SessionState();
        // Saved by versions <= 0.5.2 where sonnet-4-7 was the default model.
        state.setModel("claude-sonnet-4-7");
        Assert.assertEquals("claude-sonnet-5", state.getModel());
    }

    @Test
    public void setModelMigratesRetiredSonnet46ToSonnet5() {
        SessionState state = new SessionState();
        state.setModel("claude-sonnet-4-6");
        Assert.assertEquals("claude-sonnet-5", state.getModel());
    }

    @Test
    public void setModelMigratesRetiredOpus46ToOpus48() {
        SessionState state = new SessionState();
        state.setModel("claude-opus-4-6");
        Assert.assertEquals("claude-opus-4-8", state.getModel());
    }

    @Test
    public void setModelPreserves1MSuffixWhenMigrating() {
        SessionState state = new SessionState();
        state.setModel("claude-sonnet-4-7[1m]");
        Assert.assertEquals("claude-sonnet-5[1m]", state.getModel());
    }

    @Test
    public void setModelKeepsRetiredIdsLiveForNonClaudeProviders() {
        // Regression (gemini/agy): claude-sonnet-4-6 is retired in the Claude API
        // but LIVE in the agy catalog ("Claude Sonnet 4.6 (Thinking)"). The
        // migration used to rewrite it to claude-sonnet-5 on every provider, so
        // selecting Sonnet 4.6 in the gemini menu sent --model claude-sonnet-5
        // to agy ("invalid model selection"). Only the Claude provider migrates.
        SessionState state = new SessionState();
        state.setProvider("gemini");
        state.setModel("claude-sonnet-4-6");
        Assert.assertEquals("claude-sonnet-4-6", state.getModel());
        // The [1m] variant must survive too (claude-tab poisoning carried it).
        state.setModel("claude-sonnet-4-6[1m]");
        Assert.assertEquals("claude-sonnet-4-6[1m]", state.getModel());
        // Opus 4.6 is likewise live in agy.
        state.setModel("claude-opus-4-6");
        Assert.assertEquals("claude-opus-4-6", state.getModel());
    }

    @Test
    public void setModelMigratesRetiredIdsAfterSwitchingBackToClaudeProvider() {
        // Restore order everywhere is provider-then-model; a tab switched back to
        // the Claude provider must still self-heal retired ids (#1678 intact).
        SessionState state = new SessionState();
        state.setProvider("gemini");
        state.setProvider("claude");
        state.setModel("claude-sonnet-4-6");
        Assert.assertEquals("claude-sonnet-5", state.getModel());
    }

    @Test
    public void setModelLeavesLiveModelsUntouched() {
        SessionState state = new SessionState();
        state.setModel("claude-sonnet-5");
        Assert.assertEquals("claude-sonnet-5", state.getModel());
        state.setModel("claude-opus-4-8[1m]");
        Assert.assertEquals("claude-opus-4-8[1m]", state.getModel());
    }

    @Test
    public void setModelLeavesNonClaudeAndUnknownIdsUntouched() {
        SessionState state = new SessionState();
        // Non-Claude provider models must pass through unchanged.
        state.setModel("gpt-5.6-sol");
        Assert.assertEquals("gpt-5.6-sol", state.getModel());
        state.setModel("qwen3.5-plus");
        Assert.assertEquals("qwen3.5-plus", state.getModel());
    }

    @Test
    public void setModelHandlesNullAndBlank() {
        SessionState state = new SessionState();
        state.setModel(null);
        Assert.assertNull(state.getModel());
        // Blank input is trimmed like every other normalizeRetiredModelId path.
        state.setModel("  ");
        Assert.assertEquals("", state.getModel());
    }

    @Test
    public void defaultModelIsTheLiveSonnet5() {
        SessionState state = new SessionState();
        // The initial value must never be a retired id (#1678).
        Assert.assertEquals("claude-sonnet-5", state.getModel());
    }
}
