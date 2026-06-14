package com.github.claudecodegui.ui.icon;

import com.github.claudecodegui.settings.CodemossSettingsService;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.util.IconLoader;
import org.jetbrains.annotations.NotNull;

import javax.swing.Icon;

/**
 * Single source of truth for the plugin's own branding icon.
 *
 * <p>Wherever the plugin shows its CC GUI / Claude Code GUI icon (tool window stripe,
 * editor/console/VCS actions, commit dialog, …) the icon follows the active state: the
 * monochrome CoDriver racer icon is used only when the CoDriver chat theme is active AND
 * the {@code codriverToolIconEnabled} toggle is on; otherwise the original orange icon is
 * used. Callers never hard-code an icon path — they resolve it here so the decision stays
 * consistent everywhere.
 */
public final class PluginIconProvider {

    private static final Logger LOG = Logger.getInstance(PluginIconProvider.class);

    /** Original orange CC GUI icon. */
    static final String ORIGINAL_ICON_PATH = "/icons/cc-gui-icon.svg";
    /** Monochrome CoDriver racer icon (IconLoader resolves the {@code _dark} variant automatically). */
    static final String CODRIVER_ICON_PATH = "/icons/codriver-tool-icon.svg";

    /** PNG window icon (Swing {@code ImageIcon}/{@code setIconImage} cannot render SVG). */
    static final String ORIGINAL_WINDOW_IMAGE_PATH = "/icons/logo-16.png";
    static final String CODRIVER_WINDOW_IMAGE_PATH = "/icons/codriver-tool-icon.png";

    // Cached preferences so per-frame action update() calls (some on the EDT) don't read
    // the settings file repeatedly. Refreshed whenever the values are persisted.
    private static volatile Boolean cachedCoDriverIconEnabled = null;
    private static volatile Boolean cachedCoDriverThemeActive = null;

    private PluginIconProvider() {
    }

    /**
     * Update the cached toggle preference. Call this right after the setting is persisted so
     * every icon surface (tool window, actions, commit dialog) reflects the change without IO.
     */
    public static void setCoDriverIconEnabledCache(boolean enabled) {
        cachedCoDriverIconEnabled = enabled;
    }

    /**
     * Update the cached "CoDriver theme active" flag. Call this right after it is persisted so
     * the icon follows the active chat theme without re-reading settings.
     */
    public static void setCoDriverThemeActiveCache(boolean active) {
        cachedCoDriverThemeActive = active;
    }

    /**
     * Resolve which icon resource path applies for a given preference value. Pure function,
     * independent of settings/IO so it can be unit tested without the IDE platform.
     */
    @NotNull
    public static String resolvePluginIconPath(boolean coDriverIconEnabled) {
        return coDriverIconEnabled ? CODRIVER_ICON_PATH : ORIGINAL_ICON_PATH;
    }

    /**
     * Resolve the PNG window-icon resource path for a given preference value. Pure function
     * for unit testing; used by AWT frames that set their icon via {@code setIconImage}.
     */
    @NotNull
    public static String resolvePluginWindowImagePath(boolean coDriverIconEnabled) {
        return coDriverIconEnabled ? CODRIVER_WINDOW_IMAGE_PATH : ORIGINAL_WINDOW_IMAGE_PATH;
    }

    /** The PNG window-icon resource path matching the current effective state. */
    @NotNull
    public static String getCurrentPluginWindowImagePath() {
        return resolvePluginWindowImagePath(isCoDriverIconActive());
    }

    /** The original orange plugin icon, regardless of the current preference. */
    @NotNull
    public static Icon getOriginalPluginIcon() {
        return loadIcon(false);
    }

    /** The monochrome CoDriver plugin icon, regardless of the current preference. */
    @NotNull
    public static Icon getCoDriverPluginIcon() {
        return loadIcon(true);
    }

    /** The icon matching an explicit preference value. */
    @NotNull
    public static Icon getPluginIcon(boolean coDriverIconEnabled) {
        return loadIcon(coDriverIconEnabled);
    }

    /** The icon matching the current effective state (CoDriver theme active AND toggle on). */
    @NotNull
    public static Icon getCurrentPluginIcon() {
        return loadIcon(isCoDriverIconActive());
    }

    /**
     * Whether the monochrome CoDriver icon should currently be shown: only when the CoDriver
     * chat theme is active AND the toggle is enabled. Any other theme uses the original icon
     * regardless of the toggle.
     */
    public static boolean isCoDriverIconActive() {
        return isCoDriverThemeActive() && isCoDriverIconEnabled();
    }

    /**
     * Read the persisted toggle. Defaults to the CoDriver icon on failure, mirroring the
     * default-enabled behaviour of the setting.
     */
    public static boolean isCoDriverIconEnabled() {
        Boolean cached = cachedCoDriverIconEnabled;
        if (cached != null) {
            return cached;
        }
        boolean enabled;
        try {
            enabled = new CodemossSettingsService().getCoDriverToolIconEnabled();
        } catch (Exception e) {
            LOG.warn("[PluginIconProvider] Failed to read CoDriver tool icon preference; using CoDriver icon", e);
            enabled = true;
        }
        cachedCoDriverIconEnabled = enabled;
        return enabled;
    }

    /**
     * Whether the CoDriver chat theme is currently active. Defaults to false on failure so a
     * non-CoDriver theme never shows the CoDriver icon.
     */
    public static boolean isCoDriverThemeActive() {
        Boolean cached = cachedCoDriverThemeActive;
        if (cached != null) {
            return cached;
        }
        boolean active;
        try {
            active = new CodemossSettingsService().getCoDriverThemeActive();
        } catch (Exception e) {
            LOG.warn("[PluginIconProvider] Failed to read CoDriver theme active flag; assuming inactive", e);
            active = false;
        }
        cachedCoDriverThemeActive = active;
        return active;
    }

    private static Icon loadIcon(boolean coDriverIconEnabled) {
        return IconLoader.getIcon(resolvePluginIconPath(coDriverIconEnabled), PluginIconProvider.class);
    }
}
