package com.github.claudecodegui.handler.icon;

import org.junit.Assert;
import org.junit.Test;

/**
 * Unit tests for {@link NativeFileIconHandler#createIconCacheKey}. The key must be
 * scoped by the active Look-and-Feel so cached icons are not reused across theme
 * switches. The pure static method is testable without the IDE platform.
 */
public class NativeFileIconHandlerTest {

    @Test
    public void cacheKeyDistinguishesLookAndFeel() {
        String dark = NativeFileIconHandler.createIconCacheKey("Darcula", "/x/a.ts", "a.ts", false);
        String light = NativeFileIconHandler.createIconCacheKey("IntelliJ Light", "/x/a.ts", "a.ts", false);

        Assert.assertNotEquals(dark, light);
    }

    @Test
    public void cacheKeyIsStableForSameInputs() {
        String first = NativeFileIconHandler.createIconCacheKey("Darcula", "/x/a.ts", "a.ts", false);
        String second = NativeFileIconHandler.createIconCacheKey("Darcula", "/x/a.ts", "a.ts", false);

        Assert.assertEquals(first, second);
    }

    @Test
    public void cacheKeyDistinguishesDirectoryFlag() {
        String file = NativeFileIconHandler.createIconCacheKey("Darcula", "/x/a", "a", false);
        String directory = NativeFileIconHandler.createIconCacheKey("Darcula", "/x/a", "a", true);

        Assert.assertNotEquals(file, directory);
    }

    @Test
    public void cacheKeyStartsWithLookAndFeelName() {
        String key = NativeFileIconHandler.createIconCacheKey("Darcula", "/x/a.ts", "a.ts", false);

        Assert.assertTrue(key.startsWith("Darcula|"));
    }

    @Test
    public void cacheKeyToleratesNullPathAndName() {
        String key = NativeFileIconHandler.createIconCacheKey("IntelliJ Light", null, null, true);

        Assert.assertEquals("IntelliJ Light|||true", key);
    }
}
