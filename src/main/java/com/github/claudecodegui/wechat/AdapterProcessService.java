package com.github.claudecodegui.wechat;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.model.NodeDetectionResult;
import com.github.claudecodegui.util.PlatformUtils;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.intellij.ide.util.PropertiesComponent;
import com.intellij.openapi.Disposable;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.components.Service;
import com.intellij.openapi.diagnostic.Logger;
import org.jetbrains.annotations.Nullable;

import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * APP-level owner of the long-running Adapter Node process (M9 §4).
 *
 * Lazy start on first Connect click, parent-child bootstrap via environment
 * variables (token + parent PID), READY stdout handshake, bounded shutdown
 * and manual retry. No infinite crash-restart loop.
 */
@Service(Service.Level.APP)
public final class AdapterProcessService implements WechatProcessApi, Disposable {
    public enum State { OFFLINE, STARTING, RUNNING, STOPPING }

    @FunctionalInterface
    public interface Launcher {
        Process launch(List<String> command, Map<String, String> env, File dir,
                       Consumer<String> stdout, Consumer<String> stderr) throws IOException;
    }

    @FunctionalInterface
    public interface NodeResolver {
        NodeRuntime resolve() throws Exception;
    }

    public record NodeRuntime(String path, int majorVersion, String version) {
    }

    static final String READY_PREFIX = "CCGUI_ADAPTER_READY ";
    static final int START_TIMEOUT_MS = 20_000;
    static final int STOP_WAIT_MS = 5_000;
    static final String NODE_PATH_PROPERTY = "claude.code.node.path";

    private static final Logger LOG = Logger.getInstance(AdapterProcessService.class);
    private static final SecureRandom RANDOM = new SecureRandom();

    private final Launcher launcher;
    private final NodeResolver nodeResolver;
    private final File bundleFile;
    private final String stateDir;
    private final String discoveryPath;
    private final ExecutorService executor = Executors.newCachedThreadPool(r -> {
        Thread t = new Thread(r, "ccgui-adapter-process");
        t.setDaemon(true);
        return t;
    });
    private final CopyOnWriteArrayList<Consumer<State>> listeners = new CopyOnWriteArrayList<>();

    private volatile State state = State.OFFLINE;
    private volatile Process process;
    private volatile String controlBaseUrl;
    private volatile String controlToken;
    private volatile String lastError;
    private volatile boolean shuttingDown;

    /** IntelliJ service constructor. */
    public AdapterProcessService() {
        this(defaultLauncher(), defaultNodeResolver(), resolveBundleFile(), resolveStateDir(), resolveDiscoveryPath());
    }

    AdapterProcessService(Launcher launcher, NodeResolver nodeResolver, File bundleFile,
                          String stateDir, String discoveryPath) {
        this.launcher = launcher;
        this.nodeResolver = nodeResolver;
        this.bundleFile = bundleFile;
        this.stateDir = stateDir;
        this.discoveryPath = discoveryPath;
    }

    public static AdapterProcessService getInstance() {
        return ApplicationManager.getApplication().getService(AdapterProcessService.class);
    }

    public void addListener(Consumer<State> listener) {
        listeners.add(listener);
    }

    public void removeListener(Consumer<State> listener) {
        listeners.remove(listener);
    }

    /** Test seam: number of registered state listeners. */
    int listenerCountForTest() {
        return listeners.size();
    }

    @Override
    public State state() {
        return state;
    }

    @Override
    public String lastError() {
        return lastError;
    }

    @Override
    public String controlBaseUrl() {
        return controlBaseUrl;
    }

    @Override
    public String controlToken() {
        return controlToken;
    }

    public synchronized CompletableFuture<State> retry() {
        state = State.OFFLINE;
        controlBaseUrl = null;
        notifyListeners();
        return start();
    }

    @Override
    public synchronized CompletableFuture<State> start() {
        if (state == State.RUNNING || state == State.STARTING) {
            return CompletableFuture.completedFuture(state);
        }
        if (bundleFile == null || !bundleFile.isFile()) {
            lastError = bundleFile == null
                    ? "Adapter bundle not found or unverified; see IDE log for details"
                    : "Adapter bundle not found: " + bundleFile;
            state = State.OFFLINE;
            notifyListeners();
            return CompletableFuture.completedFuture(state);
        }
        state = State.STARTING;
        lastError = null;
        notifyListeners();
        try {
            return CompletableFuture.supplyAsync(() -> {
                try {
                    NodeRuntime node = nodeResolver.resolve();
                    LOG.info("[adapter] Node resolved: " + node.path() + " (" + node.version() + ")");
                    if (node.majorVersion() < 22) {
                        lastError = "微信远程需要 Node.js 22 或更高版本；当前检测版本 " + node.version()
                                + "；当前检测路径 " + node.path();
                        LOG.warn("[adapter] " + lastError);
                        state = State.OFFLINE;
                        notifyListeners();
                        return state;
                    }
                    String token = randomToken();
                    Map<String, String> env = new HashMap<>(System.getenv());
                    env.put("CCGUI_ADAPTER_CONTROL_TOKEN", token);
                    env.put("CCGUI_ADAPTER_PARENT_PID", String.valueOf(ProcessHandle.current().pid()));
                    env.put("CCGUI_ADAPTER_STATE_DIR", stateDir);
                    env.put("CCGUI_ADAPTER_DISCOVERY", discoveryPath);
                    BlockingQueue<String> stdoutLines = new LinkedBlockingQueue<>();
                    Process launched = launcher.launch(
                            List.of(node.path(), bundleFile.getAbsolutePath()),
                            env,
                            bundleFile.getParentFile(),
                            stdoutLines::add,
                            line -> LOG.info("[adapter] " + line));
                    String readyLine = null;
                    long deadline = System.currentTimeMillis() + START_TIMEOUT_MS;
                    while (System.currentTimeMillis() < deadline) {
                        String line = stdoutLines.poll(500, TimeUnit.MILLISECONDS);
                        if (line != null && line.startsWith(READY_PREFIX)) {
                            readyLine = line;
                            break;
                        }
                        if (line != null) {
                            LOG.info("[adapter] " + line);
                        }
                        if (!launched.isAlive()) {
                            break;
                        }
                    }
                    if (readyLine == null) {
                        launched.destroyForcibly();
                        lastError = "Adapter startup timed out or exited without READY";
                        state = State.OFFLINE;
                        notifyListeners();
                        return state;
                    }
                    JsonObject ready = JsonParser.parseString(readyLine.substring(READY_PREFIX.length())).getAsJsonObject();
                    int port = ready.get("port").getAsInt();
                    process = launched;
                    controlBaseUrl = "http://127.0.0.1:" + port;
                    controlToken = token;
                    state = State.RUNNING;
                    notifyListeners();
                    launched.onExit().thenRun(() -> {
                        if (!shuttingDown && state != State.STOPPING) {
                            state = State.OFFLINE;
                            lastError = "Adapter process exited unexpectedly";
                            controlBaseUrl = null;
                            notifyListeners();
                        }
                    });
                    // Keep consuming the adapter's stdout after READY so its
                    // [outbound]/[adapter] logs stay visible in idea.log
                    // (previously the startup loop stopped draining and all
                    // later diagnostics were silently lost).
                    Thread drainer = new Thread(() -> {
                        try {
                            while (launched.isAlive() || !stdoutLines.isEmpty()) {
                                String line = stdoutLines.poll(500, TimeUnit.MILLISECONDS);
                                if (line != null) {
                                    LOG.info("[adapter] " + line);
                                }
                            }
                        } catch (InterruptedException ignored) {
                            Thread.currentThread().interrupt();
                        }
                    }, "ccgui-adapter-stdout-drain");
                    drainer.setDaemon(true);
                    drainer.start();
                    return state;
                } catch (Throwable err) {
                    // Catch Throwable, not just Exception: an Error inside the
                    // start path must never leave the service stuck in
                    // STARTING with no error surfaced to the UI.
                    LOG.error("[adapter] start failed", err);
                    lastError = err.getMessage() != null ? err.getMessage() : err.getClass().getSimpleName();
                    state = State.OFFLINE;
                    notifyListeners();
                    return state;
                }
            }, executor);
        } catch (RuntimeException re) {
            // RejectedExecutionException (or any submission failure) must not
            // leave the service stuck in STARTING.
            LOG.error("[adapter] start submission failed", re);
            lastError = "Adapter 启动失败（内部执行器不可用）";
            state = State.OFFLINE;
            notifyListeners();
            return CompletableFuture.completedFuture(state);
        }
    }

    @Override
    public synchronized CompletableFuture<Void> stop() {
        if (process == null || !process.isAlive()) {
            state = State.OFFLINE;
            controlBaseUrl = null;
            notifyListeners();
            return CompletableFuture.completedFuture(null);
        }
        shuttingDown = true;
        state = State.STOPPING;
        notifyListeners();
        return CompletableFuture.runAsync(() -> {
            try {
                requestGracefulShutdown();
                if (!process.waitFor(STOP_WAIT_MS, TimeUnit.MILLISECONDS)) {
                    process.destroy();
                    if (!process.waitFor(2_000, TimeUnit.MILLISECONDS)) {
                        process.destroyForcibly();
                    }
                }
            } catch (InterruptedException ignored) {
                process.destroyForcibly();
                Thread.currentThread().interrupt();
            } finally {
                state = State.OFFLINE;
                controlBaseUrl = null;
                shuttingDown = false;
                notifyListeners();
            }
        }, executor);
    }

    private void requestGracefulShutdown() {
        String url = controlBaseUrl;
        String token = controlToken;
        if (url == null || token == null) {
            return;
        }
        try {
            java.net.http.HttpClient client = java.net.http.HttpClient.newBuilder()
                    .connectTimeout(java.time.Duration.ofSeconds(2))
                    .build();
            java.net.http.HttpRequest request = java.net.http.HttpRequest.newBuilder()
                    .uri(java.net.URI.create(url + "/control/v1/shutdown"))
                    .header("Authorization", "Bearer " + token)
                    .POST(java.net.http.HttpRequest.BodyPublishers.noBody())
                    .timeout(java.time.Duration.ofSeconds(3))
                    .build();
            client.send(request, java.net.http.HttpResponse.BodyHandlers.discarding());
        } catch (Exception ignored) {
            // Fall back to destroy below.
        }
    }

    @Override
    public void dispose() {
        stop().join();
        executor.shutdownNow();
    }

    private void notifyListeners() {
        State current = state;
        for (Consumer<State> listener : listeners) {
            listener.accept(current);
        }
    }

    /** Test seam: fires a state notification without starting a process. */
    void notifyListenersForTest() {
        notifyListeners();
    }

    static String randomToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    static int parseNodeMajor(@Nullable String version) {
        if (version == null) {
            return 0;
        }
        String cleaned = version.trim();
        if (cleaned.startsWith("v")) {
            cleaned = cleaned.substring(1);
        }
        int dot = cleaned.indexOf('.');
        String major = dot < 0 ? cleaned : cleaned.substring(0, dot);
        try {
            return Integer.parseInt(major);
        } catch (NumberFormatException ignored) {
            return 0;
        }
    }

    static int parseEnginesMajor(@Nullable String enginesNode) {
        if (enginesNode == null) {
            return 0;
        }
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile(">=\\s*(\\d+)").matcher(enginesNode);
        return matcher.find() ? Integer.parseInt(matcher.group(1)) : 0;
    }

    private static Launcher defaultLauncher() {
        return (command, env, dir, stdout, stderr) -> {
            ProcessBuilder builder = new ProcessBuilder(command);
            builder.directory(dir);
            builder.environment().putAll(env);
            Process started = builder.start();
            Thread out = new Thread(() -> {
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(started.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        stdout.accept(line);
                    }
                } catch (IOException ignored) {
                    // Process ended.
                }
            }, "ccgui-adapter-stdout");
            out.setDaemon(true);
            out.start();
            Thread err = new Thread(() -> {
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(started.getErrorStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        stderr.accept(line);
                    }
                } catch (IOException ignored) {
                    // Process ended.
                }
            }, "ccgui-adapter-stderr");
            err.setDaemon(true);
            err.start();
            return started;
        };
    }

    private static NodeResolver defaultNodeResolver() {
        return () -> {
            NodeDetector detector = NodeDetector.getInstance();
            String overrideNode = System.getProperty("ccgui.adapter.node");
            if (overrideNode == null || overrideNode.isEmpty()) {
                overrideNode = System.getenv("CCGUI_ADAPTER_NODE");
            }
            if (overrideNode != null && !overrideNode.isEmpty()) {
                File nodeFile = new File(overrideNode);
                if (nodeFile.isFile()) {
                    String version = detector.verifyNodePath(nodeFile.getAbsolutePath());
                    if (version != null) {
                        return new NodeRuntime(nodeFile.getAbsolutePath(), parseNodeMajor(version), version);
                    }
                }
            }
            NodeDetectionResult result = null;
            String configured = PropertiesComponent.getInstance().getValue(NODE_PATH_PROPERTY);
            if (configured != null && !configured.isEmpty()) {
                result = detector.verifyAndCacheNodePath(configured);
            }
            if (result == null || !result.isFound()) {
                result = detector.detectNodeWithDetails();
            }
            if (result == null || !result.isFound() || result.getNodePath() == null) {
                throw new IllegalStateException("未找到 Node.js，请在设置中配置 Node 路径");
            }
            return new NodeRuntime(result.getNodePath(), parseNodeMajor(result.getNodeVersion()),
                    result.getNodeVersion() == null ? "unknown" : result.getNodeVersion());
        };
    }

    static File resolveBundleFile() {
        String override = System.getProperty("ccgui.adapter.dir");
        if (override == null || override.isEmpty()) {
            override = System.getenv("CCGUI_ADAPTER_DIR");
        }
        if (override != null && !override.isEmpty()) {
            File bundle = new File(override, "dist/adapter-bundle.cjs");
            if (bundle.isFile()) {
                return bundle;
            }
            return new File(override, "adapter-bundle.cjs");
        }
        return resolvePackagedBundleFile(new File(resolveStateDir(), "runtime"), AdapterArchiveLocator.locate());
    }

    /**
     * Production bundle resolution body (package-private test seam): resolves
     * and verifies the packaged adapter bundle.
     *
     * <p>Returns {@code null} on ANY failure so start() can never execute a
     * stale or unverified adapter-bundle.cjs from a previous install; the
     * detailed reason is logged for the OFFLINE state surfaced in the UI.
     */
    static File resolvePackagedBundleFile(File runtimeDir, AdapterArchiveLocator.AdapterResources resources) {
        try {
            if (resources == null || !resources.zipFile.isFile()) {
                throw new IllegalStateException("adapter.zip not found in plugin directory");
            }
            String packagedHash = readPackagedHash(resources.hashFile);
            if (!isValidHex64(packagedHash)) {
                throw new IllegalStateException(
                        "packaged adapter.hash missing or malformed; refusing to run an unverified bundle");
            }
            return resolveBundleFromPackagedResources(runtimeDir, packagedHash, resources.zipFile);
        } catch (IllegalStateException err) {
            // Warn level (not error): the IntelliJ test logger fails tests on
            // error-level messages, and the UI already surfaces OFFLINE with a
            // diagnostic lastError; the log line stays explicit.
            LOG.warn("[adapter] packaged bundle resolution failed; refusing to run any bundle: " + err.getMessage());
            return null;
        }
    }

    /**
     * Reads the packaged adapter.hash file next to adapter.zip in the plugin
     * directory. Returns null when the file is absent or unreadable.
     */
    static String readPackagedHash(File hashFile) {
        if (hashFile == null || !hashFile.isFile()) {
            return null;
        }
        try (InputStream in = Files.newInputStream(hashFile.toPath())) {
            String hash = new String(in.readAllBytes(), StandardCharsets.UTF_8).trim();
            return hash.isEmpty() ? null : hash;
        } catch (IOException err) {
            LOG.warn("failed to read adapter.hash: " + err.getMessage());
            return null;
        }
    }

    /** True when the value is a 64-character lowercase/uppercase hex digest. */
    static boolean isValidHex64(String hash) {
        return hash != null && hash.matches("[0-9a-fA-F]{64}");
    }

    /**
     * True when the file's SHA-256 equals the expected hash. The hash object
     * contract is adapter-bundle.cjs (never adapter.zip).
     */
    static boolean bundleMatchesHash(File bundle, String expectedHash) {
        if (bundle == null || !bundle.isFile() || expectedHash == null || expectedHash.isEmpty()) {
            return false;
        }
        try {
            return expectedHash.equalsIgnoreCase(sha256(bundle));
        } catch (IOException err) {
            LOG.warn("failed to hash adapter bundle: " + err.getMessage());
            return false;
        }
    }

    /**
     * Production bundle resolution from the located packaged files: reuses the
     * extracted bundle only when its hash matches the packaged adapter.hash,
     * otherwise replaces it from the packaged adapter.zip and verifies again.
     * Fails closed when the hash is missing/malformed or the archive is absent.
     */
    static File resolveBundleFromPackagedResources(File runtimeDir, String packagedHash, File zipFile) {
        if (!isValidHex64(packagedHash)) {
            throw new IllegalStateException(
                    "packaged adapter.hash missing or malformed; refusing to run an unverified bundle");
        }
        File bundle = new File(runtimeDir, "adapter-bundle.cjs");
        if (bundle.isFile() && bundleMatchesHash(bundle, packagedHash)) {
            return bundle;
        }
        if (zipFile == null || !zipFile.isFile()) {
            throw new IllegalStateException("adapter.zip not found; cannot restore adapter bundle");
        }
        try (InputStream in = Files.newInputStream(zipFile.toPath())) {
            return resolvePackagedBundle(runtimeDir, packagedHash, in);
        } catch (IOException err) {
            throw new IllegalStateException("adapter.zip extraction failed: " + err.getMessage(), err);
        }
    }

    /**
     * Testable core: reuses {@code runtimeDir}/adapter-bundle.cjs when it
     * matches {@code packagedHash}, otherwise extracts {@code zipSource} to a
     * same-directory temporary file, verifies the SHA-256 gate and atomically
     * moves the verified bundle into place. The provided stream is always
     * closed by this method.
     */
    static File resolvePackagedBundle(File runtimeDir, String packagedHash, InputStream zipSource)
            throws IOException {
        if (!isValidHex64(packagedHash)) {
            throw new IllegalStateException(
                    "packaged adapter.hash missing or malformed; refusing to run an unverified bundle");
        }
        try (InputStream source = zipSource) {
            File bundle = new File(runtimeDir, "adapter-bundle.cjs");
            if (bundle.isFile() && bundleMatchesHash(bundle, packagedHash)) {
                return bundle;
            }
            if (bundle.isFile()) {
                LOG.warn("adapter.hash mismatch; deleting stale bundle: " + bundle.getAbsolutePath());
                bundle.delete();
            }
            return extractAndVerifyBundle(runtimeDir, source, packagedHash);
        }
    }

    /**
     * Extracts adapter.zip into {@code runtimeDir}, writing only
     * adapter-bundle.cjs to a same-directory temporary file first, verifying
     * its SHA-256 against the packaged hash, then atomically replacing the
     * final bundle. Any failure deletes the temporary file and never leaves a
     * partially written or unverified bundle at the final path.
     */
    private static File extractAndVerifyBundle(File runtimeDir, InputStream zipSource, String packagedHash)
            throws IOException {
        runtimeDir.mkdirs();
        Path runtimeRoot = runtimeDir.toPath().toAbsolutePath().normalize();
        File temp = File.createTempFile("adapter-bundle.cjs.tmp-", ".tmp", runtimeDir);
        boolean moved = false;
        try {
            try (ZipInputStream zip = new ZipInputStream(zipSource)) {
                ZipEntry entry;
                while ((entry = zip.getNextEntry()) != null) {
                    Path target = safeResolve(runtimeRoot, entry.getName());
                    if (target == null) {
                        throw new IOException("Zip entry escapes runtime directory: " + entry.getName());
                    }
                    if (entry.isDirectory()) {
                        Files.createDirectories(target);
                        continue;
                    }
                    if (target.getFileName().toString().equals("adapter-bundle.cjs")) {
                        Files.copy(zip, temp.toPath(), StandardCopyOption.REPLACE_EXISTING);
                    } else {
                        Files.createDirectories(target.getParent());
                        Files.copy(zip, target, StandardCopyOption.REPLACE_EXISTING);
                    }
                }
            }
            if (!temp.isFile() || temp.length() == 0) {
                throw new IllegalStateException(
                        "adapter.zip extraction did not produce adapter-bundle.cjs in " + runtimeDir);
            }
            String actualHash = sha256(temp);
            if (!packagedHash.equalsIgnoreCase(actualHash)) {
                throw new IllegalStateException(
                        "Extracted adapter bundle hash mismatch vs packaged adapter.hash; bundle deleted: "
                                + temp.getAbsolutePath());
            }
            try {
                Files.move(temp.toPath(), runtimeRoot.resolve("adapter-bundle.cjs"),
                        StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException err) {
                Files.move(temp.toPath(), runtimeRoot.resolve("adapter-bundle.cjs"),
                        StandardCopyOption.REPLACE_EXISTING);
            }
            moved = true;
            return new File(runtimeDir, "adapter-bundle.cjs");
        } finally {
            if (!moved) {
                Files.deleteIfExists(temp.toPath());
            }
        }
    }

    /**
     * Zip-slip protection based on normalized paths: rejects absolute entries
     * and entries whose normalized target escapes the runtime root.
     */
    static Path safeResolve(Path runtimeRoot, String entryName) {
        if (entryName == null || runtimeRoot == null) {
            return null;
        }
        String normalizedName = entryName.replace('\\', '/');
        if (normalizedName.startsWith("/") || normalizedName.startsWith("\\")) {
            return null;
        }
        Path target = runtimeRoot.resolve(normalizedName).normalize();
        return target.startsWith(runtimeRoot) ? target : null;
    }

    private static String sha256(File file) throws IOException {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(Files.readAllBytes(file.toPath()));
            StringBuilder sb = new StringBuilder(hash.length * 2);
            for (byte b : hash) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException err) {
            throw new IOException(err);
        }
    }

    private static String resolveStateDir() {
        return PlatformUtils.getHomeDirectory() + File.separator + ".codemoss" + File.separator + "ccgui-adapter";
    }

    private static String resolveDiscoveryPath() {
        return PlatformUtils.getHomeDirectory() + File.separator + ".codemoss" + File.separator + "remote-gateway.json";
    }

    static List<String> readBundleCandidates(File dir) {
        List<String> candidates = new ArrayList<>();
        candidates.add(new File(dir, "dist/adapter-bundle.cjs").getAbsolutePath());
        candidates.add(new File(dir, "adapter-bundle.cjs").getAbsolutePath());
        return candidates;
    }
}
