package com.github.claudecodegui.provider.common;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.ClaudeCliPathHandler;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.diagnostic.Logger;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Manages a long-running Node.js daemon process for AI SDK communication.
 *
 * Instead of spawning a new Node.js process per request (which adds ~5-10s of
 * overhead due to SDK loading), this class maintains a single daemon process
 * that pre-loads the SDK once and handles multiple requests via NDJSON over stdin/stdout.
 *
 * Protocol:
 * - Java writes JSON requests to daemon's stdin (one per line)
 * - Daemon writes JSON responses to stdout (one per line, tagged with request ID)
 * - Daemon lifecycle events have type="daemon"
 * - Command output lines have an "id" field matching the request
 * - Command completion is signaled by {"id":"X","done":true}
 */
public class DaemonBridge {

    private static final Logger LOG = Logger.getInstance(DaemonBridge.class);
    private static final String DAEMON_SCRIPT = "daemon.js";
    private static final long DAEMON_START_TIMEOUT_MS = 30_000;
    private static final long HEARTBEAT_INTERVAL_MS = 15_000;
    private static final long HEARTBEAT_TIMEOUT_MS = 45_000; // 3 missed heartbeats = dead
    private static final long ACTIVE_REQUEST_HEARTBEAT_TIMEOUT_MS = 180_000;
    private static final int MAX_RESTART_ATTEMPTS = 3;
    private static final long RESTART_WINDOW_MS = 30_000; // Reset restart counter after this period of stability

    private final NodeDetector nodeDetector;
    private final BridgeDirectoryResolver directoryResolver;
    private final EnvironmentConfigurator envConfigurator;
    // Daemon process state
    private volatile Process daemonProcess;
    private volatile BufferedWriter daemonStdin;
    private volatile Thread readerThread;
    private volatile Thread heartbeatThread;
    private final AtomicBoolean isRunning = new AtomicBoolean(false);
    private final AtomicBoolean sdkPreloaded = new AtomicBoolean(false);
    private final AtomicLong requestIdCounter = new AtomicLong(0);
    private volatile CountDownLatch readyLatch = new CountDownLatch(1);
    private final AtomicInteger restartAttempts = new AtomicInteger(0);
    private final AtomicLong lastSuccessfulStart = new AtomicLong(0);
    private final AtomicLong lastHeartbeatResponse = new AtomicLong(0);
    private final AtomicLong lastDaemonActivity = new AtomicLong(0);
    private final AtomicInteger activeRequestCount = new AtomicInteger(0);
    private final Object startLock = new Object();

    // Pending request handlers: requestId -> handler
    private final ConcurrentHashMap<String, RequestHandler> pendingRequests = new ConcurrentHashMap<>();

    // Lifecycle listener
    private volatile DaemonLifecycleListener lifecycleListener;

    // Event listeners for custom daemon events. CopyOnWriteArrayList allows safe
    // iteration during dispatch while listeners may be added/removed concurrently.
    private final List<DaemonEventListener> eventListeners = new CopyOnWriteArrayList<>();

    public DaemonBridge(
            NodeDetector nodeDetector,
            BridgeDirectoryResolver directoryResolver,
            EnvironmentConfigurator envConfigurator
    ) {
        this.nodeDetector = nodeDetector;
        this.directoryResolver = directoryResolver;
        this.envConfigurator = envConfigurator;
    }

    // =========================================================================
    // Lifecycle
    // =========================================================================

    /**
     * Start the daemon process. Blocks until the daemon signals "ready"
     * or the timeout expires.
     *
     * @return true if daemon started successfully
     */
    public boolean start() {
        synchronized (startLock) {
            if (isRunning.get()) {
                LOG.info("[DaemonBridge] Daemon already running");
                return true;
            }

            LOG.info("[DaemonBridge] Starting daemon process...");
            CountDownLatch latch = new CountDownLatch(1);
            readyLatch = latch;

            try {
                File bridgeDir = directoryResolver.findSdkDir();
                if (bridgeDir == null) {
                    LOG.error("[DaemonBridge] Bridge directory not found");
                    return false;
                }

                File daemonScript = new File(bridgeDir, DAEMON_SCRIPT);
                if (!daemonScript.exists()) {
                    LOG.error("[DaemonBridge] daemon.js not found at: " + daemonScript.getAbsolutePath());
                    return false;
                }

                String nodePath = nodeDetector.findNodeExecutable();
                if (nodePath == null) {
                    LOG.error("[DaemonBridge] Node.js not found");
                    return false;
                }

                List<String> daemonCmd = NodeDetector.buildNodeScriptCommand(
                        nodePath, daemonScript.getAbsolutePath());
                ProcessBuilder pb = new ProcessBuilder(daemonCmd);
                pb.directory(bridgeDir);

                // Configure environment
                Map<String, String> env = pb.environment();
                envConfigurator.updateProcessEnvironment(pb, nodePath);

                // Pass through user-configured Claude Code CLI override (if any).
                // Picked up by ai-bridge to set SDK option `pathToClaudeCodeExecutable`.
                String claudeCliPath = PropertiesComponent.getInstance()
                        .getValue(ClaudeCliPathHandler.CLAUDE_CLI_PATH_PROPERTY_KEY);
                if (claudeCliPath != null && !claudeCliPath.trim().isEmpty()) {
                    env.put("CLAUDE_CODE_PATH", claudeCliPath.trim());
                    LOG.info("[DaemonBridge] Using custom Claude CLI: " + claudeCliPath.trim());
                }

                // Keep stderr separate for debugging
                pb.redirectErrorStream(false);

                daemonProcess = pb.start();
                isRunning.set(true);
                lastSuccessfulStart.set(System.currentTimeMillis());
                markDaemonActivity();

                LOG.info("[DaemonBridge] Daemon process started, PID: " + daemonProcess.pid());

                // Setup stdin writer
                daemonStdin = new BufferedWriter(
                        new OutputStreamWriter(daemonProcess.getOutputStream(), StandardCharsets.UTF_8));

                // Start stdout reader thread
                startReaderThread();

                // Start stderr reader thread (for debugging)
                startStderrReaderThread();

                // Wait for "ready" event, but fail fast if process exits early.
                boolean ready = false;
                long deadline = System.currentTimeMillis() + DAEMON_START_TIMEOUT_MS;
                while (System.currentTimeMillis() < deadline) {
                    if (latch.await(200, TimeUnit.MILLISECONDS)) {
                        ready = true;
                        break;
                    }
                    if (daemonProcess == null || !daemonProcess.isAlive() || !isRunning.get()) {
                        LOG.error("[DaemonBridge] Daemon exited before signaling ready");
                        isRunning.set(false);
                        return false;
                    }
                }
                if (!ready) {
                    LOG.warn("[DaemonBridge] Daemon did not signal ready within timeout");
                    if (daemonProcess == null || !daemonProcess.isAlive() || !isRunning.get()) {
                        LOG.error("[DaemonBridge] Daemon is not alive after ready timeout");
                        isRunning.set(false);
                        return false;
                    }
                }

                // Start heartbeat thread
                startHeartbeatThread();

                LOG.info("[DaemonBridge] Daemon is ready. SDK preloaded: " + sdkPreloaded.get());
                return true;

            } catch (Exception e) {
                LOG.error("[DaemonBridge] Failed to start daemon", e);
                isRunning.set(false);
                return false;
            }
        }
    }

    /**
     * Stop the daemon process gracefully.
     */
    public void stop() {
        LOG.info("[DaemonBridge] Stopping daemon...");
        isRunning.set(false);

        // Cancel all pending requests
        for (Map.Entry<String, RequestHandler> entry : pendingRequests.entrySet()) {
            entry.getValue().onError("Daemon stopped");
        }
        pendingRequests.clear();
        activeRequestCount.set(0);

        // Send shutdown command before closing stdin (allows daemon to flush)
        try {
            if (daemonStdin != null) {
                JsonObject shutdown = new JsonObject();
                shutdown.addProperty("id", "shutdown");
                shutdown.addProperty("method", "shutdown");
                synchronized (daemonStdin) {
                    daemonStdin.write(shutdown.toString());
                    daemonStdin.newLine();
                    daemonStdin.flush();
                }
            }
        } catch (IOException e) {
            LOG.debug("[DaemonBridge] Error sending shutdown command: " + e.getMessage());
        }

        // Close stdin (triggers daemon shutdown if command wasn't received)
        try {
            if (daemonStdin != null) {
                daemonStdin.close();
            }
        } catch (IOException e) {
            LOG.debug("[DaemonBridge] Error closing stdin: " + e.getMessage());
        }

        // Kill process if still alive and wait for termination
        if (daemonProcess != null && daemonProcess.isAlive()) {
            daemonProcess.destroyForcibly();
            try {
                daemonProcess.waitFor(3, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        // Interrupt and join threads
        if (readerThread != null) {
            readerThread.interrupt();
            try {
                readerThread.join(2000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        if (heartbeatThread != null) {
            heartbeatThread.interrupt();
            try {
                heartbeatThread.join(2000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        LOG.info("[DaemonBridge] Daemon stopped");
    }

    /**
     * Send an abort command to cancel the currently executing request.
     * The abort bypasses the daemon's command queue and is processed immediately.
     * Also completes all pending request futures so Java-side blocking calls unblock.
     */
    public void sendAbort() {
        // Send abort command to daemon so it stops the active SDK query
        try {
            if (daemonStdin != null && isRunning.get()) {
                JsonObject abort = new JsonObject();
                abort.addProperty("id", "abort-" + System.currentTimeMillis());
                abort.addProperty("method", "abort");
                synchronized (daemonStdin) {
                    daemonStdin.write(abort.toString());
                    daemonStdin.newLine();
                    daemonStdin.flush();
                }
                LOG.info("[DaemonBridge] Sent abort command");
            }
        } catch (IOException e) {
            LOG.debug("[DaemonBridge] Error sending abort command: " + e.getMessage());
        }

        // Complete all pending request futures so Java-side callers unblock.
        // Use onComplete(false) instead of onError() so that user-initiated aborts
        // are treated as a normal (unsuccessful) completion rather than an error,
        // matching the graceful handling that Codex uses.
        for (Map.Entry<String, RequestHandler> entry : pendingRequests.entrySet()) {
            entry.getValue().onAbort();
        }
        pendingRequests.clear();
        activeRequestCount.set(0);
    }

    /**
     * Check if the daemon is running and healthy.
     */
    public boolean isAlive() {
        return isRunning.get() && daemonProcess != null && daemonProcess.isAlive();
    }

    /**
     * Returns the underlying daemon Process for inspection by NodeProcessRegistry.
     * May be null when no daemon is running. Callers must NOT destroy/kill through
     * this reference — always go through stop() to keep state consistent.
     */
    public Process getDaemonProcessForInspection() {
        return daemonProcess;
    }

    /**
     * Returns the number of in-flight requests currently being processed by the daemon.
     * Used by the management panel to indicate daemon load.
     */
    public int getActiveRequestCount() {
        return activeRequestCount.get();
    }

    /**
     * Ensure the daemon is running, starting it if necessary.
     */
    public boolean ensureRunning() {
        if (isAlive()) { return true; }
        return start();
    }

    // =========================================================================
    // Request Execution
    // =========================================================================

    /**
     * Send a command to the daemon and process output lines via callback.
     *
     * This method is non-blocking. Output lines are delivered to the callback
     * as they arrive from the daemon. The returned future completes when the
     * daemon signals "done" for this request.
     *
     * @param method   Command method (e.g., "claude.send")
     * @param params   Command parameters (JSON object)
     * @param callback Callback for processing output lines
     * @return CompletableFuture that completes when the command finishes
     */
    public CompletableFuture<Boolean> sendCommand(
            String method,
            JsonObject params,
            DaemonOutputCallback callback
    ) {
        if (!ensureRunning()) {
            CompletableFuture<Boolean> f = new CompletableFuture<>();
            f.completeExceptionally(new IOException("Daemon not running"));
            return f;
        }

        String requestId = String.valueOf(requestIdCounter.incrementAndGet());
        CompletableFuture<Boolean> future = new CompletableFuture<>();
        boolean countsAsActiveRequest = !"heartbeat".equals(method) && !"status".equals(method);

        RequestHandler handler = new RequestHandler(callback, future);
        pendingRequests.put(requestId, handler);
        if (countsAsActiveRequest) {
            activeRequestCount.incrementAndGet();
        }
        markDaemonActivity();

        // Ensure cleanup when future completes (e.g., via timeout or cancellation)
        future.whenComplete((result, ex) -> {
            pendingRequests.remove(requestId);
            if (countsAsActiveRequest) {
                activeRequestCount.updateAndGet(current -> Math.max(0, current - 1));
            }
        });

        // Build request JSON
        JsonObject request = new JsonObject();
        request.addProperty("id", requestId);
        request.addProperty("method", method);
        request.add("params", params);

        try {
            synchronized (daemonStdin) {
                daemonStdin.write(request.toString());
                daemonStdin.newLine();
                daemonStdin.flush();
            }
            LOG.info("[DaemonBridge] Sent request " + requestId + ": " + method);
        } catch (IOException e) {
            pendingRequests.remove(requestId);
            future.completeExceptionally(e);
            LOG.error("[DaemonBridge] Failed to send request: " + e.getMessage());
        }

        return future;
    }

    // =========================================================================
    // Reader Threads
    // =========================================================================

    private void startReaderThread() {
        readerThread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(daemonProcess.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    handleDaemonOutput(line);
                }
            } catch (IOException e) {
                if (isRunning.get()) {
                    LOG.error("[DaemonBridge] Reader thread error: " + e.getMessage());
                }
            } finally {
                handleDaemonDeath();
            }
        }, "DaemonBridge-Reader");
        readerThread.setDaemon(true);
        readerThread.start();
    }

    private void startStderrReaderThread() {
        Thread stderrThread = new Thread(() -> {
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(daemonProcess.getErrorStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    LOG.debug("[DaemonBridge:stderr] " + line);
                }
            } catch (IOException e) {
                // Expected on shutdown
            }
        }, "DaemonBridge-Stderr");
        stderrThread.setDaemon(true);
        stderrThread.start();
    }

    private void startHeartbeatThread() {
        // Initialize heartbeat baseline so the first check doesn't trigger timeout
        long now = System.currentTimeMillis();
        lastHeartbeatResponse.set(now);
        lastDaemonActivity.set(now);

        heartbeatThread = new Thread(() -> {
            while (isRunning.get()) {
                try {
                    Thread.sleep(HEARTBEAT_INTERVAL_MS);
                    if (!isAlive()) { break; }

                    // Check if daemon is unresponsive (no heartbeat response for too long)
                    long currentTime = System.currentTimeMillis();
                    long heartbeatAgeMs = currentTime - lastHeartbeatResponse.get();
                    long activityAgeMs = currentTime - lastDaemonActivity.get();
                    int activeRequests = activeRequestCount.get();
                    if (shouldTreatAsUnresponsive(heartbeatAgeMs, activityAgeMs, activeRequests)) {
                        LOG.warn("[DaemonBridge] Daemon unresponsive (heartbeatAgeMs=" + heartbeatAgeMs
                                + ", activityAgeMs=" + activityAgeMs
                                + ", activeRequests=" + activeRequests + "), treating as dead");
                        handleDaemonDeath();
                        break;
                    }

                    // Send heartbeat
                    JsonObject hb = new JsonObject();
                    hb.addProperty("id", "hb-" + System.currentTimeMillis());
                    hb.addProperty("method", "heartbeat");
                    synchronized (daemonStdin) {
                        daemonStdin.write(hb.toString());
                        daemonStdin.newLine();
                        daemonStdin.flush();
                    }
                } catch (InterruptedException e) {
                    break;
                } catch (IOException e) {
                    LOG.warn("[DaemonBridge] Heartbeat failed: " + e.getMessage());
                    handleDaemonDeath();
                    break;
                }
            }
        }, "DaemonBridge-Heartbeat");
        heartbeatThread.setDaemon(true);
        heartbeatThread.start();
    }

    // =========================================================================
    // Output Parsing
    // =========================================================================

    private void handleDaemonOutput(String jsonLine) {
        markDaemonActivity();
        // Skip non-JSON lines (SDK debug output, permission logs, etc.)
        String trimmed = jsonLine.trim();
        if (trimmed.isEmpty() || trimmed.charAt(0) != '{') {
            LOG.debug("[DaemonBridge] Non-JSON output: " + trimmed);
            return;
        }

        try {
            JsonElement element = JsonParser.parseString(trimmed);
            if (!element.isJsonObject()) { return; }
            JsonObject obj = element.getAsJsonObject();

            // --- Daemon lifecycle events ---
            if (obj.has("type")) {
                String type = obj.get("type").getAsString();

                if ("daemon".equals(type)) {
                    handleDaemonEvent(obj);
                    return;
                }

                if ("heartbeat".equals(type)) {
                    // Heartbeat response — daemon is alive
                    lastHeartbeatResponse.set(System.currentTimeMillis());
                    markDaemonActivity();
                    return;
                }

                if ("status".equals(type)) {
                    // Status response
                    return;
                }
            }

            // --- Request-tagged output ---
            if (!obj.has("id")) { return; }
            String id = obj.get("id").getAsString();

            // Skip heartbeat responses
            if (id.startsWith("hb-")) { return; }

            RequestHandler handler = pendingRequests.get(id);
            if (handler == null) {
                LOG.debug("[DaemonBridge] No handler for request " + id);
                return;
            }

            // Command completion
            if (obj.has("done")) {
                boolean success = obj.has("success") && obj.get("success").getAsBoolean();
                if (!success && obj.has("error")) {
                    handler.onError(obj.get("error").getAsString());
                }
                handler.onComplete(success);
                pendingRequests.remove(id);
                return;
            }

            // Output line from the command
            if (obj.has("line")) {
                handler.callback.onLine(obj.get("line").getAsString());
                return;
            }

            // Stderr output
            if (obj.has("stderr")) {
                handler.callback.onStderr(obj.get("stderr").getAsString());
            }

        } catch (Exception e) {
            LOG.error("[DaemonBridge] Failed to parse daemon output: " + jsonLine, e);
        }
    }

    private void handleDaemonEvent(JsonObject obj) {
        String event = obj.has("event") ? obj.get("event").getAsString() : "unknown";
        LOG.info("[DaemonBridge] Daemon event: " + event);

        switch (event) {
            case "ready":
                if (obj.has("sdkPreloaded")) {
                    sdkPreloaded.set(obj.get("sdkPreloaded").getAsBoolean());
                }
                readyLatch.countDown();
                if (lifecycleListener != null) {
                    lifecycleListener.onDaemonReady();
                }
                break;

            case "sdk_loaded":
                sdkPreloaded.set(true);
                LOG.info("[DaemonBridge] SDK pre-loaded successfully");
                break;

            case "sdk_load_error":
                String error = obj.has("error") ? obj.get("error").getAsString() : "unknown";
                LOG.warn("[DaemonBridge] SDK pre-load failed: " + error);
                break;

            case "shutdown":
                LOG.info("[DaemonBridge] Daemon shutting down");
                break;

            case "title_log": {
                String titleLevel = obj.has("level") ? obj.get("level").getAsString() : "info";
                String titleMsg = obj.has("message") ? obj.get("message").getAsString() : "";
                if ("error".equals(titleLevel) || "warn".equals(titleLevel)) {
                    LOG.warn("[TitleService] " + titleMsg);
                } else {
                    LOG.info("[TitleService] " + titleMsg);
                }
                break;
            }

            case "title_generated": {
                LOG.info("[DaemonBridge] AI title generated: sessionId="
                        + (obj.has("sessionId") ? obj.get("sessionId").getAsString() : "?")
                        + ", title=" + (obj.has("title") ? obj.get("title").getAsString() : "?"));
                for (DaemonEventListener listener : eventListeners) {
                    try {
                        listener.onDaemonEvent(event, obj);
                    } catch (Exception ex) {
                        LOG.warn("[DaemonBridge] Listener threw while handling " + event, ex);
                    }
                }
                break;
            }

            case "session_updated": {
                // Extract and validate sessionId
                String sessionId = obj.has("sessionId") ? obj.get("sessionId").getAsString() : null;
                if (sessionId == null || sessionId.isEmpty()) {
                    LOG.warn("[DaemonBridge] session_updated event missing sessionId, skipping");
                    break;
                }

                LOG.info("[DaemonBridge] Session updated: sessionId=" + sessionId);

                // Iterate through registered eventListeners and dispatch
                for (DaemonEventListener listener : eventListeners) {
                    try {
                        listener.onDaemonEvent(event, obj);
                    } catch (Exception ex) {
                        LOG.warn("[DaemonBridge] Listener threw while handling " + event, ex);
                    }
                }
                break;
            }

            default:
                LOG.debug("[DaemonBridge] Unhandled daemon event: " + event);
        }
    }

    // =========================================================================
    // Daemon Death & Auto-Restart
    // =========================================================================

    private void handleDaemonDeath() {
        if (!isRunning.compareAndSet(true, false)) { return; }

        LOG.warn("[DaemonBridge] Daemon process died");

        // Forcefully kill the old process if still alive (e.g., heartbeat timeout)
        Process oldProcess = daemonProcess;
        if (oldProcess != null && oldProcess.isAlive()) {
            LOG.info("[DaemonBridge] Forcefully killing unresponsive daemon process (PID: "
                    + oldProcess.pid() + ")");
            oldProcess.destroyForcibly();
            try {
                oldProcess.waitFor(2, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }

        // Fail all pending requests
        for (Map.Entry<String, RequestHandler> entry : pendingRequests.entrySet()) {
            entry.getValue().onError("Daemon process died unexpectedly");
        }
        pendingRequests.clear();
        activeRequestCount.set(0);

        // Notify listener
        if (lifecycleListener != null) {
            lifecycleListener.onDaemonDied();
        }

        // Auto-restart if within limit.
        // If the daemon ran stably for RESTART_WINDOW_MS before dying, reset the
        // counter so transient failures don't exhaust attempts permanently.
        long uptime = System.currentTimeMillis() - lastSuccessfulStart.get();
        if (uptime > RESTART_WINDOW_MS) {
            restartAttempts.set(0);
        }

        int attempts = restartAttempts.incrementAndGet();
        if (attempts <= MAX_RESTART_ATTEMPTS) {
            LOG.info("[DaemonBridge] Attempting restart (" + attempts + "/" + MAX_RESTART_ATTEMPTS
                    + ", last uptime=" + uptime + "ms)");
            start();
        } else {
            LOG.error("[DaemonBridge] Max restart attempts reached (" + attempts
                    + " within " + RESTART_WINDOW_MS + "ms window). Daemon will not be restarted.");
        }
    }

    // =========================================================================
    // Setters
    // =========================================================================

    public void setLifecycleListener(DaemonLifecycleListener listener) {
        this.lifecycleListener = listener;
    }

    /**
     * Register a listener for custom daemon events (e.g., title_generated).
     * Multiple listeners may coexist; each is invoked on every matching event.
     * Callers MUST pair this with {@link #removeEventListener} on disposal to
     * avoid memory leaks.
     */
    public void addEventListener(DaemonEventListener listener) {
        if (listener == null) { return; }
        eventListeners.add(listener);
    }

    /**
     * Remove a previously registered listener. No-op if not registered.
     */
    public void removeEventListener(DaemonEventListener listener) {
        if (listener == null) { return; }
        eventListeners.remove(listener);
    }

    public boolean isSdkPreloaded() {
        return sdkPreloaded.get();
    }

    static boolean shouldTreatAsUnresponsive(long heartbeatAgeMs, long activityAgeMs, int activeRequestCount) {
        if (activeRequestCount <= 0) {
            return heartbeatAgeMs > HEARTBEAT_TIMEOUT_MS;
        }
        long livenessAgeMs = Math.min(heartbeatAgeMs, activityAgeMs);
        return livenessAgeMs > ACTIVE_REQUEST_HEARTBEAT_TIMEOUT_MS;
    }

    private void markDaemonActivity() {
        lastDaemonActivity.set(System.currentTimeMillis());
    }

    // =========================================================================
    // Inner Types
    // =========================================================================

    /**
     * Callback interface for receiving daemon output.
     */
    public interface DaemonOutputCallback {
        void onLine(String line);
        void onStderr(String text);
        void onError(String error);
        void onComplete(boolean success);

        /**
         * Called when the user manually aborts the request.
         * Default implementation delegates to {@link #onComplete(boolean) onComplete(false)}
         * so that aborts are treated as a graceful (unsuccessful) completion,
         * not an error.
         */
        default void onAbort() {
            onComplete(false);
        }
    }

    /**
     * Lifecycle listener for daemon events.
     */
    public interface DaemonLifecycleListener {
        void onDaemonReady();
        void onDaemonDied();
    }

    /**
     * Listener for custom daemon events (e.g., title_generated).
     */
    public interface DaemonEventListener {
        void onDaemonEvent(String event, JsonObject data);
    }

    /**
     * Internal handler that wraps callback + future for a pending request.
     */
    private static class RequestHandler {
        final DaemonOutputCallback callback;
        final CompletableFuture<Boolean> future;

        RequestHandler(DaemonOutputCallback callback, CompletableFuture<Boolean> future) {
            this.callback = callback;
            this.future = future;
        }

        void onError(String error) {
            callback.onError(error);
            future.completeExceptionally(new RuntimeException(error));
        }

        /**
         * Handle user-initiated abort gracefully.
         * Unlike onError, this completes the future normally (with false) so callers
         * do not see an exception. The DaemonOutputCallback.onAbort() method lets
         * the downstream handler distinguish aborts from real errors.
         */
        void onAbort() {
            callback.onAbort();
            future.complete(false);
        }

        void onComplete(boolean success) {
            callback.onComplete(success);
            future.complete(success);
        }
    }
}
