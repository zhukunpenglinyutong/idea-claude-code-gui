package com.github.claudecodegui.handler.provider;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.session.ClaudeSession;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

/** Handles the tightly bound PPCC final-diff approval response. */
public final class PpccApprovalHandler extends BaseMessageHandler {
    private static final Logger LOG = Logger.getInstance(PpccApprovalHandler.class);
    private static final String[] SUPPORTED_TYPES = {"ppcc_approval_response"};
    private final Gson gson = new Gson();

    public PpccApprovalHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES.clone();
    }

    @Override
    public boolean handle(String type, String content) {
        if (!"ppcc_approval_response".equals(type)) {
            return false;
        }
        try {
            JsonObject payload = gson.fromJson(content, JsonObject.class);
            String runId = required(payload, "runId");
            String approvalId = required(payload, "approvalId");
            String diffSha256 = required(payload, "diffSha256");
            if (!payload.has("approved") || !payload.get("approved").isJsonPrimitive()
                    || !payload.get("approved").getAsJsonPrimitive().isBoolean()) {
                throw new IllegalArgumentException("approved must be boolean");
            }
            boolean approved = payload.get("approved").getAsBoolean();
            ClaudeSession session = context.getSession();
            if (session == null || !"ppcc".equals(session.getProvider())) {
                throw new IllegalStateException("PPCC session is not active");
            }
            session.respondPpccApproval(runId, approvalId, diffSha256, approved)
                    .exceptionally(error -> {
                        LOG.warn("PPCC approval response failed: " + error.getMessage());
                        return false;
                    });
        } catch (Exception error) {
            LOG.warn("Rejected invalid PPCC approval response: " + error.getMessage());
        }
        return true;
    }

    private String required(JsonObject payload, String name) {
        if (payload == null || !payload.has(name) || !payload.get(name).isJsonPrimitive()) {
            throw new IllegalArgumentException(name + " is required");
        }
        String value = payload.get(name).getAsString();
        if (value.isBlank() || value.length() > 256) {
            throw new IllegalArgumentException(name + " is invalid");
        }
        return value;
    }
}
