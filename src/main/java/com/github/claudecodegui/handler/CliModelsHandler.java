package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.provider.dsh.DshEnvSupport;
import com.github.claudecodegui.settings.CodemossSettingsService;
import com.github.claudecodegui.startup.BridgePreloader;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * Lists models for headless CLI providers (Kimi / OpenCode) via channel-manager.
 *
 * <p>Frontend: {@code sendToJava('get_cli_models:opencode')} →
 * {@code window.setCliModels({ provider, models, ... })}.
 */
public class CliModelsHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(CliModelsHandler.class);
    private static final String CHANNEL_SCRIPT = "channel-manager.js";
    private static final long TIMEOUT_SECONDS = 50L;
    /** Cap on captured stdout — a model list is small; this stops memory exhaustion. */
    private static final int MAX_OUTPUT_CHARS = 64_000;

    /**
     * Collapses concurrent get_cli_models for the same provider + cache
     * generation into one cold start: webview remounts and reloads can fire
     * several requests before the first uncached listModels lands, and each
     * duplicate would otherwise spawn its own node + SDK process (~2s).
     * Keyed by generation so a request after an invalidation never joins a
     * pre-invalidation flight.
     */
    private static final ConcurrentHashMap<String, CompletableFuture<Void>> IN_FLIGHT = new ConcurrentHashMap<>();

    /**
     * Dedicated pool for cold-start fetches. Followers block in
     * {@link CompletableFuture#join}/{@code get} on the app executor while
     * waiting for the leader, so running the leader on that same bounded pool
     * could starve it of threads entirely; this pool guarantees the leader
     * always gets a thread no matter how many followers are parked.
     */
    private static final java.util.concurrent.ExecutorService FETCH_EXECUTOR =
            java.util.concurrent.Executors.newCachedThreadPool(r -> {
                Thread thread = new Thread(r, "cli-models-fetch");
                thread.setDaemon(true);
                return thread;
            });

    private static final String[] SUPPORTED_TYPES = {
            "get_cli_models",
    };

    private static final Set<String> SUPPORTED_PROVIDERS = Set.of(
            "opencode", "kimi", "pi", "omp", "codex", "grok", "dsh", "codebuddy", "minimax"
    );

    private final Gson gson = new Gson();
    private final NodeDetector nodeDetector = NodeDetector.getInstance();
    private final EnvironmentConfigurator envConfigurator = new EnvironmentConfigurator();

    public CliModelsHandler(HandlerContext context) {
        super(context);
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        if (!"get_cli_models".equals(type)) {
            return false;
        }
        String provider = content != null ? content.trim().toLowerCase(Locale.ROOT) : "";
        if (!SUPPORTED_PROVIDERS.contains(provider)) {
            pushError(provider, "Unsupported CLI provider for model list: " + provider);
            return true;
        }
        CompletableFuture.runAsync(() -> listModels(provider, 0), AppExecutorUtil.getAppExecutorService());
        return true;
    }

    private void listModels(String provider, int retryDepth) {
        try {
            if ("codebuddy".equals(provider)
                    && !new CodemossSettingsService().isCodeBuddyLocalConfigAuthorized()) {
                pushError(provider, ClaudeCodeGuiBundle.message("error.codebuddyLocalConfigRequired"),
                        "CODEBUDDY_LOCAL_CONFIG_REQUIRED");
                return;
            }
            // A fresh cached catalog saves the 2-5s node + SDK cold start on
            // repeat requests; the authorization check above still runs first.
            String cachedPayload = CliModelsCache.get(provider);
            if (cachedPayload != null) {
                LOG.debug("[CliModels] Serving cached catalog for " + provider);
                callJavaScript("window.setCliModels", escapeJs(cachedPayload));
                return;
            }
            long generation = CliModelsCache.generation(provider);
            // Stale-while-revalidate: an expired entry still beats a blank
            // picker — serve it now; the refresh below replaces it when the
            // fresh payload lands. The entry is at most one TTL old.
            String stalePayload = CliModelsCache.getStale(provider);
            if (stalePayload != null) {
                LOG.debug("[CliModels] Serving stale catalog while refreshing " + provider);
                callJavaScript("window.setCliModels", escapeJs(stalePayload));
            }
            CompletableFuture<Void> created = new CompletableFuture<>();
            String flightKey = provider + "#" + generation;
            CompletableFuture<Void> flight = IN_FLIGHT.computeIfAbsent(flightKey, k -> {
                FETCH_EXECUTOR.execute(() -> {
                    try {
                        fetchAndPushModels(provider, generation);
                    } catch (Exception e) {
                        LOG.warn("[CliModels] Failed for " + provider + ": " + e.getMessage(), e);
                    } finally {
                        created.complete(null);
                    }
                });
                created.whenComplete((v, t) -> IN_FLIGHT.remove(flightKey, created));
                return created;
            });
            if (flight != created) {
                // A sibling request for the same provider is already
                // cold-starting — wait for it instead of spawning a duplicate
                // node process, then forward the cached result (the leader's
                // direct push may have landed before this surface registered
                // its listener). Bounded so a wedged leader fails this surface
                // instead of hanging it past the webview's own timeout.
                try {
                    flight.get(TIMEOUT_SECONDS + 10L, TimeUnit.SECONDS);
                } catch (java.util.concurrent.TimeoutException timeout) {
                    pushError(provider, "list models timed out");
                    return;
                }
                String refreshed = CliModelsCache.get(provider);
                if (refreshed != null) {
                    LOG.debug("[CliModels] Forwarding catalog refreshed by a concurrent request for " + provider);
                    callJavaScript("window.setCliModels", escapeJs(refreshed));
                } else if (retryDepth == 0) {
                    // The leader finished without caching (error path) — this
                    // surface still needs its own outcome; retry once as a
                    // fresh leader.
                    listModels(provider, retryDepth + 1);
                } else {
                    // Retried once and still no cached outcome (e.g. landed as
                    // a follower of another failed flight) — push a terminal
                    // error so the dropdown stops spinning instead of waiting
                    // for the webview's own timeout.
                    pushError(provider, "list models failed");
                }
            }
        } catch (Exception e) {
            LOG.warn("[CliModels] Failed for " + provider + ": " + e.getMessage(), e);
            pushError(provider, e.getMessage() != null ? e.getMessage() : "list models failed");
        }
    }

    /**
     * Runs the real channel-manager listModels and pushes the result. The
     * generation captured when the request started guards both the cache put
     * and the push: if models.json was saved (or consent revoked) while this
     * cold start ran, the invalidation-triggering request owns the answer and
     * this pre-edit payload is dropped instead of flickering stale data.
     */
    private void fetchAndPushModels(String provider, long generation) {
        try {
            String node = nodeDetector.findNodeExecutable();
            BridgeDirectoryResolver resolver = BridgePreloader.getSharedResolver();
            File bridgeDir = resolver != null ? resolver.findSdkDir() : null;
            if (bridgeDir == null || !bridgeDir.exists()) {
                pushError(provider, "Bridge directory not ready");
                return;
            }

            File script = new File(bridgeDir, CHANNEL_SCRIPT);
            if (!script.exists()) {
                pushError(provider, "channel-manager.js not found");
                return;
            }

            List<String> command = new ArrayList<>(NodeDetector.buildNodeScriptCommand(
                    node, script.getAbsolutePath()));
            command.add(provider);
            command.add("listModels");

            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(bridgeDir);
            pb.redirectErrorStream(true);
            Map<String, String> env = pb.environment();
            envConfigurator.updateProcessEnvironment(pb, node);
            if ("dsh".equals(provider)) {
                // DSH model catalog comes from the live host — honor the
                // configured origin so the picker reflects the actual server.
                DshEnvSupport.inject(env, new CodemossSettingsService());
            }

            LOG.info("[CliModels] Listing models for " + provider + ": " + String.join(" ", command));

            Process process = pb.start();
            // Drain stdout on a daemon thread (bounded) so a verbose child cannot
            // deadlock on a full pipe buffer while this thread enforces the timeout.
            StringBuilder output = new StringBuilder();
            Thread readerThread = new Thread(() -> {
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        synchronized (output) {
                            if (output.length() < MAX_OUTPUT_CHARS) {
                                output.append(line).append('\n');
                            }
                        }
                    }
                } catch (Exception ignored) {
                }
            });
            readerThread.setDaemon(true);
            readerThread.start();

            boolean finished = process.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                pushError(provider, "Timed out listing " + provider + " models");
                return;
            }
            // Process exited; the reader hits EOF promptly — join for the final lines.
            readerThread.join(2000L);

            JsonObject payload = extractJsonObject(output.toString());
            if (payload == null) {
                pushError(provider, "No model list JSON in " + provider + " listModels output");
                return;
            }
            if (payload.has("debug") && payload.get("debug").isJsonObject()) {
                // Bridge-side diagnostics (e.g. empty model parse, fallback source)
                LOG.warn("[CliModels] " + provider + " listModels debug: " + payload.get("debug"));
            }
            if (!payload.has("provider") || payload.get("provider").isJsonNull()) {
                payload.addProperty("provider", provider);
            }
            String payloadJson = gson.toJson(payload);
            if (CliModelsCache.generation(provider) != generation) {
                LOG.debug("[CliModels] Dropping superseded catalog for " + provider
                        + " — an invalidation landed during the cold start");
                return;
            }
            if (payload.has("success") && payload.get("success").isJsonPrimitive()
                    && payload.get("success").getAsBoolean()) {
                // Only success payloads are cached — error pushes must always
                // reflect the next real attempt.
                CliModelsCache.put(provider, payloadJson, generation);
            }
            callJavaScript("window.setCliModels", escapeJs(payloadJson));
        } catch (Exception e) {
            LOG.warn("[CliModels] Failed for " + provider + ": " + e.getMessage(), e);
            pushError(provider, e.getMessage() != null ? e.getMessage() : "list models failed");
        }
    }

    private JsonObject extractJsonObject(String raw) {
        if (raw == null || raw.isEmpty()) {
            return null;
        }
        // Prefer last JSON object line (channel-manager may print diagnostics to stdout).
        String[] lines = raw.split("\\R");
        for (int i = lines.length - 1; i >= 0; i--) {
            String line = lines[i].trim();
            if (!line.startsWith("{") || !line.endsWith("}")) {
                continue;
            }
            try {
                JsonObject obj = gson.fromJson(line, JsonObject.class);
                if (obj != null && (obj.has("models") || obj.has("success"))) {
                    return obj;
                }
            } catch (Exception ignored) {
            }
        }
        // Fallback: whole buffer
        try {
            int start = raw.lastIndexOf('{');
            int end = raw.lastIndexOf('}');
            if (start >= 0 && end > start) {
                return gson.fromJson(raw.substring(start, end + 1), JsonObject.class);
            }
        } catch (Exception ignored) {
        }
        return null;
    }

    private void pushError(String provider, String message) {
        pushError(provider, message, null);
    }

    private void pushError(String provider, String message, String errorCode) {
        JsonObject error = new JsonObject();
        error.addProperty("success", false);
        error.addProperty("provider", provider != null ? provider : "");
        error.addProperty("error", message != null ? message : "unknown error");
        if (errorCode != null && !errorCode.isBlank()) {
            error.addProperty("errorCode", errorCode);
        }
        error.add("models", gson.toJsonTree(new ArrayList<>()));
        callJavaScript("window.setCliModels", escapeJs(gson.toJson(error)));
    }
}
