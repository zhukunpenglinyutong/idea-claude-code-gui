package com.github.claudecodegui.util;

import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.JsonObject;

import java.util.List;

/**
 * Utility class for token usage calculation across providers.
 * Centralizes provider-aware token extraction and usage JSON lookup
 * — used by MessageJsonConverter, SettingsHandler, and ClaudeSession.
 */
public final class TokenUsageUtils {

    private TokenUsageUtils() {
    } // utility class, no instances

    /**
     * Calculate total token usage for display in status bar.
     * Formula: input_tokens + cache_creation_input_tokens + cache_read_input_tokens + output_tokens
     * This matches CLI's status bar display which shows total tokens used (not just context window).
     */
    public static int calculateTotalTokens(int inputTokens, int cacheCreationTokens, int cacheReadTokens, int outputTokens) {
        return inputTokens + cacheCreationTokens + cacheReadTokens + outputTokens;
    }

    public static int extractContextTokens(JsonObject usage, String provider) {
        if (usage == null) {
            return 0;
        }
        int input = usage.has("input_tokens") ? usage.get("input_tokens").getAsInt() : 0;
        if ("codex".equals(provider) || "gemini".equals(provider)) {
            return input;
        }
        int cacheCreation = usage.has("cache_creation_input_tokens")
                ? usage.get("cache_creation_input_tokens").getAsInt() : 0;
        int cacheRead = usage.has("cache_read_input_tokens")
                ? usage.get("cache_read_input_tokens").getAsInt() : 0;
        return input + cacheCreation + cacheRead;
    }

    /**
     * Extract used token count from a usage JSON object, respecting provider differences.
     * - Claude: input + cache_creation + cache_read + output (total tokens, matches CLI status bar)
     * - Codex: input + output (input already includes cached tokens)
     */
    public static int extractUsedTokens(JsonObject usage, String provider) {
        if (usage == null) { return 0; }
        int input = usage.has("input_tokens") ? usage.get("input_tokens").getAsInt() : 0;
        int output = usage.has("output_tokens") ? usage.get("output_tokens").getAsInt() : 0;
        if ("codex".equals(provider)) {
            return input + output;
        }
        int cacheCreation = usage.has("cache_creation_input_tokens") ? usage.get("cache_creation_input_tokens").getAsInt() : 0;
        int cacheRead = usage.has("cache_read_input_tokens") ? usage.get("cache_read_input_tokens").getAsInt() : 0;
        return calculateTotalTokens(input, cacheCreation, cacheRead, output);
    }

    /**
     * Resolve the effective context window retained in provider usage metadata.
     * Providers that do not report a session-specific value keep the supplied
     * static model limit as a compatibility fallback.
     */
    public static int extractMaxTokens(JsonObject usage, int fallbackMaxTokens) {
        if (usage != null) {
            String[] keys = {"model_context_window", "maxTokens", "limit"};
            for (String key : keys) {
                if (!usage.has(key) || usage.get(key).isJsonNull()) {
                    continue;
                }
                try {
                    int value = usage.get(key).getAsInt();
                    if (value > 0) {
                        return value;
                    }
                } catch (RuntimeException ignored) {
                    // Ignore malformed provider metadata and retain the static fallback.
                }
            }
        }
        return Math.max(0, fallbackMaxTokens);
    }

    /**
     * Find the last usage JSON from a list of raw server messages (JsonObject).
     * Scans from end to find the last assistant message with usage data.
     */
    public static JsonObject findLastUsageFromRawMessages(List<JsonObject> messages) {
        return findLastUsageFromRawMessages(messages, null);
    }

    public static JsonObject findLastUsageFromRawMessages(List<JsonObject> messages, String provider) {
        boolean preferRootUsage = "codex".equals(provider);
        for (int i = messages.size() - 1; i >= 0; i--) {
            JsonObject msg = messages.get(i);
            if (!msg.has("type") || !"assistant".equals(msg.get("type").getAsString())) { continue; }
            JsonObject rootUsage = msg.has("usage") && msg.get("usage").isJsonObject()
                    ? msg.getAsJsonObject("usage") : null;
            if (preferRootUsage && rootUsage != null) {
                return rootUsage;
            }
            if (msg.has("message") && msg.get("message").isJsonObject()) {
                JsonObject message = msg.getAsJsonObject("message");
                if (message.has("usage") && message.get("usage").isJsonObject()) {
                    return message.getAsJsonObject("usage");
                }
            }
            if (rootUsage != null) {
                return rootUsage;
            }
        }
        return null;
    }

    /**
     * Find the last usage JSON from a list of parsed session messages.
     * Scans from end to find the last assistant message with usage data.
     */
    public static JsonObject findLastUsageFromSessionMessages(List<ClaudeSession.Message> messages) {
        return findLastUsageFromSessionMessages(messages, null);
    }

    public static JsonObject findLastUsageFromSessionMessages(
            List<ClaudeSession.Message> messages,
            String provider
    ) {
        boolean preferRootUsage = "codex".equals(provider);
        for (int i = messages.size() - 1; i >= 0; i--) {
            ClaudeSession.Message msg = messages.get(i);
            if (msg.type != ClaudeSession.Message.Type.ASSISTANT || msg.raw == null) { continue; }
            JsonObject rootUsage = msg.raw.has("usage") && msg.raw.get("usage").isJsonObject()
                    ? msg.raw.getAsJsonObject("usage") : null;
            if (preferRootUsage && rootUsage != null) {
                return rootUsage;
            }
            // Check usage inside message object
            if (msg.raw.has("message") && msg.raw.get("message").isJsonObject()) {
                JsonObject message = msg.raw.getAsJsonObject("message");
                if (message.has("usage") && message.get("usage").isJsonObject()) {
                    return message.getAsJsonObject("usage");
                }
            }
            if (rootUsage != null) {
                return rootUsage;
            }
        }
        return null;
    }

    /**
     * Remove provider/model-specific current-context snapshots from retained messages.
     * Historical per-turn accounting remains intact because turnUsage and turnCostUsd
     * are deliberately not touched.
     */
    public static void clearContextUsageFromSessionMessages(List<ClaudeSession.Message> messages) {
        if (messages == null) {
            return;
        }
        for (ClaudeSession.Message message : messages) {
            if (message == null || message.raw == null) {
                continue;
            }
            message.raw.remove("usage");
            if (message.raw.has("message") && message.raw.get("message").isJsonObject()) {
                message.raw.getAsJsonObject("message").remove("usage");
            }
        }
    }
}
