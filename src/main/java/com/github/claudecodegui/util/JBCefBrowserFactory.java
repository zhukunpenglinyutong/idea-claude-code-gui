package com.github.claudecodegui.util;

import com.intellij.ide.plugins.IdeaPluginDescriptor;
import com.intellij.ide.plugins.PluginManagerCore;
import com.intellij.openapi.application.ApplicationInfo;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.extensions.PluginId;
import com.intellij.openapi.util.SystemInfo;
import com.intellij.openapi.util.registry.Registry;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefBrowserBase;
import com.intellij.ui.jcef.JBCefBrowserBuilder;
import org.cef.browser.CefBrowser;
import org.cef.handler.CefKeyboardHandler;
import org.cef.handler.CefKeyboardHandlerAdapter;
import org.cef.misc.BoolRef;

import java.lang.reflect.Method;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.function.BooleanSupplier;

/**
 * JBCefBrowser factory.
 * Centrally manages JBCefBrowser creation, configuring the appropriate
 * OSR (Off-Screen Rendering) mode based on the platform and IDEA version.
 *
 * OSR mode behavior:
 * - macOS: OSR disabled (uses native rendering)
 * - Windows: OSR disabled
 * - Linux/Unix: OSR enabled for IDEA 2023+, disabled for earlier versions
 */
public final class JBCefBrowserFactory {

    private static final Logger LOG = Logger.getInstance(JBCefBrowserFactory.class);
    private static final int CONTROL_CHAR_MAX = 0x1F;
    private static final String JCEF_ENABLED_REGISTRY_KEY = "ide.browser.jcef.enabled";
    private static final PluginId JCEF_PLUGIN_ID = PluginId.getId("com.intellij.modules.jcef");
    private static final ConcurrentMap<Class<?>, Optional<Method>> IS_CLOSED_METHODS = new ConcurrentHashMap<>();

    /**
     * First platform baseline version (2026.1) whose JBCefApp initialization
     * calls JCefAppConfig.isRemoteEnabled(). Older platforms work fine with
     * JBRs that lack this API, so the mismatch check must not apply to them.
     */
    private static final int REMOTE_API_REQUIRED_SINCE_BASELINE = 261;

    /** First JBR build line that ships JCefAppConfig.isRemoteEnabled(). */
    public static final String REQUIRED_JBR_BUILD = "b1373";

    /** Describes why JCEF can or cannot be used in the current IDE. */
    public enum JcefSupportStatus {
        SUPPORTED,
        DISABLED_BY_REGISTRY,
        OUTDATED_JBR,
        ANDROID_STUDIO_PLUGIN_MISSING,
        UNAVAILABLE
    }

    private JBCefBrowserFactory() {
        // Utility class, do not instantiate
    }

    /**
     * Create a JBCefBrowser instance.
     * Automatically selects the appropriate OSR setting based on the current platform and IDEA version.
     *
     * @return a JBCefBrowser instance
     */
    public static JBCefBrowser create() {
        boolean isOffScreenRendering = determineOsrMode();
        boolean isDevMode = PlatformUtils.isPluginDevMode();
        LOG.info("Creating JBCefBrowser with OSR=" + isOffScreenRendering
                + " (platform=" + getPlatformName() + ", ideaVersion=" + getIdeaMajorVersion()
                + ", devMode=" + isDevMode + ")");

        try {
            JBCefBrowserBuilder builder = JBCefBrowser.createBuilder()
                    .setOffScreenRendering(isOffScreenRendering)
                    .setEnableOpenDevToolsMenuItem(isDevMode);
                    // .setCreateImmediately(true) // Causes new tabs to permanently stall on "Checking SDK status..." - commented out; using default lazy-load mode instead
            JBCefBrowser browser = builder.build();
            configureKeyboardWorkaround(browser);
            configureContextMenu(browser, isDevMode);
            LOG.info("JBCefBrowser created successfully using builder");
            return browser;
        } catch (Exception | LinkageError e) {
            LOG.warn("JBCefBrowser builder failed, falling back to default constructor (missing OSR and dev-tools config)", e);
            try {
                JBCefBrowser browser = new JBCefBrowser();
                configureContextMenu(browser, isDevMode);
                configureKeyboardWorkaround(browser);
                return browser;
            } catch (Exception | LinkageError fallbackFailure) {
                throw newJcefUnavailableException(fallbackFailure);
            }
        }
    }

    /**
     * Create a JBCefBrowser instance and load the specified URL.
     *
     * @param url the URL to load
     * @return a JBCefBrowser instance
     */
    public static JBCefBrowser create(String url) {
        boolean isOffScreenRendering = determineOsrMode();
        boolean isDevMode = PlatformUtils.isPluginDevMode();
        LOG.info("Creating JBCefBrowser with URL and OSR=" + isOffScreenRendering + ", devMode=" + isDevMode);

        try {
            JBCefBrowserBuilder builder = JBCefBrowser.createBuilder()
                    .setOffScreenRendering(isOffScreenRendering)
                    .setEnableOpenDevToolsMenuItem(isDevMode)
                    .setCreateImmediately(true)
                    .setUrl(url);
            JBCefBrowser browser = builder.build();
            configureKeyboardWorkaround(browser);
            configureContextMenu(browser, isDevMode);
            LOG.info("JBCefBrowser created successfully with URL");
            return browser;
        } catch (Exception | LinkageError e) {
            LOG.warn("JBCefBrowser builder failed, falling back to default constructor (missing OSR and dev-tools config)", e);
            try {
                JBCefBrowser browser = new JBCefBrowser();
                if (url != null && !url.isEmpty()) {
                    browser.loadURL(url);
                }
                configureContextMenu(browser, isDevMode);
                configureKeyboardWorkaround(browser);
                return browser;
            } catch (Exception | LinkageError fallbackFailure) {
                throw newJcefUnavailableException(fallbackFailure);
            }
        }
    }

    /**
     * Wrap a fatal browser-creation failure into an IllegalStateException whose
     * message mentions JCEF. A LinkageError here usually means the IDE's JBR and
     * platform disagree on the JCEF API (e.g. Android Studio 2026.x bundling a
     * JBR without JCefAppConfig.isRemoteEnabled()). Callers already route
     * IllegalStateException with "JCEF" in the message to their
     * "JCEF not supported" UI, so this turns an uncatchable EDT crash into a
     * graceful error panel.
     */
    private static IllegalStateException newJcefUnavailableException(Throwable cause) {
        LOG.error("JCEF browser creation failed completely", cause);
        return new IllegalStateException("JCEF browser creation failed: " + cause, cause);
    }

    /**
     * Determine whether to enable OSR mode based on platform and IDEA version.
     *
     * @return true to enable OSR, false to disable
     */
    private static boolean determineOsrMode() {
        if (SystemInfo.isMac) {
            // macOS: disable OSR
            return false;
        } else if (SystemInfo.isLinux || SystemInfo.isUnix) {
            // Linux/Unix: depends on IDEA version
            int version = getIdeaMajorVersion();
            // Enable OSR for IDEA 2023+
            return version >= 2023;
        } else if (SystemInfo.isWindows) {
            // Windows: disable OSR
            return false;
        }
        // Unknown platform, disable OSR by default
        return false;
    }

    /**
     * Get the IDEA major version number.
     *
     * @return the IDEA major version (e.g., 2023, 2024), or 0 if parsing fails
     */
    private static int getIdeaMajorVersion() {
        try {
            ApplicationInfo appInfo = ApplicationInfo.getInstance();
            var majorVersion = appInfo.getMajorVersion();
            return Integer.parseInt(majorVersion);
        } catch (Exception e) {
            LOG.warn("Failed to get IDEA version: " + e.getMessage());
        }
        return 0;
    }

    /**
     * Get the current platform name (for logging purposes).
     *
     * @return the platform name
     */
    private static String getPlatformName() {
        if (SystemInfo.isMac) {
            return "macOS";
        } else if (SystemInfo.isLinux) {
            return "Linux";
        } else if (SystemInfo.isUnix) {
            return "Unix";
        } else if (SystemInfo.isWindows) {
            return "Windows";
        }
        return "Unknown";
    }

    /**
     * Checks whether a CEF browser is known to be closed.
     *
     * <p>The {@code CefBrowser.isClosed()} API is not available on every JCEF
     * version supported by this plugin's 233+ platform range. Reflection keeps
     * the guard optional: an older runtime without the method is treated as
     * active, while invocation failures on runtimes that expose it are treated
     * as closed.</p>
     *
     * @param browser the CEF browser to inspect.
     * @return true when the browser is null, reports closed, or cannot be queried safely.
     */
    public static boolean isBrowserClosed(CefBrowser browser) {
        if (browser == null) {
            return true;
        }
        Optional<Method> method = IS_CLOSED_METHODS.computeIfAbsent(
                browser.getClass(), JBCefBrowserFactory::findIsClosedMethod);
        if (method.isEmpty()) {
            return false;
        }
        try {
            return Boolean.TRUE.equals(method.get().invoke(browser));
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
            LOG.debug("Failed to query JCEF browser closed state: " + e.getMessage(), e);
            return true;
        }
    }

    static Optional<Method> findIsClosedMethod(Class<?> browserClass) {
        try {
            return Optional.of(browserClass.getMethod("isClosed"));
        } catch (NoSuchMethodException | SecurityException | LinkageError e) {
            return Optional.empty();
        }
    }

    /**
     * Check whether JCEF is available.
     *
     * @return true if JCEF is supported
     */
    public static boolean isJcefSupported() {
        return getJcefSupportStatus() == JcefSupportStatus.SUPPORTED;
    }

    /**
     * Resolve JCEF availability without calling {@code JBCefApp.isSupported()}
     * while the IDE registry explicitly disables JCEF. The platform caches the
     * first support result, so calling it too early would keep returning false
     * even after the user enables JCEF for the current process.
     *
     * @return the current JCEF support status
     */
    public static JcefSupportStatus getJcefSupportStatus() {
        try {
            return determineJcefSupport(
                    Registry.is(JCEF_ENABLED_REGISTRY_KEY, true),
                    com.intellij.ui.jcef.JBCefApp::isSupported,
                    JBCefBrowserFactory::isJbrMissingJcefRemoteApi,
                    JBCefBrowserFactory::isAndroidStudioJcefPluginMissing
            );
        } catch (Exception | LinkageError e) {
            LOG.warn("Failed to check JCEF support: " + e.getMessage());
            return JcefSupportStatus.UNAVAILABLE;
        }
    }

    static JcefSupportStatus determineJcefSupport(
            boolean registryEnabled,
            BooleanSupplier platformSupported,
            BooleanSupplier remoteApiMissing,
            BooleanSupplier androidStudioPluginMissing
    ) {
        if (!registryEnabled) {
            return JcefSupportStatus.DISABLED_BY_REGISTRY;
        }
        if (!platformSupported.getAsBoolean()) {
            if (androidStudioPluginMissing.getAsBoolean()) {
                return JcefSupportStatus.ANDROID_STUDIO_PLUGIN_MISSING;
            }
            return JcefSupportStatus.UNAVAILABLE;
        }
        if (remoteApiMissing.getAsBoolean()) {
            LOG.warn("JCEF disabled: this platform requires JCefAppConfig.isRemoteEnabled() but the current"
                    + " JBR does not provide it. Upgrade the Boot Java Runtime to a JBR with JCEF "
                    + REQUIRED_JBR_BUILD + " or newer.");
            return JcefSupportStatus.OUTDATED_JBR;
        }
        return JcefSupportStatus.SUPPORTED;
    }

    /**
     * Enable the IDE registry flag used by {@code JBCefApp.isSupported()}.
     * A restart is still required because the platform caches support checks.
     *
     * @return true when the registry value was updated successfully
     */
    public static boolean enableJcefInRegistry() {
        try {
            Registry.get(JCEF_ENABLED_REGISTRY_KEY).setValue(true);
            return Registry.is(JCEF_ENABLED_REGISTRY_KEY, true);
        } catch (Exception | LinkageError e) {
            LOG.warn("Failed to enable JCEF in IDE registry: " + e.getMessage(), e);
            return false;
        }
    }

    private static boolean isAndroidStudioJcefPluginMissing() {
        String productCode = ApplicationInfo.getInstance().getBuild().getProductCode();
        boolean supportedOs = SystemInfo.isWindows || SystemInfo.isMac;
        IdeaPluginDescriptor descriptor = PluginManagerCore.getPlugin(JCEF_PLUGIN_ID);
        boolean pluginUnavailable = descriptor == null || !descriptor.isEnabled();
        return "AI".equals(productCode) && supportedOs && pluginUnavailable;
    }

    /**
     * Detect the known platform/JBR mismatch where the IDE platform (2026.1+)
     * calls {@code JCefAppConfig.isRemoteEnabled()} during JBCefApp
     * initialization but the bundled JBR predates that API (older than
     * {@link #REQUIRED_JBR_BUILD}), e.g. Android Studio Quail 2026.1.1.
     * Initializing JCEF in that state throws NoSuchMethodError.
     *
     * @return true if the current JBR is missing the JCEF remote API required by this platform
     */
    public static boolean isJbrMissingJcefRemoteApi() {
        try {
            int baseline = ApplicationInfo.getInstance().getBuild().getBaselineVersion();
            if (!isRemoteApiRequiredByPlatform(baseline)) {
                return false;
            }
            Class<?> config = Class.forName("com.jetbrains.cef.JCefAppConfig");
            return !hasJcefRemoteApi(config);
        } catch (Exception | LinkageError e) {
            // Cannot determine; do not block normal initialization.
            LOG.warn("Failed to detect JBR JCEF remote API availability: " + e.getMessage());
            return false;
        }
    }

    /**
     * Whether the given platform baseline version requires the JCEF remote API
     * ({@code JCefAppConfig.isRemoteEnabled()}) during JBCefApp initialization.
     */
    static boolean isRemoteApiRequiredByPlatform(int baselineVersion) {
        return baselineVersion >= REMOTE_API_REQUIRED_SINCE_BASELINE;
    }

    /**
     * Whether the given JCefAppConfig class exposes {@code isRemoteEnabled()}.
     */
    static boolean hasJcefRemoteApi(Class<?> jcefAppConfigClass) {
        try {
            jcefAppConfigClass.getMethod("isRemoteEnabled");
            return true;
        } catch (NoSuchMethodException e) {
            return false;
        }
    }

    /**
     * Configure the browser context menu.
     * Enables the context menu in development mode and disables it in production.
     *
     * @param browser the JBCefBrowser instance
     */
    private static void configureContextMenu(JBCefBrowser browser, boolean isDevMode) {
        browser.setProperty(JBCefBrowserBase.Properties.NO_CONTEXT_MENU, !isDevMode);
        LOG.info("Context menu " + (isDevMode ? "enabled" : "disabled") + " (devMode=" + isDevMode + ")");
    }

    /**
     * Workaround for Windows JCEF issue where IME composition and certain key combinations
     * generate control character events on non-editable fields, causing unwanted input in the chat area.
     */
    private static void configureKeyboardWorkaround(JBCefBrowser browser) {
        if (!SystemInfo.isWindows) {
            return;
        }
        // Register via getCefClient().addKeyboardHandler rather than the
        // JBCefClient.addKeyboardHandler convenience overload — the JCEF docs
        // warn against the convenience methods. The browser's implicit client
        // serves only this browser, so this matches the original pre-build
        // behaviour without leaking a separately-created JBCefClient.
        browser.getJBCefClient().getCefClient().addKeyboardHandler(createKeyboardWorkaroundHandler());
    }

    private static CefKeyboardHandler createKeyboardWorkaroundHandler() {
        return new CefKeyboardHandlerAdapter() {
            @Override
            public boolean onPreKeyEvent(CefBrowser cefBrowser, CefKeyboardHandler.CefKeyEvent event, BoolRef isKeyboardShortcut) {
                if (shouldSuppressProblematicCharEvent(event)) {
                    LOG.debug("[JCEF] Suppressed problematic key event before platform conversion: " + event);
                    return true;
                }
                return false;
            }
        };
    }

    static boolean shouldSuppressProblematicCharEvent(CefKeyboardHandler.CefKeyEvent event) {
        if (event == null) {
            return false;
        }
        if (event.type != CefKeyboardHandler.CefKeyEvent.EventType.KEYEVENT_CHAR) {
            return false;
        }
        if (event.focus_on_editable_field) {
            return false;
        }
        if (event.windows_key_code == 0) {
            return false;
        }
        return event.character == 0 || event.character <= CONTROL_CHAR_MAX;
    }
}
