package com.github.claudecodegui.remote;

import com.github.claudecodegui.settings.ConfigPathManager;
import com.github.claudecodegui.startup.BridgePreloader;
import com.github.claudecodegui.util.PluginMetadata;
import com.intellij.openapi.application.ApplicationInfo;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.project.ProjectManager;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Application-level Remote Gateway.
 *
 * <p>A single instance exists per IDE process regardless of how many projects
 * are open. The gateway is disabled by default; it only starts when
 * {@code CCGUI_REMOTE_ENABLED} is set to a truthy value. When enabled it binds
 * a JDK {@link HttpServer} to {@code 127.0.0.1} on a random port, generates a
 * 256-bit bearer token, and writes a discovery file (without the token) for the
 * local Python adapter to find.
 *
 * <p>Registered as a light {@code @Service(APP)} and disposed on application
 * shutdown, which stops the server, shuts down its executor, and deletes the
 * discovery file. The token file is retained for the next session.
 */
@Service(Service.Level.APP)
public final class RemoteGatewayService implements Disposable {

    private static final Logger LOG = Logger.getInstance(RemoteGatewayService.class);

    static final String HOST = "127.0.0.1";
    private static final String TOKEN_FILE_NAME = "remote-gateway-token";
    private static final String DISCOVERY_FILE_NAME = "remote-gateway.json";
    private static final int DISCOVERY_VERSION = 1;
    private static final long EXECUTOR_SHUTDOWN_TIMEOUT_SECONDS = 2;

    private final Object startLock = new Object();
    private final ConfigPathManager pathManager = new ConfigPathManager();

    private volatile boolean enabled;
    private volatile boolean started;
    private volatile HttpServer server;
    private volatile int boundPort = -1;
    private volatile String token;
    private volatile Path tokenFile;
    private volatile Path discoveryFile;
    private volatile ExecutorService executor;
    // Observer references for lifecycle cleanup (Phase 2C-C.1 §5).
    private volatile com.github.claudecodegui.permission.PermissionInteractionObserver interactionObserver;
    private volatile com.github.claudecodegui.session.ClaudeSession.InterruptObserver interruptObserver;
    /**
     * This gateway's immutable generation ownership context (Phase 2C-C.1
     * generation-ownership + turn-start/dispose closure). Captured at start, carried by
     * the router/handlers, and marked closing at the very start of dispose so no new
     * G-owned turn can cross the start boundary while existing turns remain visible to
     * the abort lifecycle.
     */
    private volatile RemoteGatewayGeneration generation;

    public static RemoteGatewayService getInstance() {
        return ApplicationManager.getApplication().getService(RemoteGatewayService.class);
    }

    /**
     * Start the gateway if enabled and not already started. Idempotent and
     * safe to call from every project's startup activity.
     */
    public void startIfNeeded() {
        if (!RemoteGatewayConfig.isEnabled()) {
            if (!enabled) {
                LOG.info("[RemoteGateway] Disabled (set env " + RemoteGatewayConfig.ENV_ENABLED + "=true to enable)");
                enabled = false;
            }
            return;
        }
        synchronized (startLock) {
            if (started) {
                return;
            }
            doStart();
        }
    }

    private void doStart() {
        try {
            pathManager.ensureConfigDirectory();
        } catch (IOException e) {
            LOG.warn("[RemoteGateway] Cannot create config directory, gateway will not start: " + e.getMessage());
            return;
        }
        tokenFile = pathManager.getConfigDir().resolve(TOKEN_FILE_NAME);
        discoveryFile = pathManager.getConfigDir().resolve(DISCOVERY_FILE_NAME);

        String newToken = RemoteToken.generate();
        if (!writeTokenFile(tokenFile, newToken)) {
            LOG.warn("[RemoteGateway] Failed to persist token file, gateway will not start.");
            return;
        }

        HttpServer httpServer;
        try {
            // Port 0 lets the OS pick a random free port; bind is loopback only.
            httpServer = HttpServer.create(new java.net.InetSocketAddress(HOST, 0), 0);
        } catch (IOException e) {
            LOG.warn("[RemoteGateway] Failed to bind HTTP server on " + HOST + ": " + e.getMessage());
            return;
        }
        executor = createExecutor();
        httpServer.setExecutor(executor);
        // Capture the immutable gateway-generation ownership context for this gateway
        // instance (Phase 2C-C.1 generation-ownership + turn-start/dispose closure).
        // doStart runs under startLock, which excludes dispose()/bus.close(), so this
        // read cannot race with a rotation. Every handler created for this gateway
        // carries this context; tasks/subscribers are bound to its generation token
        // (not a late bus.currentGeneration() snapshot), and its start/closing boundary
        // serializes turn-start with dispose.
        this.generation = new RemoteGatewayGeneration(RemoteEventBus.getInstance().currentGeneration());
        RemoteApiRouter router = new RemoteApiRouter(this, newToken, generation);
        // Register at root and let the router match exact paths, so unknown
        // paths return our canonical 404 instead of the server's default.
        httpServer.createContext("/", router);
        httpServer.start();

        this.token = newToken;
        this.server = httpServer;
        this.boundPort = httpServer.getAddress().getPort();
        this.enabled = true;
        this.started = true;

        // Install the source-aware interaction observer so permission / ask /
        // plan requests are mirrored onto the Remote event stream.
        this.interactionObserver = com.github.claudecodegui.permission.PermissionService
                .installInteractionObserver(new RemoteInteractionObserverImpl());

        // Install the shared interrupt observer so any ClaudeSession interrupt
        // (desktop Stop / tab switch / Remote abort) marks the active Remote
        // task and cancels its pending interactions (Phase 2C-C §21).
        this.interruptObserver = com.github.claudecodegui.session.ClaudeSession
                .installInterruptObserver(new RemoteInterruptObserver());

        writeDiscoveryFile(discoveryFile, boundPort, tokenFile);
        LOG.info("[RemoteGateway] Enabled and listening on " + HOST + ":" + boundPort
                + " (discovery: " + discoveryFile + ")");
    }

    @Override
    public void dispose() {
        synchronized (startLock) {
            if (!started) {
                return;
            }
            started = false;
            if (server != null) {
                try {
                    server.stop(0);
                } catch (Exception e) {
                    LOG.debug("[RemoteGateway] Error stopping HTTP server: " + e.getMessage());
                }
                server = null;
            }
            if (executor != null) {
                executor.shutdownNow();
                try {
                    if (!executor.awaitTermination(EXECUTOR_SHUTDOWN_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                        LOG.warn("[RemoteGateway] HTTP executor did not terminate cleanly.");
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                executor = null;
            }
            if (discoveryFile != null) {
                deleteQuietly(discoveryFile);
            }
            // ── Generation closing boundary (Phase 2C-C.1 turn-start/dispose closure) ──
            // Mark this gateway's generation CLOSING FIRST, so no new G-owned turn may
            // cross the dispatch start boundary hereafter. Any turn that already crossed
            // (registered + channel established under gen.startLock, before this call)
            // remains visible to the abort below. This must precede bus.close() /
            // requestAbortAllActive() so a turn racing dispose cannot start a fresh
            // ClaudeSession.send after the abort snapshot was taken.
            if (generation != null) {
                try {
                    generation.beginClosing();
                } catch (Throwable t) {
                    LOG.debug("[RemoteGateway] Generation beginClosing: " + t.getMessage());
                }
            }
            // Disable the SSE event bus — any subscriber still draining will
            // see the queue close. After this, no new events can be subscribed.
            try {
                RemoteEventBus.getInstance().close();
            } catch (Throwable t) {
                LOG.debug("[RemoteGateway] Event bus close: " + t.getMessage());
            }
            // OPTION A: genuinely abort every active Remote task. Calls
            // session.interrupt() which triggers the InterruptObserver (still
            // installed) → marks abort + cancels pending interactions +
            // force-closes desktop dialogs. Gates stay held until send futures
            // complete and finalizeTask releases them (Phase 2C-C.1c §2-3).
            try {
                RemoteTaskRegistry.getInstance().requestAbortAllActive();
            } catch (Throwable t) {
                LOG.warn("[RemoteGateway] Request abort all failed: " + t.getMessage());
            }
            // Now safe to uninstall observers — they've finished their work.
            if (interactionObserver != null) {
                com.github.claudecodegui.permission.PermissionService
                        .uninstallInteractionObserver(interactionObserver);
                interactionObserver = null;
            }
            if (interruptObserver != null) {
                com.github.claudecodegui.session.ClaudeSession
                        .uninstallInterruptObserver(interruptObserver);
                interruptObserver = null;
            }
            // Interaction registry holds only observing state; it is safe to
            // drop because the tasks it references are being aborted above.
            try {
                RemoteInteractionRegistry.getInstance().dispose();
            } catch (Throwable t) {
                LOG.warn("[RemoteGateway] Interaction registry dispose: " + t.getMessage());
            }
            try {
                RemoteEventInfra.getInstance().dispose();
            } catch (Throwable t) {
                LOG.debug("[RemoteGateway] RemoteEventInfra dispose: " + t.getMessage());
            }
            token = null;
            boundPort = -1;
            LOG.info("[RemoteGateway] Stopped.");
        }
    }

    // ---------------- accessors used by the router / status ----------------

    public boolean isEnabled() {
        return enabled;
    }

    public int getBoundPort() {
        return boundPort;
    }

    public boolean isBridgeReady() {
        try {
            return BridgePreloader.isBridgeReady();
        } catch (Throwable t) {
            // BridgePreloader is project-triggered; never fail health on it.
            return false;
        }
    }

    public String getPluginVersion() {
        return PluginMetadata.getPluginVersion();
    }

    public String getIdeName() {
        try {
            return ApplicationInfo.getInstance().getVersionName();
        } catch (Throwable t) {
            return "unknown";
        }
    }

    public String getIdeBuild() {
        try {
            return ApplicationInfo.getInstance().getBuild().asString();
        } catch (Throwable t) {
            return "unknown";
        }
    }

    public List<RemoteProjectSnapshot> listProjects() {
        List<RemoteProjectSnapshot> out = new ArrayList<>();
        Project[] open;
        try {
            open = ProjectManager.getInstance().getOpenProjects();
        } catch (Throwable t) {
            LOG.debug("[RemoteGateway] Failed to enumerate open projects: " + t.getMessage());
            return out;
        }
        for (Project project : open) {
            RemoteProjectSnapshot snapshot = RemoteProjectSnapshot.from(project);
            if (snapshot != null) {
                out.add(snapshot);
            }
        }
        return out;
    }

    /**
     * Resolve an open, non-disposed project by its remote {@code projectId}.
     * Returns null when no open project matches (caller returns 404). Does not
     * create a second project registry — it walks {@link ProjectManager} and
     * reuses {@link RemoteProjectId}.
     */
    @org.jetbrains.annotations.Nullable
    public Project findProjectById(String projectId) {
        if (projectId == null || projectId.isEmpty()) {
            return null;
        }
        Project[] open;
        try {
            open = ProjectManager.getInstance().getOpenProjects();
        } catch (Throwable t) {
            return null;
        }
        for (Project project : open) {
            if (project == null || project.isDisposed()) {
                continue;
            }
            String id = RemoteProjectId.of(project.getBasePath());
            if (projectId.equals(id)) {
                return project;
            }
        }
        return null;
    }

    /**
     * Collect immutable tab snapshots for a project. The UI/session read runs
     * on the EDT (bounded by a timeout); the returned list holds no live UI
     * references and is safe to serialize on the HTTP worker thread.
     */
    public List<RemoteTabSnapshot> collectTabs(Project project) {
        return RemoteTabCollector.collect(project);
    }

    // ---------------- file persistence ----------------

    private boolean writeTokenFile(Path file, String tokenValue) {
        try {
            atomicWrite(file, tokenValue.getBytes(StandardCharsets.UTF_8));
            hardenFilePermissions(file);
            return true;
        } catch (IOException e) {
            LOG.warn("[RemoteGateway] Failed to write token file: " + e.getMessage());
            return false;
        }
    }

    private void writeDiscoveryFile(Path file, int port, Path tokenFilePath) {
        String json = buildDiscoveryJson(port, tokenFilePath);
        try {
            atomicWrite(file, json.getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            LOG.warn("[RemoteGateway] Failed to write discovery file: " + e.getMessage());
        }
    }

    private String buildDiscoveryJson(int port, Path tokenFilePath) {
        // Hand-rolled to avoid depending on a specific Gson version's pretty
        // printer; the document is tiny and stable.
        String tokenPath = escapeJson(tokenFilePath.toString());
        long pid;
        try {
            pid = ProcessHandle.current().pid();
        } catch (Throwable t) {
            pid = -1;
        }
        return "{\n"
                + "  \"version\": " + DISCOVERY_VERSION + ",\n"
                + "  \"host\": \"" + HOST + "\",\n"
                + "  \"port\": " + port + ",\n"
                + "  \"tokenFile\": \"" + tokenPath + "\",\n"
                + "  \"pid\": " + pid + "\n"
                + "}";
    }

    /**
     * Atomic write via temp file + move. The temp file lives in the same
     * directory so the move can be atomic on a single filesystem.
     */
    private static void atomicWrite(Path target, byte[] bytes) throws IOException {
        Path parent = target.getParent();
        if (parent != null && !Files.exists(parent)) {
            Files.createDirectories(parent);
        }
        Path tmp = Files.createTempFile(parent, ".remote-gw-", ".tmp");
        try {
            Files.write(tmp, bytes);
            try {
                Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (java.nio.file.AtomicMoveNotSupportedException e) {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException e) {
            deleteQuietly(tmp);
            throw e;
        }
    }

    /**
     * Best-effort restrict a file to owner read/write (0600). On Windows there
     * is no portable JDK-only way to set an owner-only ACL, so it is a no-op
     * there and left as a TODO.
     *
     * <p>TODO: enforce owner-only ACL on Windows via JNA or icacls without
     * adding a heavy native dependency.
     */
    private static void hardenFilePermissions(Path path) {
        try {
            Files.setPosixFilePermissions(path, PosixFilePermissions.fromString("rw-------"));
        } catch (UnsupportedOperationException | IOException e) {
            // Windows falls here; the per-user home ACL already applies.
            LOG.debug("[RemoteGateway] Could not set 0600 on " + path + ": " + e.getMessage());
        }
    }

    private static void deleteQuietly(Path file) {
        try {
            Files.deleteIfExists(file);
        } catch (IOException e) {
            LOG.debug("[RemoteGateway] Could not delete " + file + ": " + e.getMessage());
        }
    }

    private static String escapeJson(String s) {
        StringBuilder sb = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '\\' -> sb.append("\\\\");
                case '"' -> sb.append("\\\"");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> sb.append(c);
            }
        }
        return sb.toString();
    }

    private static ExecutorService createExecutor() {
        AtomicInteger counter = new AtomicInteger();
        return Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "ccgui-remote-http-" + counter.incrementAndGet());
            t.setDaemon(true);
            return t;
        });
    }

    /**
     * Convenience for tests / manual inspection: is the server currently up?
     */
    public boolean isRunning() {
        return started && server != null;
    }
}
