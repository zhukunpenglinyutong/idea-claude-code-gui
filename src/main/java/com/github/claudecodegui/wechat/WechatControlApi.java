package com.github.claudecodegui.wechat;

import com.google.gson.JsonObject;

/** Sanitized control API surface consumed by the connection service. */
public interface WechatControlApi {
    JsonObject status() throws WechatControlException;

    JsonObject loginStart() throws WechatControlException;

    JsonObject loginStatus(String loginId) throws WechatControlException;

    byte[] loginQr(String loginId) throws WechatControlException;

    boolean loginVerify(String loginId, String code) throws WechatControlException;

    boolean loginCancel(String loginId) throws WechatControlException;

    void bind(String projectId, String tabId) throws WechatControlException;

    void unbind() throws WechatControlException;

    void logout() throws WechatControlException;
}
