package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.wechat.WechatConnectionService;
import com.github.claudecodegui.wechat.WechatWindowHandle;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * Webview bridge for the WeChat connection feature (M9 §13).
 *
 * The webview sends intents only; target identity is resolved from the owning
 * {@link WechatWindowHandle}.
 */
public class WechatHandler extends BaseMessageHandler {
    private static final String[] SUPPORTED_TYPES = {
            "wechat_status",
            "wechat_connect",
            "wechat_retry",
            "wechat_login_start",
            "wechat_login_refresh",
            "wechat_login_cancel",
            "wechat_login_verify",
            "wechat_bind_current",
            "wechat_unbind",
            "wechat_logout",
    };

    private final WechatWindowHandle handle;
    private final WechatConnectionService service;

    public WechatHandler(HandlerContext context, WechatWindowHandle handle) {
        super(context);
        this.handle = handle;
        this.service = WechatConnectionService.getInstance();
        service.registerWindow(handle);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "wechat_status":
                service.pushToWindow(handle);
                return true;
            case "wechat_connect":
                service.connect();
                return true;
            case "wechat_retry":
                service.retry();
                return true;
            case "wechat_login_start":
                service.loginStart(handle);
                return true;
            case "wechat_login_refresh":
                service.loginRefresh(handle);
                return true;
            case "wechat_login_cancel": {
                String loginId = readString(content, "loginId");
                if (loginId != null) {
                    service.loginCancel(loginId);
                }
                return true;
            }
            case "wechat_login_verify": {
                String loginId = readString(content, "loginId");
                String code = readString(content, "code");
                if (loginId != null && code != null) {
                    service.loginVerify(loginId, code);
                }
                return true;
            }
            case "wechat_bind_current":
                service.bindCurrent(handle);
                return true;
            case "wechat_unbind":
                service.unbind();
                return true;
            case "wechat_logout":
                service.logout();
                return true;
            default:
                return false;
        }
    }

    private static String readString(String content, String field) {
        if (content == null || content.isEmpty()) {
            return null;
        }
        try {
            JsonObject parsed = JsonParser.parseString(content).getAsJsonObject();
            return parsed.has(field) ? parsed.get(field).getAsString() : null;
        } catch (RuntimeException ignored) {
            return null;
        }
    }
}
