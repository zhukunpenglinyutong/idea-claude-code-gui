package com.github.claudecodegui.wechat;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.github.claudecodegui.util.JsUtils;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.diagnostic.Logger;
import org.jetbrains.annotations.NotNull;

import java.time.Duration;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Function;

/**
 * APP-level sanitized view + UI bridge for the WeChat feature (M9 §12).
 *
 * Adapter remains the authoritative owner of login/credentials/binding. This
 * service only caches a sanitized status, computes the per-tab binding view
 * and pushes display state to each registered window.
 */
@Service(Service.Level.APP)
public final class WechatConnectionService implements Disposable {
    private static final Logger LOG = Logger.getInstance(WechatConnectionService.class);

    private final WechatProcessApi processApi;
    private final Function<WechatProcessApi, WechatControlApi> controlFactory;
    private final boolean autoSchedule;
    private final Map<WechatWindowHandle, Long> windows = new ConcurrentHashMap<>();
    private final ScheduledThreadPoolExecutor scheduler = new ScheduledThreadPoolExecutor(1, r -> {
        Thread t = new Thread(r, "ccgui-wechat-status");
        t.setDaemon(true);
        return t;
    });

    private volatile WechatControlApi control;
    private volatile JsonObject lastStatus;
    private volatile String lastNodeError;
    private volatile WechatWindowHandle pendingTarget;
    private volatile String qrLoginId;
    private volatile String qrUrl;
    private volatile String qrDataUri;
    private long backoffMs = 1_000;
    private final Consumer<AdapterProcessService.State> processStateListener;
    private final AtomicBoolean disposed = new AtomicBoolean(false);

    public WechatConnectionService() {
        this(AdapterProcessService.getInstance(),
                process -> new WechatControlClient(process.controlBaseUrl(), process.controlToken(),
                        Duration.ofSeconds(5)),
                true);
    }

    WechatConnectionService(WechatProcessApi processApi,
                            Function<WechatProcessApi, WechatControlApi> controlFactory) {
        this(processApi, controlFactory, true);
    }

    WechatConnectionService(WechatProcessApi processApi,
                            Function<WechatProcessApi, WechatControlApi> controlFactory,
                            boolean autoSchedule) {
        this.processApi = processApi;
        this.controlFactory = controlFactory;
        this.autoSchedule = autoSchedule;
        this.processStateListener = state -> schedule(0);
        if (processApi instanceof AdapterProcessService adapter) {
            adapter.addListener(processStateListener);
        }
        if (autoSchedule) {
            schedule(0);
        }
    }

    public static WechatConnectionService getInstance() {
        return ApplicationManager.getApplication().getService(WechatConnectionService.class);
    }

    public void registerWindow(@NotNull WechatWindowHandle handle) {
        windows.put(handle, System.currentTimeMillis());
        if (autoSchedule) {
            schedule(0);
        }
    }

    public void unregisterWindow(@NotNull WechatWindowHandle handle) {
        windows.remove(handle);
        if (pendingTarget == handle) {
            pendingTarget = null;
        }
    }

    /** Ensures the Adapter process is running, then pushes a fresh status. */
    public void connect() {
        processApi.start().thenRun(() -> schedule(0));
    }

    public void retry() {
        if (processApi instanceof AdapterProcessService adapter) {
            adapter.retry();
        }
        schedule(0);
    }

    public void loginStart(@NotNull WechatWindowHandle source) {
        ensureControl();
        if (control == null) {
            return;
        }
        if (pendingTarget == null || pendingTarget.isDisposed()) {
            pendingTarget = source;
        }
        try {
            control.loginStart();
        } catch (WechatControlException err) {
            LOG.warn("loginStart failed: " + err.getMessage());
        }
        schedule(0);
    }

    public void loginRefresh(@NotNull WechatWindowHandle source) {
        JsonObject login = loginView();
        if (login != null && login.has("loginId")) {
            try {
                control.loginCancel(login.get("loginId").getAsString());
            } catch (WechatControlException ignored) {
                // Start a fresh login below.
            }
        }
        loginStart(source);
    }

    public void loginCancel(String loginId) {
        if (control == null) {
            return;
        }
        try {
            control.loginCancel(loginId);
        } catch (WechatControlException err) {
            LOG.warn("loginCancel failed: " + err.getMessage());
        }
        schedule(0);
    }

    public void loginVerify(String loginId, String code) {
        if (control == null) {
            return;
        }
        try {
            control.loginVerify(loginId, code);
        } catch (WechatControlException err) {
            LOG.warn("loginVerify failed: " + err.getMessage());
        }
        schedule(0);
    }

    public void bindCurrent(@NotNull WechatWindowHandle handle) {
        ensureControl();
        if (control == null) {
            return;
        }
        try {
            control.bind(handle.projectId(), handle.tabId());
        } catch (WechatControlException err) {
            LOG.warn("bind failed: " + err.getMessage());
        }
        schedule(0);
    }

    public void unbind() {
        if (control == null) {
            return;
        }
        try {
            control.unbind();
        } catch (WechatControlException err) {
            LOG.warn("unbind failed: " + err.getMessage());
        }
        schedule(0);
    }

    public void logout() {
        if (control == null) {
            return;
        }
        try {
            control.logout();
        } catch (WechatControlException err) {
            LOG.warn("logout failed: " + err.getMessage());
        }
        pendingTarget = null;
        schedule(0);
    }

    /** Pushes the current sanitized per-tab view to a single window. */
    public void pushToWindow(@NotNull WechatWindowHandle handle) {
        JsonObject view = buildWindowView(handle);
        handle.callJavaScript("onWechatStatus", JsUtils.escapeJs(view.toString()));
    }

    private void schedule(long delayMs) {
        if (disposed.get()) {
            return;
        }
        try {
            scheduler.schedule(this::tick, delayMs, TimeUnit.MILLISECONDS);
        } catch (RejectedExecutionException ignored) {
            // dispose() can race an in-flight state callback; after dispose no
            // new polls are scheduled.
        }
    }

    private void tick() {
        long nextDelay = tickBody();
        schedule(nextDelay);
    }

    long tickBody() {
        try {
            if (control == null) {
                ensureControl();
            }
            long nextDelay;
            if (control == null) {
                lastNodeError = processApi.lastError();
                if (lastNodeError != null) {
                    LOG.info("[wechat] pushing node error to windows: " + lastNodeError);
                }
                nextDelay = backoff();
                pushToAll();
                return nextDelay;
            } else {
                backoffMs = 1_000;
                try {
                    lastStatus = control.status();
                    lastNodeError = null;
                    refreshQrCache();
                } catch (WechatControlException err) {
                    lastStatus = null;
                    LOG.info("control status failed: " + err.getMessage());
                    control = null;
                    nextDelay = backoff();
                    pushToAll();
                    return nextDelay;
                }
                handlePendingTarget();
                pushToAll();
                return loginActive() ? 1_000 : 10_000;
            }
        } catch (RuntimeException err) {
            LOG.warn("wechat tick failed: " + err.getMessage());
            return backoff();
        }
    }

    /** Test seam: runs one poll without rescheduling. */
    void tickOnceForTest() {
        tickBody();
    }

    private void ensureControl() {
        if (control == null && processApi.state() == AdapterProcessService.State.RUNNING
                && processApi.controlBaseUrl() != null && processApi.controlToken() != null) {
            control = controlFactory.apply(processApi);
        }
    }

    private void handlePendingTarget() {
        WechatWindowHandle target = pendingTarget;
        if (target == null || lastStatus == null) {
            return;
        }
        JsonObject login = loginView();
        if (login == null || !"CONFIRMED".equals(login.get("status").getAsString())) {
            return;
        }
        pendingTarget = null;
        if (target.isDisposed()) {
            // Login succeeded but the originating tab is gone -> CONNECTED_UNBOUND.
            pushToAll();
            return;
        }
        try {
            control.bind(target.projectId(), target.tabId());
        } catch (WechatControlException err) {
            LOG.warn("auto bind after login failed: " + err.getMessage());
        }
        pushToAll();
    }

    private JsonObject loginView() {
        if (lastStatus == null || !lastStatus.has("login") || lastStatus.get("login").isJsonNull()) {
            return null;
        }
        return lastStatus.getAsJsonObject("login");
    }

    private boolean loginActive() {
        JsonObject login = loginView();
        if (login == null) {
            return false;
        }
        String status = login.has("status") ? login.get("status").getAsString() : "";
        return "QR_PENDING".equals(status) || "SCANNED".equals(status)
                || "VERIFY_CODE_REQUIRED".equals(status);
    }

    private void refreshQrCache() {
        JsonObject login = loginView();
        String activeId = login != null && login.has("loginId") ? login.get("loginId").getAsString() : null;
        if (activeId == null) {
            qrLoginId = null;
            qrUrl = null;
            qrDataUri = null;
            return;
        }
        String currentQrUrl = login.has("qrUrl") && !login.get("qrUrl").isJsonNull()
                ? login.get("qrUrl").getAsString() : "";
        if (activeId.equals(qrLoginId) && currentQrUrl.equals(qrUrl) && qrDataUri != null) {
            // Same login session and same QR content: keep the cached image.
            // The adapter may auto-refresh the QR inside one login session
            // (same loginId, new qrUrl); the URL comparison catches that and
            // forces a refetch, so the UI never shows a stale QR (E2E-P1-002).
            return;
        }
        try {
            byte[] png = control.loginQr(activeId);
            qrDataUri = "data:image/png;base64," + Base64.getEncoder().encodeToString(png);
            qrLoginId = activeId;
            qrUrl = currentQrUrl;
        } catch (WechatControlException err) {
            qrLoginId = null;
            qrUrl = null;
            qrDataUri = null;
            LOG.info("QR fetch failed: " + err.getMessage());
        }
    }

    private long backoff() {
        long next = backoffMs;
        backoffMs = Math.min(30_000, backoffMs * 2);
        return next;
    }

    private void pushToAll() {
        windows.entrySet().removeIf(entry -> entry.getKey().isDisposed());
        for (WechatWindowHandle handle : windows.keySet()) {
            pushToWindow(handle);
        }
    }

    JsonObject buildWindowView(WechatWindowHandle handle) {
        JsonObject view = new JsonObject();
        view.addProperty("processState", processApi.state().name());
        view.addProperty("tabId", handle.tabId());
        if (lastStatus == null) {
            view.addProperty("authState", "UNKNOWN");
            view.addProperty("uiState", processApi.state() == AdapterProcessService.State.RUNNING
                    ? "ADAPTER_OFFLINE" : "ADAPTER_OFFLINE");
            if (lastNodeError != null) {
                view.addProperty("error", lastNodeError);
            }
            return view;
        }
        String authState = lastStatus.has("authState") ? lastStatus.get("authState").getAsString() : "UNKNOWN";
        view.addProperty("authState", authState);
        view.addProperty("transportRunning",
                lastStatus.has("transportRunning") && lastStatus.get("transportRunning").getAsBoolean());
        JsonElement loginElement = lastStatus.get("login");
        if (loginElement != null && !loginElement.isJsonNull()) {
            JsonObject loginCopy = loginElement.deepCopy().getAsJsonObject();
            if (qrDataUri != null && loginCopy.has("loginId")
                    && loginCopy.get("loginId").getAsString().equals(qrLoginId)) {
                loginCopy.addProperty("qrDataUri", qrDataUri);
            }
            view.add("login", loginCopy);
        }
        String uiState = resolveUiState(authState, handle);
        view.addProperty("uiState", uiState);
        if (lastNodeError != null) {
            view.addProperty("error", lastNodeError);
        }
        return view;
    }

    private String resolveUiState(String authState, WechatWindowHandle handle) {
        if (processApi.state() != AdapterProcessService.State.RUNNING) {
            return "ADAPTER_OFFLINE";
        }
        if ("REAUTH_REQUIRED".equals(authState)) {
            return "REAUTH_REQUIRED";
        }
        if ("UNCONFIGURED".equals(authState)) {
            return "LOGGED_OUT";
        }
        JsonObject login = loginView();
        if (login != null) {
            String status = login.has("status") ? login.get("status").getAsString() : "";
            if ("QR_PENDING".equals(status)) {
                return "QR_PENDING";
            }
            if ("SCANNED".equals(status)) {
                return "SCANNED";
            }
            if ("VERIFY_CODE_REQUIRED".equals(status)) {
                return "VERIFY_CODE_REQUIRED";
            }
            if ("EXPIRED".equals(status)) {
                return "QR_PENDING";
            }
        }
        if (lastStatus == null || !lastStatus.has("binding") || lastStatus.get("binding").isJsonNull()) {
            return "CONNECTED_UNBOUND";
        }
        JsonObject binding = lastStatus.getAsJsonObject("binding");
        String state = binding.has("state") ? binding.get("state").getAsString() : "UNBOUND";
        if ("BOUND".equals(state)) {
            if (binding.has("target") && !binding.get("target").isJsonNull()) {
                JsonObject target = binding.getAsJsonObject("target");
                String boundTab = target.has("tabId") ? target.get("tabId").getAsString() : "";
                return boundTab.equals(handle.tabId()) ? "BOUND_CURRENT_TAB" : "BOUND_OTHER_TAB";
            }
            return "BOUND_OTHER_TAB";
        }
        if ("INVALID".equals(state)) {
            return "TARGET_INVALID";
        }
        return "CONNECTED_UNBOUND";
    }

    @Override
    public void dispose() {
        if (!disposed.compareAndSet(false, true)) {
            return;
        }
        if (processApi instanceof AdapterProcessService adapter) {
            adapter.removeListener(processStateListener);
        }
        windows.clear();
        pendingTarget = null;
        scheduler.shutdownNow();
    }

    /** Test seam: number of pending scheduler tasks. */
    int pendingTaskCountForTest() {
        return scheduler.getQueue().size();
    }

    /** Test seam: whether this service has been disposed. */
    boolean isDisposedForTest() {
        return disposed.get();
    }

    /** Test seam: schedules through the guarded production path. */
    void scheduleForTest(long delayMs) {
        schedule(delayMs);
    }

    /** Test seam: the exact listener instance registered on the adapter. */
    Consumer<AdapterProcessService.State> processStateListenerForTest() {
        return processStateListener;
    }
}
