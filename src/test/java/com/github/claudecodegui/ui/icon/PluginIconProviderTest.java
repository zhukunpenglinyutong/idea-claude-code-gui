package com.github.claudecodegui.ui.icon;

import org.junit.After;
import org.junit.Assert;
import org.junit.Test;

/**
 * Unit tests for the central {@link PluginIconProvider} resolution logic. These cover the
 * preference-to-icon mapping and the cache fast path without touching the IDE platform
 * (no {@code IconLoader}/settings IO), so they run in the plain JUnit suite.
 */
public class PluginIconProviderTest {

    @After
    public void resetCache() {
        // The provider keeps a static preference cache; restore the default (CoDriver) so
        // test ordering cannot leak state into other suites.
        PluginIconProvider.setCoDriverIconEnabledCache(true);
    }

    @Test
    public void resolvesCoDriverIconWhenEnabled() {
        Assert.assertEquals("/icons/codriver-tool-icon.svg", PluginIconProvider.resolvePluginIconPath(true));
    }

    @Test
    public void resolvesOriginalIconWhenDisabled() {
        Assert.assertEquals("/icons/cc-gui-icon.svg", PluginIconProvider.resolvePluginIconPath(false));
    }

    @Test
    public void cacheReflectsEnabledPreference() {
        PluginIconProvider.setCoDriverIconEnabledCache(true);
        Assert.assertTrue(PluginIconProvider.isCoDriverIconEnabled());
        Assert.assertEquals(
                "/icons/codriver-tool-icon.svg",
                PluginIconProvider.resolvePluginIconPath(PluginIconProvider.isCoDriverIconEnabled()));
    }

    @Test
    public void cacheReflectsDisabledPreference() {
        PluginIconProvider.setCoDriverIconEnabledCache(false);
        Assert.assertFalse(PluginIconProvider.isCoDriverIconEnabled());
        Assert.assertEquals(
                "/icons/cc-gui-icon.svg",
                PluginIconProvider.resolvePluginIconPath(PluginIconProvider.isCoDriverIconEnabled()));
    }
}
