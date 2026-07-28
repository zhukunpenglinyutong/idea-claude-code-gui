package com.github.claudecodegui.ui;

import org.junit.Assert;
import org.junit.Test;

import java.util.List;

public class WebviewInitializerTest {

    @Test
    public void bootstrapIncludesEveryFrontendConfiguration() {
        List<String> scripts = WebviewInitializer.buildConfigurationInjections(
                "{\"editor\":true}",
                "{\"ui\":true}",
                "{\"code\":true}",
                "{\"language\":true}"
        );
        String bootstrap = String.join("\n", scripts);

        Assert.assertTrue(bootstrap.contains("applyIdeaFontConfig"));
        Assert.assertTrue(bootstrap.contains("applyUiFontConfig"));
        Assert.assertTrue(bootstrap.contains("applyCodeFontConfig"));
        Assert.assertTrue(bootstrap.contains("applyIdeaLanguageConfig"));
    }

    @Test
    public void shiftEscapeInjectionIsIdempotent() {
        String injection = WebviewInitializer.buildShiftEscInjection("hidePanelQuery();");

        Assert.assertTrue(injection.contains("if (!window.__ccgShiftEscInstalled)"));
        Assert.assertTrue(injection.contains("window.__ccgShiftEscInstalled = true"));
        Assert.assertTrue(injection.contains("hidePanelQuery();"));
    }
}
