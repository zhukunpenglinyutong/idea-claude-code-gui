package com.github.claudecodegui.remote;

import com.github.claudecodegui.util.PlatformUtils;

/**
 * Reads the Remote Gateway enable flag from the environment.
 *
 * <p>The gateway is OFF by default. It is enabled only when the
 * {@code CCGUI_REMOTE_ENABLED} environment variable is set (case-insensitive)
 * to one of {@code 1}, {@code true}, {@code yes}. Every other value — including
 * unset — leaves the gateway disabled so no port is ever listened on without an
 * explicit opt-in.
 *
 * <p>This is a pure, IntelliJ-independent helper so it can be unit-tested
 * without booting the platform.
 */
public final class RemoteGatewayConfig {

    /** Environment variable that opts the gateway on. */
    public static final String ENV_ENABLED = "CCGUI_REMOTE_ENABLED";

    private RemoteGatewayConfig() {
    }

    /**
     * @return true only when the env var is set to an accepted truthy value.
     */
    public static boolean isEnabled() {
        return isEnabled(readEnv());
    }

    /**
     * Parse a raw env value into an enabled flag. Exposed for testing so the
     * parsing rules are decoupled from {@code System.getenv}.
     *
     * @param raw the raw env value, possibly null/blank
     * @return true for {@code 1}, {@code true}, {@code yes} (case-insensitive)
     */
    public static boolean isEnabled(String raw) {
        if (raw == null) {
            return false;
        }
        String trimmed = raw.trim();
        if (trimmed.isEmpty()) {
            return false;
        }
        return "1".equalsIgnoreCase(trimmed)
                || "true".equalsIgnoreCase(trimmed)
                || "yes".equalsIgnoreCase(trimmed);
    }

    private static String readEnv() {
        return PlatformUtils.getEnvIgnoreCase(ENV_ENABLED);
    }
}
