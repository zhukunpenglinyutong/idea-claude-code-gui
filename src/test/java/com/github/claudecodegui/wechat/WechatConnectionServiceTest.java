package com.github.claudecodegui.wechat;

import com.google.gson.JsonObject;
import com.github.claudecodegui.util.JsUtils;
import org.junit.Test;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

public class WechatConnectionServiceTest {

    private static final class FakeProcessApi implements WechatProcessApi {
        AdapterProcessService.State state = AdapterProcessService.State.RUNNING;
        String error;

        @Override
        public AdapterProcessService.State state() {
            return state;
        }

        @Override
        public String lastError() {
            return error;
        }

        @Override
        public String controlBaseUrl() {
            return "http://127.0.0.1:1";
        }

        @Override
        public String controlToken() {
            return "secret-token";
        }

        @Override
        public java.util.concurrent.CompletableFuture<AdapterProcessService.State> start() {
            state = AdapterProcessService.State.RUNNING;
            return java.util.concurrent.CompletableFuture.completedFuture(state);
        }

        @Override
        public java.util.concurrent.CompletableFuture<Void> stop() {
            state = AdapterProcessService.State.OFFLINE;
            return java.util.concurrent.CompletableFuture.completedFuture(null);
        }
    }

    private static final class FakeControlApi implements WechatControlApi {
        JsonObject statusJson = new JsonObject();
        final List<String> binds = new ArrayList<>();
        int loginStarts = 0;

        FakeControlApi() {
            statusJson.addProperty("authState", "UNCONFIGURED");
            statusJson.addProperty("transportRunning", false);
            statusJson.add("login", com.google.gson.JsonNull.INSTANCE);
            statusJson.add("binding", com.google.gson.JsonNull.INSTANCE);
        }

        @Override
        public JsonObject status() {
            return statusJson.deepCopy();
        }

        @Override
        public JsonObject loginStart() {
            loginStarts += 1;
            JsonObject login = new JsonObject();
            login.addProperty("loginId", "L1");
            login.addProperty("status", "QR_PENDING");
            login.addProperty("expiresAt", 1);
            login.addProperty("verifyCodeRequired", false);
            statusJson.add("login", login);
            return login.deepCopy();
        }

        @Override
        public JsonObject loginStatus(String loginId) {
            return statusJson.getAsJsonObject("login");
        }

        @Override
        public byte[] loginQr(String loginId) {
            return new byte[0];
        }

        @Override
        public boolean loginVerify(String loginId, String code) {
            return true;
        }

        @Override
        public boolean loginCancel(String loginId) {
            statusJson.add("login", com.google.gson.JsonNull.INSTANCE);
            return true;
        }

        @Override
        public void bind(String projectId, String tabId) {
            binds.add(projectId + ":" + tabId);
            JsonObject binding = new JsonObject();
            binding.addProperty("state", "BOUND");
            JsonObject target = new JsonObject();
            target.addProperty("projectId", projectId);
            target.addProperty("tabId", tabId);
            binding.add("target", target);
            statusJson.add("binding", binding);
        }

        @Override
        public void unbind() {
            statusJson.add("binding", com.google.gson.JsonNull.INSTANCE);
        }

        @Override
        public void logout() {
            statusJson.addProperty("authState", "UNCONFIGURED");
            statusJson.add("binding", com.google.gson.JsonNull.INSTANCE);
        }
    }

    private static final class FakeHandle implements WechatWindowHandle {
        final String projectId;
        final String tabId;
        boolean disposed;
        final List<String> pushed = new ArrayList<>();

        FakeHandle(String projectId, String tabId) {
            this.projectId = projectId;
            this.tabId = tabId;
        }

        @Override
        public String projectId() {
            return projectId;
        }

        @Override
        public String tabId() {
            return tabId;
        }

        @Override
        public boolean isDisposed() {
            return disposed;
        }

        @Override
        public void callJavaScript(String functionName, String json) {
            pushed.add(json);
        }
    }

    private static final class CapturingHandle implements WechatWindowHandle {
        final String projectId;
        final String tabId;
        final List<String[]> calls = new ArrayList<>();

        CapturingHandle(String projectId, String tabId) {
            this.projectId = projectId;
            this.tabId = tabId;
        }

        @Override
        public String projectId() {
            return projectId;
        }

        @Override
        public String tabId() {
            return tabId;
        }

        @Override
        public boolean isDisposed() {
            return false;
        }

        @Override
        public void callJavaScript(String functionName, String json) {
            calls.add(new String[]{functionName, json});
        }
    }

    @Test
    public void webviewNeverReceivesControlToken() {
        FakeProcessApi processApi = new FakeProcessApi();
        FakeControlApi controlApi = new FakeControlApi();
        WechatConnectionService service =
                new WechatConnectionService(processApi, process -> controlApi, false);
        FakeHandle handle = new FakeHandle("p1", "t1");
        service.registerWindow(handle);
        service.tickOnceForTest();
        assertFalse(handle.pushed.isEmpty());
        for (String json : handle.pushed) {
            assertFalse(json.contains("secret-token"));
            assertFalse(json.contains("secret"));
        }
    }

    @Test
    public void disposedWindowsAreRemoved() {
        FakeProcessApi processApi = new FakeProcessApi();
        FakeControlApi controlApi = new FakeControlApi();
        WechatConnectionService service =
                new WechatConnectionService(processApi, process -> controlApi, false);
        FakeHandle alive = new FakeHandle("p1", "t1");
        FakeHandle dead = new FakeHandle("p2", "t2");
        dead.disposed = true;
        service.registerWindow(alive);
        service.registerWindow(dead);
        service.tickOnceForTest();
        assertFalse(alive.pushed.isEmpty());
        assertTrue(dead.pushed.isEmpty()); // pruned before any push
    }

    @Test
    public void bindIntentUsesOwningHandleIdentity() {
        FakeProcessApi processApi = new FakeProcessApi();
        FakeControlApi controlApi = new FakeControlApi();
        WechatConnectionService service =
                new WechatConnectionService(processApi, process -> controlApi, false);
        FakeHandle handle = new FakeHandle("project-hex", "tab-uuid");
        service.bindCurrent(handle);
        service.tickOnceForTest();
        assertEquals(List.of("project-hex:tab-uuid"), controlApi.binds);
    }

    @Test
    public void tabClosedDuringQrResultsConnectedUnbound() {
        FakeProcessApi processApi = new FakeProcessApi();
        FakeControlApi controlApi = new FakeControlApi();
        WechatConnectionService service =
                new WechatConnectionService(processApi, process -> controlApi, false);
        FakeHandle origin = new FakeHandle("p1", "t1");
        FakeHandle observer = new FakeHandle("p9", "t9");
        service.loginStart(origin);
        service.registerWindow(observer);
        origin.disposed = true;
        controlApi.statusJson.addProperty("authState", "AUTHORIZED");
        controlApi.statusJson.addProperty("transportRunning", true);
        JsonObject login = controlApi.statusJson.getAsJsonObject("login");
        login.addProperty("status", "CONFIRMED");
        service.tickOnceForTest();
        assertTrue(controlApi.binds.isEmpty());
        assertTrue(observer.pushed.stream().anyMatch(json -> json.contains("CONNECTED_UNBOUND")));
    }

    @Test
    public void duplicateLoginStartKeepsFirstPendingTarget() throws InterruptedException {
        FakeProcessApi processApi = new FakeProcessApi();
        FakeControlApi controlApi = new FakeControlApi();
        WechatConnectionService service =
                new WechatConnectionService(processApi, process -> controlApi, false);
        FakeHandle first = new FakeHandle("p1", "t1");
        FakeHandle second = new FakeHandle("p2", "t2");
        service.loginStart(first);
        service.loginStart(second);
        assertEquals(2, controlApi.loginStarts); // adapter singleton returns the same session
        controlApi.statusJson.addProperty("authState", "AUTHORIZED");
        controlApi.statusJson.addProperty("transportRunning", true);
        JsonObject login = controlApi.statusJson.getAsJsonObject("login");
        login.addProperty("status", "CONFIRMED");
        // loginStart schedules background ticks; let the queued tick(s) consume
        // the pending target while CONFIRMED, then stop the scheduler so no
        // later background tick can race the assertions.
        Thread.sleep(150);
        service.dispose();
        service.tickOnceForTest();
        assertEquals(List.of("p1:t1"), controlApi.binds);
        assertNotNull(service);
    }

    @Test
    public void loggedOutAuthMapsToLoggedOutUiState() {
        FakeProcessApi processApi = new FakeProcessApi();
        FakeControlApi controlApi = new FakeControlApi();
        WechatConnectionService service =
                new WechatConnectionService(processApi, process -> controlApi, false);
        FakeHandle handle = new FakeHandle("p1", "t1");
        service.tickOnceForTest();
        JsonObject view = service.buildWindowView(handle);
        assertEquals("LOGGED_OUT", view.get("uiState").getAsString());
    }

    @Test
    public void pushToWindowEscapesSpecialCharactersExactlyOnce() {
        FakeProcessApi processApi = new FakeProcessApi();
        FakeControlApi controlApi = new FakeControlApi();
        WechatConnectionService service =
                new WechatConnectionService(processApi, process -> controlApi, false);
        String tricky = "A'B\"C\\D\nE\uD83D\uDE00</script>";
        controlApi.statusJson.addProperty("authState", tricky);
        controlApi.statusJson.addProperty("transportRunning", true);
        CapturingHandle handle = new CapturingHandle("p1", "t1");
        service.registerWindow(handle);

        service.tickOnceForTest();

        assertEquals(1, handle.calls.size());
        String[] call = handle.calls.get(0);
        assertEquals("onWechatStatus", call[0]);
        assertNotNull(call[1]);
        assertFalse(call[1].isEmpty());
        JsonObject view = service.buildWindowView(handle);
        // Exactly one escape layer: the pushed payload equals escapeJs(view),
        // and the raw view still contains the special characters.
        assertEquals(JsUtils.escapeJs(view.toString()), call[1]);
        assertTrue(view.toString().contains("'"));
        // No bare single quote may survive into the single-quoted JS literal
        // assembled by ClaudeChatWindow.callJavaScript: every quote must be
        // part of an escaped \' sequence.
        assertEquals(-1, call[1].replace("\\'", "").indexOf("'"));
        assertFalse(call[1].contains("\n"));
        assertFalse(call[1].contains("\r"));
        assertTrue(call[1].contains("\\'"));
        assertTrue(call[1].contains("\\\\n"));
        assertTrue(call[1].contains("\\\\"));
        assertTrue(call[1].contains("<\\/script>"));
        assertTrue(call[1].contains("\uD83D\uDE00"));
    }

    @Test
    public void listenerRegisteredAndRemovedOnDispose() throws Exception {
        AdapterProcessService adapter = newAdapterProcessService();
        int before = adapter.listenerCountForTest();

        WechatConnectionService service =
                new WechatConnectionService(adapter, process -> new FakeControlApi(), false);
        assertEquals(before + 1, adapter.listenerCountForTest());
        // The exact same listener instance that was registered must be removable.
        adapter.removeListener(service.processStateListenerForTest());
        assertEquals(before, adapter.listenerCountForTest());
        // Re-register for the dispose assertions below.
        adapter.addListener(service.processStateListenerForTest());
        assertEquals(before + 1, adapter.listenerCountForTest());

        service.dispose();
        assertEquals(before, adapter.listenerCountForTest());
    }

    @Test
    public void adapterNotificationAfterDisposeDoesNotThrow() throws Exception {
        AdapterProcessService adapter = newAdapterProcessService();
        WechatConnectionService service =
                new WechatConnectionService(adapter, process -> new FakeControlApi(), false);
        service.dispose();

        // Simulate a state callback racing dispose: even when the listener is
        // invoked after disposal, it must not throw or schedule new polls.
        adapter.addListener(service.processStateListenerForTest());
        adapter.notifyListenersForTest();
        assertEquals(0, service.pendingTaskCountForTest());
    }

    @Test
    public void schedulerDoesNotRescheduleAfterDispose() throws Exception {
        AdapterProcessService adapter = newAdapterProcessService();
        WechatConnectionService service =
                new WechatConnectionService(adapter, process -> new FakeControlApi(), false);
        service.dispose();
        assertTrue(service.isDisposedForTest());

        service.scheduleForTest(0);
        service.scheduleForTest(1_000);
        assertEquals(0, service.pendingTaskCountForTest());
    }

    @Test
    public void disposeIsIdempotent() throws Exception {
        AdapterProcessService adapter = newAdapterProcessService();
        WechatConnectionService service =
                new WechatConnectionService(adapter, process -> new FakeControlApi(), false);
        service.dispose();
        int countAfterFirstDispose = adapter.listenerCountForTest();

        service.dispose();
        service.dispose();

        assertEquals(countAfterFirstDispose, adapter.listenerCountForTest());
        assertEquals(0, service.pendingTaskCountForTest());
        assertTrue(service.isDisposedForTest());
    }

    private static AdapterProcessService newAdapterProcessService() throws IOException {
        File dir = java.nio.file.Files.createTempDirectory("wechat-listener-test").toFile();
        dir.deleteOnExit();
        File bundle = new File(dir, "adapter-bundle.cjs");
        assertTrue(bundle.createNewFile());
        return new AdapterProcessService(
                (command, env, workDir, stdout, stderr) -> {
                    throw new UnsupportedOperationException("launcher must not be used in listener tests");
                },
                () -> new AdapterProcessService.NodeRuntime("node", 22, "v22.23.2"),
                bundle,
                new File(dir, "state").getAbsolutePath(),
                new File(dir, "discovery.json").getAbsolutePath());
    }
}
