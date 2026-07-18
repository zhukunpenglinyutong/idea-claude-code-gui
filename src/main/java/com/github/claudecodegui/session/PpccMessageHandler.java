package com.github.claudecodegui.session;

import com.github.claudecodegui.provider.common.MessageCallback;
import com.github.claudecodegui.provider.common.SDKResult;
import com.google.gson.JsonObject;

/** Maps PPCC structured events onto the existing chat callbacks. */
public final class PpccMessageHandler implements MessageCallback {
    private final SessionState state;
    private final CallbackHandler callbacks;
    private final StringBuilder assistantContent = new StringBuilder();

    public PpccMessageHandler(SessionState state, CallbackHandler callbacks) {
        this.state = state;
        this.callbacks = callbacks;
    }

    @Override
    public void onMessage(String type, String content) {
        if ("stream_start".equals(type)) {
            callbacks.notifyStreamStart();
        } else if ("stream_end".equals(type)) {
            callbacks.notifyStreamEnd();
        } else if ("content".equals(type)) {
            assistantContent.append(content != null ? content : "");
            callbacks.notifyContentDelta(content != null ? content : "");
        } else if ("ppcc_event".equals(type)) {
            callbacks.notifyStatusMessage(statusFromEvent(content));
        } else if ("ppcc_approval_required".equals(type)) {
            callbacks.notifyPpccApprovalRequired(content);
        }
    }

    @Override
    public void onError(String error) {
        state.setError(error);
        state.setBusy(false);
        state.setLoading(false);
        state.addMessage(new ClaudeSession.Message(ClaudeSession.Message.Type.ERROR, error));
        callbacks.notifyStreamEnd();
        callbacks.notifyMessageUpdate(state.getMessages());
        callbacks.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    @Override
    public void onComplete(SDKResult result) {
        if (assistantContent.length() > 0) {
            state.addMessage(new ClaudeSession.Message(
                    ClaudeSession.Message.Type.ASSISTANT,
                    assistantContent.toString()
            ));
        }
        state.setBusy(false);
        state.setLoading(false);
        state.updateLastModifiedTime();
        callbacks.notifyMessageUpdate(state.getMessages());
        callbacks.notifyStreamEnd();
        callbacks.notifyStateChange(state.isBusy(), state.isLoading(), state.getError());
    }

    private String statusFromEvent(String content) {
        try {
            JsonObject event = new com.google.gson.Gson().fromJson(content, JsonObject.class);
            return event != null && event.has("type")
                    ? "PPCC: " + event.get("type").getAsString()
                    : "PPCC is working";
        } catch (Exception ignored) {
            return "PPCC is working";
        }
    }
}
