package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.claude.ClaudeSDKBridge;
import com.github.claudecodegui.provider.codex.CodexSDKBridge;
import com.github.claudecodegui.provider.grok.GrokSDKBridge;
import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.google.gson.JsonObject;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Centralizes provider-specific bridge routing for session operations.
 */
public class SessionProviderRouter {

    /**
     * Canonical ids of the built-in CLI providers routed through
     * {@link MarkerCliBridge} — the keys of the map built by
     * {@link #registerCliBridges(MarkerCliBridge...)} for the bundled bridges.
     */
    private static final Set<String> CLI_PROVIDER_IDS = Set.of("kimi", "opencode", "pi", "omp", "dsh", "codebuddy", "minimax");

    /**
     * Whether {@code provider} is a headless CLI provider routed through the
     * CLI bridge map. Use this instead of repeating provider-id literals.
     */
    public static boolean isCliProvider(String provider) {
        return provider != null && CLI_PROVIDER_IDS.contains(provider);
    }

    private final ClaudeSDKBridge claudeSDKBridge;
    private final CodexSDKBridge codexSDKBridge;
    private final GrokSDKBridge grokSDKBridge;
    private final Map<String, MarkerCliBridge> cliBridges;

    public SessionProviderRouter(
            ClaudeSDKBridge claudeSDKBridge,
            CodexSDKBridge codexSDKBridge,
            Map<String, MarkerCliBridge> cliBridges
    ) {
        this(claudeSDKBridge, codexSDKBridge, cliBridges, null);
    }

    public SessionProviderRouter(
            ClaudeSDKBridge claudeSDKBridge,
            CodexSDKBridge codexSDKBridge,
            Map<String, MarkerCliBridge> cliBridges,
            GrokSDKBridge grokSDKBridge
    ) {
        this.claudeSDKBridge = claudeSDKBridge;
        this.codexSDKBridge = codexSDKBridge;
        this.grokSDKBridge = grokSDKBridge;
        this.cliBridges = cliBridges != null
                ? Collections.unmodifiableMap(new LinkedHashMap<>(cliBridges))
                : Collections.emptyMap();
    }

    public static Map<String, MarkerCliBridge> registerCliBridges(MarkerCliBridge... bridges) {
        Map<String, MarkerCliBridge> map = new LinkedHashMap<>();
        if (bridges == null) {
            return map;
        }
        for (MarkerCliBridge bridge : bridges) {
            if (bridge != null) {
                map.put(bridge.providerId(), bridge);
            }
        }
        return map;
    }

    private MarkerCliBridge cli(String provider) {
        return provider != null ? cliBridges.get(provider) : null;
    }

    public JsonObject launchChannel(String provider, String channelId, String sessionId, String cwd) {
        if ("codex".equals(provider)) {
            return codexSDKBridge.launchChannel(channelId, sessionId, cwd);
        }
        if ("grok".equals(provider) && grokSDKBridge != null) {
            return grokSDKBridge.launchChannel(channelId, sessionId, cwd);
        }
        MarkerCliBridge bridge = cli(provider);
        if (bridge != null) {
            return bridge.launchChannel(channelId, sessionId, cwd);
        }
        return claudeSDKBridge.launchChannel(channelId, sessionId, cwd);
    }

    public void interruptChannel(String provider, String channelId) {
        if ("codex".equals(provider)) {
            codexSDKBridge.interruptChannel(channelId);
            return;
        }
        if ("grok".equals(provider) && grokSDKBridge != null) {
            grokSDKBridge.interruptChannel(channelId);
            return;
        }
        MarkerCliBridge bridge = cli(provider);
        if (bridge != null) {
            bridge.interruptChannel(channelId);
            return;
        }
        claudeSDKBridge.interruptChannel(channelId);
    }

    public List<JsonObject> getSessionMessages(String provider, String sessionId, String cwd) {
        if ("codex".equals(provider)) {
            return codexSDKBridge.getSessionMessages(sessionId, cwd);
        }
        if ("grok".equals(provider) && grokSDKBridge != null) {
            return grokSDKBridge.getSessionMessages(sessionId, cwd);
        }
        MarkerCliBridge bridge = cli(provider);
        if (bridge != null) {
            return bridge.getSessionMessages(sessionId, cwd);
        }
        return claudeSDKBridge.getSessionMessages(sessionId, cwd);
    }

    public Map<String, MarkerCliBridge> getCliBridges() {
        return cliBridges;
    }

    public GrokSDKBridge getGrokSDKBridge() {
        return grokSDKBridge;
    }
}
