package com.github.claudecodegui.handler.provider;

import com.github.claudecodegui.handler.CliModelsCache;
import com.github.claudecodegui.bridge.BridgeDirectoryResolver;
import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.i18n.ClaudeCodeGuiBundle;
import com.github.claudecodegui.startup.BridgePreloader;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;

/** Handles CodeBuddy's explicit local-configuration consent. */
public class CodeBuddyProviderOperations {

    private static final Logger LOG = Logger.getInstance(CodeBuddyProviderOperations.class);
    private static final Gson GSON = new Gson();
    private static final Gson PRETTY_GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final String CHANNEL_SCRIPT = "channel-manager.js";
    private static final long AUTH_TIMEOUT_SECONDS = 12L;
    private static final long STATUS_CACHE_TTL_MILLIS = 30_000L;
    private static final String MODELS_CONFIG_CALLBACK = "window.updateCodeBuddyModelsConfig";
    /** Serializes models.json writes — saves run on the shared app pool. */
    private static final Object MODELS_FILE_LOCK = new Object();

    private final HandlerContext context;
    private final NodeDetector nodeDetector = NodeDetector.getInstance();
    private final EnvironmentConfigurator envConfigurator = new EnvironmentConfigurator();
    private volatile JsonObject cachedStatus;
    private volatile long cachedStatusAt;

    public CodeBuddyProviderOperations(HandlerContext context) {
        this.context = context;
    }

    public void handleGetLocalConfigStatus() {
        AppExecutorUtil.getAppExecutorService().execute(() -> {
            JsonObject status = getCachedStatus();
            if (status == null) {
                status = buildStatus(true);
                cacheStatus(status);
            }
            pushStatus(status);
        });
    }

    public void handleAuthorizeLocalConfig() {
        AppExecutorUtil.getAppExecutorService().execute(() -> {
            // Authorization is the one operation that must actively verify the
            // CLI login state, even before local-config consent is granted.
            JsonObject status = buildStatus(true, true);
            if (status.has("authenticated") && status.get("authenticated").getAsBoolean()
                    && status.has("configAvailable") && status.get("configAvailable").getAsBoolean()) {
                try {
                    context.getSettingsService().setCodeBuddyLocalConfigAuthorized(true);
                    status.addProperty("authorized", true);
                } catch (Exception e) {
                    LOG.warn("[CodeBuddy] Failed to persist local config authorization: " + e.getMessage());
                    status.addProperty("success", false);
                    status.addProperty("error", e.getMessage() != null ? e.getMessage() : "authorization failed");
                }
            } else if (!status.has("errorCode") || status.get("errorCode").isJsonNull()) {
                status.addProperty("errorCode", "CODEBUDDY_LOGIN_REQUIRED");
            }
            cacheStatus(status);
            pushStatus(status);
        });
    }

    public void handleRevokeLocalConfig() {
        AppExecutorUtil.getAppExecutorService().execute(() -> {
            try {
                context.getSettingsService().setCodeBuddyLocalConfigAuthorized(false);
                CliModelsCache.invalidate("codebuddy");
                JsonObject status = buildStatus(false);
                status.addProperty("authorized", false);
                cacheStatus(status);
                pushStatus(status);
            } catch (Exception e) {
                LOG.warn("[CodeBuddy] Failed to revoke local config authorization: " + e.getMessage());
                JsonObject status = new JsonObject();
                status.addProperty("success", false);
                status.addProperty("authorized", false);
                status.addProperty("error", e.getMessage() != null ? e.getMessage() : "revoke failed");
                pushStatus(status);
            }
        });
    }

    public void handleGetModelsConfig() {
        AppExecutorUtil.getAppExecutorService().execute(() -> {
            JsonObject payload;
            try {
                if (!isAuthorized()) {
                    payload = modelsConfigError("CODEBUDDY_LOCAL_CONFIG_REQUIRED",
                            ClaudeCodeGuiBundle.message("error.codebuddyLocalConfigRequired"));
                } else {
                    payload = readEffectiveModelsConfig();
                }
            } catch (Exception e) {
                LOG.warn("[CodeBuddy] Failed to read models.json: " + e.getMessage());
                payload = modelsConfigError(null, e.getMessage() != null ? e.getMessage()
                        : ClaudeCodeGuiBundle.message("error.codebuddyModelsReadFailed"));
            }
            pushModelsConfig(payload);
        });
    }

    public void handleSaveModelsConfig(String content) {
        AppExecutorUtil.getAppExecutorService().execute(() -> {
            JsonObject payload;
            // Saves run on the shared app pool; two overlapping saves would
            // otherwise interleave writes to the same models.json.tmp file.
            synchronized (MODELS_FILE_LOCK) {
                try {
                    if (!isAuthorized()) {
                        payload = modelsConfigError("CODEBUDDY_LOCAL_CONFIG_REQUIRED",
                                ClaudeCodeGuiBundle.message("error.codebuddyLocalConfigRequired"));
                    } else {
                        JsonObject request = content == null || content.isBlank()
                                ? new JsonObject()
                                : GSON.fromJson(content, JsonObject.class);
                        applyModelsConfigChanges(request);
                        // The post-save refetch must see the edited models.json,
                        // not the TTL-cached get_cli_models catalog.
                        CliModelsCache.invalidate("codebuddy");
                        payload = readEffectiveModelsConfig();
                        payload.addProperty("saved", true);
                    }
                } catch (Exception e) {
                    LOG.warn("[CodeBuddy] Failed to save models.json: " + e.getMessage());
                    payload = modelsConfigError(null, e.getMessage() != null ? e.getMessage()
                            : ClaudeCodeGuiBundle.message("error.codebuddyModelsWriteFailed"));
                }
            }
            pushModelsConfig(payload);
        });
    }

    private JsonObject buildStatus(boolean probeAuthentication) {
        return buildStatus(probeAuthentication, false);
    }

    private JsonObject buildStatus(boolean probeAuthentication, boolean forceAuthenticationProbe) {
        JsonObject status = new JsonObject();
        status.addProperty("provider", "codebuddy");
        status.addProperty("authorized", isAuthorized());
        boolean configAvailable = hasLocalConfig();
        status.addProperty("configAvailable", configAvailable);
        status.addProperty("authenticated", false);

        if (!configAvailable) {
            status.addProperty("success", true);
            status.addProperty("errorCode", "CODEBUDDY_LOGIN_REQUIRED");
            return status;
        }
        if (!probeAuthentication) {
            status.addProperty("success", true);
            return status;
        }
        // Reading the local configuration card must not trigger a CLI login
        // probe when the user has not granted access yet.
        if (!forceAuthenticationProbe && !status.get("authorized").getAsBoolean()) {
            status.addProperty("success", true);
            return status;
        }

        JsonObject auth = runAuthStatus();
        if (auth != null) {
            if (auth.has("success")) {
                status.add("success", auth.get("success"));
            }
            if (auth.has("authenticated")) {
                status.add("authenticated", auth.get("authenticated"));
            }
            if (auth.has("userName")) {
                status.add("userName", auth.get("userName"));
            }
            if (auth.has("errorCode")) {
                status.add("errorCode", auth.get("errorCode"));
            }
            if (auth.has("error")) {
                status.add("error", auth.get("error"));
            }
        } else {
            status.addProperty("success", false);
            status.addProperty("error", ClaudeCodeGuiBundle.message("error.codebuddyAuthStatusUnavailable"));
        }
        return status;
    }

    private JsonObject readEffectiveModelsConfig() throws Exception {
        Path userFile = getCodeBuddyHome().resolve("models.json");
        Path projectFile = getProjectModelsFile();
        Map<String, JsonObject> models = new LinkedHashMap<>();
        readModelsInto(models, userFile, "user");
        if (projectFile != null) {
            readModelsInto(models, projectFile, "project");
        }

        JsonArray resultModels = new JsonArray();
        for (JsonObject model : models.values()) {
            resultModels.add(model);
        }
        JsonObject payload = new JsonObject();
        payload.addProperty("success", true);
        payload.add("models", resultModels);
        return payload;
    }

    private void readModelsInto(Map<String, JsonObject> models, Path file, String scope) throws Exception {
        if (file == null || !Files.isRegularFile(file)) {
            return;
        }
        JsonObject config = readModelsFile(file);
        if (!config.has("models") || !config.get("models").isJsonArray()) {
            return;
        }
        for (JsonElement element : config.getAsJsonArray("models")) {
            if (!element.isJsonObject()) {
                continue;
            }
            JsonObject model = copyModel(element.getAsJsonObject());
            String id = getModelId(model);
            if (id.isEmpty()) {
                continue;
            }
            model.addProperty("__ccguiScope", scope);
            models.put(id, model);
        }
    }

    private void applyModelsConfigChanges(JsonObject request) throws Exception {
        if (request == null) {
            return;
        }
        if (request.has("models") && request.get("models").isJsonArray()) {
            for (JsonElement element : request.getAsJsonArray("models")) {
                if (!element.isJsonObject()) {
                    continue;
                }
                JsonObject model = copyModel(element.getAsJsonObject());
                String id = getModelId(model);
                if (!id.isEmpty()) {
                    upsertModel(model, getScope(element.getAsJsonObject()));
                }
            }
        }
        if (request.has("deletedModels") && request.get("deletedModels").isJsonArray()) {
            for (JsonElement element : request.getAsJsonArray("deletedModels")) {
                if (!element.isJsonObject()) {
                    continue;
                }
                JsonObject deleted = element.getAsJsonObject();
                String id = getModelId(deleted);
                if (!id.isEmpty()) {
                    deleteModel(id, getScope(deleted));
                }
            }
        }
    }

    private void upsertModel(JsonObject model, String scope) throws Exception {
        Path file = getModelsFile(scope);
        JsonObject config = readModelsFile(file);
        JsonArray models = getOrCreateArray(config, "models");
        String id = getModelId(model);
        for (int i = models.size() - 1; i >= 0; i--) {
            JsonElement current = models.get(i);
            if (current.isJsonObject() && id.equals(getModelId(current.getAsJsonObject()))) {
                models.remove(i);
            }
        }
        models.add(model);
        updateAvailableModels(config, id, false);
        writeModelsFile(file, config);
    }

    private void deleteModel(String id, String scope) throws Exception {
        Path file = getModelsFile(scope);
        if (!Files.isRegularFile(file)) {
            return;
        }
        JsonObject config = readModelsFile(file);
        if (config.has("models") && config.get("models").isJsonArray()) {
            JsonArray models = config.getAsJsonArray("models");
            for (int i = models.size() - 1; i >= 0; i--) {
                JsonElement current = models.get(i);
                if (current.isJsonObject() && id.equals(getModelId(current.getAsJsonObject()))) {
                    models.remove(i);
                }
            }
        }
        updateAvailableModels(config, id, true);
        writeModelsFile(file, config);
    }

    private void updateAvailableModels(JsonObject config, String id, boolean remove) {
        if (!config.has("availableModels") || !config.get("availableModels").isJsonArray()) {
            return;
        }
        JsonArray available = config.getAsJsonArray("availableModels");
        for (int i = available.size() - 1; i >= 0; i--) {
            if (available.get(i).isJsonPrimitive() && id.equals(available.get(i).getAsString())) {
                available.remove(i);
            }
        }
        if (!remove && available.size() > 0) {
            available.add(id);
        }
    }

    private JsonArray getOrCreateArray(JsonObject object, String key) {
        if (object.has(key) && object.get(key).isJsonArray()) {
            return object.getAsJsonArray(key);
        }
        JsonArray array = new JsonArray();
        object.add(key, array);
        return array;
    }

    private JsonObject readModelsFile(Path file) throws Exception {
        if (!Files.isRegularFile(file)) {
            return new JsonObject();
        }
        String raw = Files.readString(file, StandardCharsets.UTF_8);
        JsonObject parsed = GSON.fromJson(raw, JsonObject.class);
        return parsed != null ? parsed : new JsonObject();
    }

    private void writeModelsFile(Path file, JsonObject config) throws Exception {
        Files.createDirectories(file.getParent());
        Path temp = file.resolveSibling(file.getFileName() + ".tmp");
        Files.writeString(temp, PRETTY_GSON.toJson(config), StandardCharsets.UTF_8);
        try {
            Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (java.nio.file.AtomicMoveNotSupportedException e) {
            Files.move(temp, file, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private JsonObject copyModel(JsonObject source) {
        JsonObject copy = new JsonObject();
        for (Map.Entry<String, JsonElement> entry : source.entrySet()) {
            if (!"__ccguiScope".equals(entry.getKey())) {
                copy.add(entry.getKey(), entry.getValue().deepCopy());
            }
        }
        return copy;
    }

    private String getModelId(JsonObject model) {
        if (model == null || !model.has("id") || model.get("id").isJsonNull()) {
            return "";
        }
        try {
            return model.get("id").getAsString().trim();
        } catch (Exception ignored) {
            return "";
        }
    }

    private String getScope(JsonObject model) {
        if (model != null && model.has("__ccguiScope") && !model.get("__ccguiScope").isJsonNull()) {
            String scope = model.get("__ccguiScope").getAsString().trim().toLowerCase(Locale.ROOT);
            if ("project".equals(scope)) {
                return scope;
            }
        }
        return "user";
    }

    private Path getModelsFile(String scope) {
        if ("project".equals(scope) && getProjectModelsFile() != null) {
            return getProjectModelsFile();
        }
        return getCodeBuddyHome().resolve("models.json");
    }

    private Path getCodeBuddyHome() {
        String configured = System.getenv("CODEBUDDY_HOME");
        String home = configured != null && !configured.isBlank()
                ? configured.trim()
                : NodeDetector.resolveHomeForFileOps() + File.separator + ".codebuddy";
        return Path.of(home);
    }

    private Path getProjectModelsFile() {
        if (context.getProject() == null || context.getProject().getBasePath() == null) {
            return null;
        }
        return Path.of(context.getProject().getBasePath(), ".codebuddy", "models.json");
    }

    private JsonObject modelsConfigError(String errorCode, String message) {
        JsonObject payload = new JsonObject();
        payload.addProperty("success", false);
        if (errorCode != null) {
            payload.addProperty("errorCode", errorCode);
        }
        payload.addProperty("error", message);
        payload.add("models", new JsonArray());
        return payload;
    }

    private JsonObject getCachedStatus() {
        JsonObject status = cachedStatus;
        if (status == null || System.currentTimeMillis() - cachedStatusAt > STATUS_CACHE_TTL_MILLIS) {
            return null;
        }
        return GSON.fromJson(GSON.toJson(status), JsonObject.class);
    }

    private void cacheStatus(JsonObject status) {
        cachedStatus = status != null
                ? GSON.fromJson(GSON.toJson(status), JsonObject.class)
                : null;
        cachedStatusAt = status != null ? System.currentTimeMillis() : 0L;
    }

    private boolean isAuthorized() {
        try {
            return context.getSettingsService().isCodeBuddyLocalConfigAuthorized();
        } catch (Exception e) {
            LOG.warn("[CodeBuddy] Failed to read local config authorization: " + e.getMessage());
            return false;
        }
    }

    private boolean hasLocalConfig() {
        return context.getSettingsService().hasCodeBuddyLocalConfig();
    }

    private JsonObject runAuthStatus() {
        try {
            BridgeDirectoryResolver resolver = BridgePreloader.getSharedResolver();
            File bridgeDir = resolver != null ? resolver.findSdkDir() : null;
            if (bridgeDir == null || !bridgeDir.exists()) {
                return error("Bridge directory not ready");
            }
            File script = new File(bridgeDir, CHANNEL_SCRIPT);
            if (!script.isFile()) {
                return error("channel-manager.js not found");
            }

            String node = nodeDetector.findNodeExecutable();
            List<String> command = new ArrayList<>(NodeDetector.buildNodeScriptCommand(
                    node, script.getAbsolutePath()));
            command.add("codebuddy");
            command.add("authStatus");

            ProcessBuilder pb = new ProcessBuilder(command);
            pb.directory(bridgeDir);
            pb.redirectErrorStream(true);
            envConfigurator.updateProcessEnvironment(pb, node);
            StringBuilder output = new StringBuilder();
            Process process = pb.start();
            Thread readerThread = new Thread(() -> {
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        synchronized (output) {
                            if (output.length() < 64_000) {
                                output.append(line).append('\n');
                            }
                        }
                    }
                } catch (Exception ignored) {
                    // The process may be forcibly terminated after the timeout.
                }
            }, "codebuddy-auth-output-reader");
            readerThread.setDaemon(true);
            readerThread.start();
            boolean finished = process.waitFor(AUTH_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                process.destroyForcibly();
                readerThread.join(2_000L);
                return error("CodeBuddy authentication check timed out");
            }
            readerThread.join(2_000L);
            return extractJsonObject(output.toString());
        } catch (Exception e) {
            LOG.warn("[CodeBuddy] Authentication status check failed: " + e.getMessage());
            return error(e.getMessage() != null ? e.getMessage() : "authentication check failed");
        }
    }

    private JsonObject extractJsonObject(String raw) {
        String[] lines = raw != null ? raw.split("\\R") : new String[0];
        for (int i = lines.length - 1; i >= 0; i--) {
            String line = lines[i].trim();
            if (!line.startsWith("{") || !line.endsWith("}")) {
                continue;
            }
            try {
                JsonObject object = GSON.fromJson(line, JsonObject.class);
                if (object != null) {
                    return object;
                }
            } catch (Exception ignored) {
                // Continue searching earlier lines when diagnostics contain braces.
            }
        }
        return error("No CodeBuddy authentication status returned");
    }

    private JsonObject error(String message) {
        JsonObject object = new JsonObject();
        object.addProperty("success", false);
        object.addProperty("authenticated", false);
        object.addProperty("error", message);
        return object;
    }

    private void pushStatus(JsonObject status) {
        String json = GSON.toJson(status);
        ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript("window.updateCodeBuddyLocalConfigStatus", context.escapeJs(json)));
    }

    private void pushModelsConfig(JsonObject payload) {
        String json = GSON.toJson(payload);
        ApplicationManager.getApplication().invokeLater(() ->
                context.callJavaScript(MODELS_CONFIG_CALLBACK, context.escapeJs(json)));
    }
}
