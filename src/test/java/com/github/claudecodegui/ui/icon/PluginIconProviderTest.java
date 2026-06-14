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
        // The provider keeps static caches; restore defaults so test ordering cannot leak
        // state into other suites.
        PluginIconProvider.setCoDriverIconEnabledCache(true);
        PluginIconProvider.setCoDriverThemeActiveCache(false);
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

    @Test
    public void iconActiveOnlyWhenThemeActiveAndToggleEnabled() {
        PluginIconProvider.setCoDriverIconEnabledCache(true);
        PluginIconProvider.setCoDriverThemeActiveCache(true);
        Assert.assertTrue(PluginIconProvider.isCoDriverIconActive());
        Assert.assertEquals(
                "/icons/codriver-tool-icon.svg",
                PluginIconProvider.resolvePluginIconPath(PluginIconProvider.isCoDriverIconActive()));
    }

    @Test
    public void iconInactiveWhenThemeNotActiveEvenIfToggleEnabled() {
        // The reported bug: toggle on, but a non-CoDriver theme must still show the original icon.
        PluginIconProvider.setCoDriverIconEnabledCache(true);
        PluginIconProvider.setCoDriverThemeActiveCache(false);
        Assert.assertFalse(PluginIconProvider.isCoDriverIconActive());
        Assert.assertEquals(
                "/icons/cc-gui-icon.svg",
                PluginIconProvider.resolvePluginIconPath(PluginIconProvider.isCoDriverIconActive()));
    }

    @Test
    public void iconInactiveWhenToggleDisabledEvenInCoDriverTheme() {
        PluginIconProvider.setCoDriverIconEnabledCache(false);
        PluginIconProvider.setCoDriverThemeActiveCache(true);
        Assert.assertFalse(PluginIconProvider.isCoDriverIconActive());
    }
}
