package com.github.claudecodegui.provider.codebuddy;

import com.github.claudecodegui.provider.common.MarkerCliBridge;
import com.google.gson.JsonObject;

import java.util.Collections;
import java.util.List;
import java.util.Map;

/** Bridge for the Tencent CodeBuddy Agent SDK channel. */
public class CodeBuddySDKBridge extends MarkerCliBridge {

    public CodeBuddySDKBridge() {
        super(CodeBuddySDKBridge.class);
    }

    @Override
    protected String getProviderName() {
        return "codebuddy";
    }

    @Override
    protected String getStdinEnvKey() {
        return "CODEBUDDY_USE_STDIN";
    }

    @Override
    protected void configureExtraEnv(Map<String, String> env) {
        // CodeBuddy reads its account/project settings from ~/.codebuddy.
    }

    @Override
    public List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            return new CodeBuddyHistoryReader().getSessionMessages(sessionId, cwd);
        } catch (Exception e) {
            LOG.warn("[CodeBuddy] Failed to load session history: " + sessionId, e);
            return Collections.emptyList();
        }
    }
}
