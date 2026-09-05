package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;
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

    private static final String[] SUPPORTED_TYPES = {
            "get_cli_models",
    };

    private static final Set<String> SUPPORTED_PROVIDERS = Set.of(
            "opencode", "kimi", "pi", "omp", "codex", "grok", "dsh", "mimo"
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
        CompletableFuture.runAsync(() -> listModels(provider), AppExecutorUtil.getAppExecutorService());
        return true;
    }

    private void listModels(String provider) {
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
            callJavaScript("window.setCliModels", escapeJs(gson.toJson(payload)));
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
        JsonObject error = new JsonObject();
        error.addProperty("success", false);
        error.addProperty("provider", provider != null ? provider : "");
        error.addProperty("error", message != null ? message : "unknown error");
        error.add("models", gson.toJsonTree(new ArrayList<>()));
        callJavaScript("window.setCliModels", escapeJs(gson.toJson(error)));
    }
}
