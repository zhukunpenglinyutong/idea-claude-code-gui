package com.github.claudecodegui.provider.mimo;

import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.google.gson.JsonObject;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * MiMo Code CLI bridge (Xiaomi's terminal AI coding agent, an OpenCode fork).
 *
 * <p>No official SDK — spawns local {@code mimo} (mimocode) via channel-manager
 * and maps its stream-json output onto the shared marker protocol.
 */
public class MimoCliBridge extends MarkerCliBridge {

    public MimoCliBridge() {
        super(MimoCliBridge.class);
    }

    @Override
    protected String getProviderName() {
        return "mimo";
    }

    @Override
    protected String getStdinEnvKey() {
        return "MIMO_USE_STDIN";
    }

    @Override
    protected void configureExtraEnv(Map<String, String> env) {
        // Reserved for future MiMo-specific env (e.g. MIMOCODE_HOME).
    }

    @Override
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            return new MimoHistoryReader().getSessionMessages(sessionId, cwd);
        } catch (Exception e) {
            LOG.warn("[MiMo] Failed to load session messages: " + e.getMessage());
            return Collections.emptyList();
        }
    }
}
