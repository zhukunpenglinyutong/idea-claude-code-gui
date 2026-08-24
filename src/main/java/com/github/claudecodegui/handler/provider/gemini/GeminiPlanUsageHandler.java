package com.github.claudecodegui.handler.provider.gemini;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.provider.gemini.GeminiPlanUsageService;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;

public class GeminiPlanUsageHandler extends BaseMessageHandler {

    private static final String[] SUPPORTED_TYPES = {
            "get_gemini_plan_usage"
    };

    public GeminiPlanUsageHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if ("get_gemini_plan_usage".equals(type)) {
            ApplicationManager.getApplication().executeOnPooledThread(() -> {
                try {
                    JsonObject usage = GeminiPlanUsageService.resolvePlanUsagePayload();
                    if (usage != null) {
                        context.callJavaScript("window.updateGeminiPlanUsage", context.escapeJs(usage.toString()));
                    } else {
                        // Send empty/error state
                        JsonObject error = new JsonObject();
                        error.addProperty("error", true);
                        context.callJavaScript("window.updateGeminiPlanUsage", context.escapeJs(error.toString()));
                    }
                } catch (Exception e) {
                    JsonObject error = new JsonObject();
                    error.addProperty("error", true);
                    error.addProperty("message", e.getMessage());
                    context.callJavaScript("window.updateGeminiPlanUsage", context.escapeJs(error.toString()));
                }
            });
            return true;
        }
        return false;
    }
}
