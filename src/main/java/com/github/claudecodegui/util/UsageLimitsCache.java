package com.github.claudecodegui.util;

import com.intellij.ide.util.PropertiesComponent;

/**
 * Application-level persistent cache for Claude / Codex usage-limit data.
 * Backed by {@link PropertiesComponent} so data survives daemon and plugin restarts.
 */
public final class UsageLimitsCache {

    public static final long TTL_MS = 5 * 60 * 1_000L; // 5 minutes

    private static final String KEY_CLAUDE_DATA = "cc-gui.limits.claude.data";
    private static final String KEY_CLAUDE_TS   = "cc-gui.limits.claude.ts";
    private static final String KEY_CODEX_DATA  = "cc-gui.limits.codex.data";
    private static final String KEY_CODEX_TS    = "cc-gui.limits.codex.ts";

    private UsageLimitsCache() {}

    /**
     * Persist a limits JSON payload. Provider is detected from the "provider" field.
     */
    public static void save(String json) {
        if (json == null || json.isEmpty()) {
            return;
        }
        PropertiesComponent p = PropertiesComponent.getInstance();
        String ts = String.valueOf(System.currentTimeMillis());
        if (json.contains("\"provider\":\"claude\"")) {
            p.setValue(KEY_CLAUDE_DATA, json);
            p.setValue(KEY_CLAUDE_TS, ts);
        } else if (json.contains("\"provider\":\"codex\"")) {
            p.setValue(KEY_CODEX_DATA, json);
            p.setValue(KEY_CODEX_TS, ts);
        }
    }

    /** Clear all stored cache entries (e.g. after a data format change). */
    public static void clearAll() {
        PropertiesComponent p = PropertiesComponent.getInstance();
        p.unsetValue(KEY_CLAUDE_DATA);
        p.unsetValue(KEY_CLAUDE_TS);
        p.unsetValue(KEY_CODEX_DATA);
        p.unsetValue(KEY_CODEX_TS);
    }

    /** Last cached Claude limits JSON, or {@code null} if never stored. */
    public static String loadClaude() {
        return PropertiesComponent.getInstance().getValue(KEY_CLAUDE_DATA);
    }

    /** Last cached Codex limits JSON, or {@code null} if never stored. */
    public static String loadCodex() {
        return PropertiesComponent.getInstance().getValue(KEY_CODEX_DATA);
    }

    /** Returns {@code true} if Claude data is absent or older than {@link #TTL_MS}. */
    public static boolean isClaudeStale() {
        return isStale(KEY_CLAUDE_TS);
    }

    /** Returns {@code true} if Codex data is absent or older than {@link #TTL_MS}. */
    public static boolean isCodexStale() {
        return isStale(KEY_CODEX_TS);
    }

    private static boolean isStale(String tsKey) {
        String v = PropertiesComponent.getInstance().getValue(tsKey);
        if (v == null) {
            return true;
        }
        try {
            return System.currentTimeMillis() - Long.parseLong(v) >= TTL_MS;
        } catch (NumberFormatException ignored) {
            return true;
        }
    }
}
