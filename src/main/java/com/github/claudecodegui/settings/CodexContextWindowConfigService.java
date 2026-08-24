package com.github.claudecodegui.settings;

import com.google.gson.Gson;
import com.intellij.openapi.diagnostic.Logger;
import org.jetbrains.annotations.TestOnly;

import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Codex 全局上下文窗口配置服务。
 *
 * <p>所有 CC GUI 窗口共享同一个实例。服务串行化 {@code config.toml} 更新，并在
 * 成功写入后把重新读取的权威配置广播给每个已注册窗口。</p>
 */
public final class CodexContextWindowConfigService {

    private static final Logger LOG = Logger.getInstance(CodexContextWindowConfigService.class);
    private static volatile CodexContextWindowConfigService instance;

    private final CodexSettingsManager settingsManager;
    private final Object writeLock = new Object();
    private final CopyOnWriteArraySet<RegisteredCallback> callbacks = new CopyOnWriteArraySet<>();
    private final AtomicLong callbackIdSequence = new AtomicLong();

    private CodexContextWindowConfigService(CodexSettingsManager settingsManager) {
        this.settingsManager = settingsManager;
    }

    public static CodexContextWindowConfigService getInstance() {
        CodexContextWindowConfigService local = instance;
        if (local == null) {
            synchronized (CodexContextWindowConfigService.class) {
                local = instance;
                if (local == null) {
                    local = new CodexContextWindowConfigService(new CodexSettingsManager(new Gson()));
                    instance = local;
                }
            }
        }
        return local;
    }

    @TestOnly
    static CodexContextWindowConfigService createForTests(CodexSettingsManager settingsManager) {
        return new CodexContextWindowConfigService(settingsManager);
    }

    /**
     * 读取当前全局配置。
     *
     * @return 成功时包含权威快照；失败时包含错误信息
     */
    public OperationResult readCurrent() {
        try {
            return OperationResult.success(settingsManager.readContextWindowConfig());
        } catch (Exception e) {
            LOG.warn("[CodexContextWindow] Failed to read config: " + e.getMessage(), e);
            return OperationResult.failure(null, e.getMessage());
        }
    }

    /**
     * 更新全局预设并广播最终配置。
     *
     * @param preset default、500k 或 1m
     * @return 更新结果
     */
    public OperationResult updatePreset(String preset) {
        synchronized (writeLock) {
            if (preset == null || preset.isBlank()) {
                OperationResult current = readCurrent();
                return OperationResult.failure(current.getConfig(), "Missing Codex context window preset");
            }
            try {
                CodexSettingsManager.CodexContextWindowConfig config =
                        settingsManager.updateContextWindowPreset(preset);
                notifyCallbacks(config);
                return OperationResult.success(config);
            } catch (Exception e) {
                LOG.warn("[CodexContextWindow] Failed to update preset: " + preset, e);
                OperationResult current = readCurrent();
                return OperationResult.failure(current.getConfig(), e.getMessage());
            }
        }
    }

    /**
     * 注册窗口配置回调。
     *
     * @param callback 配置成功变化时调用
     * @return 用于注销的句柄
     */
    public RegisteredCallback registerCallback(ConfigChangedCallback callback) {
        if (callback == null) {
            return null;
        }
        RegisteredCallback handle = new RegisteredCallback(
                callbackIdSequence.incrementAndGet(),
                callback
        );
        callbacks.add(handle);
        return handle;
    }

    /**
     * 注销窗口配置回调，防止向已销毁 WebView 推送消息。
     *
     * @param handle 注册时返回的句柄
     */
    public void unregisterCallback(RegisteredCallback handle) {
        if (handle != null) {
            callbacks.remove(handle);
        }
    }

    private void notifyCallbacks(CodexSettingsManager.CodexContextWindowConfig config) {
        for (RegisteredCallback callback : callbacks) {
            try {
                callback.callback.onConfigChanged(config);
            } catch (Exception e) {
                LOG.warn("[CodexContextWindow] Failed to notify callback id=" + callback.id, e);
            }
        }
    }

    public interface ConfigChangedCallback {
        void onConfigChanged(CodexSettingsManager.CodexContextWindowConfig config);
    }

    /**
     * 不透明的窗口回调句柄。
     */
    public static final class RegisteredCallback {
        private final long id;
        private final ConfigChangedCallback callback;

        private RegisteredCallback(long id, ConfigChangedCallback callback) {
            this.id = id;
            this.callback = callback;
        }
    }

    /**
     * 配置读写结果。
     */
    public static final class OperationResult {
        private final boolean success;
        private final CodexSettingsManager.CodexContextWindowConfig config;
        private final String error;

        private OperationResult(
                boolean success,
                CodexSettingsManager.CodexContextWindowConfig config,
                String error
        ) {
            this.success = success;
            this.config = config;
            this.error = error;
        }

        static OperationResult success(CodexSettingsManager.CodexContextWindowConfig config) {
            return new OperationResult(true, config, null);
        }

        static OperationResult failure(
                CodexSettingsManager.CodexContextWindowConfig config,
                String error
        ) {
            String message = error == null || error.isBlank() ? "Unknown configuration error" : error;
            return new OperationResult(false, config, message);
        }

        public boolean isSuccess() {
            return success;
        }

        public CodexSettingsManager.CodexContextWindowConfig getConfig() {
            return config;
        }

        public String getError() {
            return error;
        }
    }
}
