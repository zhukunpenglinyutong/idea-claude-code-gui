package com.github.claudecodegui.wechat;

public class WechatControlException extends Exception {
    private final int status;
    private final String code;

    public WechatControlException(int status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    public int status() {
        return status;
    }

    public String code() {
        return code;
    }
}
