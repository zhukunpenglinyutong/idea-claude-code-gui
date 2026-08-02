package com.github.claudecodegui.wechat;

import java.util.concurrent.CompletableFuture;

/** Process-level view consumed by {@link WechatConnectionService}. */
public interface WechatProcessApi {
    AdapterProcessService.State state();

    String lastError();

    String controlBaseUrl();

    String controlToken();

    CompletableFuture<AdapterProcessService.State> start();

    CompletableFuture<Void> stop();
}
