package com.github.claudecodegui.handler;

import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.github.claudecodegui.settings.CodexMcpServerManager;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

/**
 * Codex MCP Server Handler
 * Handles MCP server management messages for Codex provider
 * Configuration is stored in ~/.codex/config.toml
 */
public class CodexMcpServerHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(CodexMcpServerHandler.class);

    private static final String[] SUPPORTED_TYPES = {
        "get_codex_mcp_servers",
        "get_codex_mcp_server_status",
        "get_codex_mcp_server_tools",
        "add_codex_mcp_server",
        "update_codex_mcp_server",
        "delete_codex_mcp_server",
        "toggle_codex_mcp_server",
        "validate_codex_mcp_server"
    };

    private final CodexMcpServerManager codexMcpServerManager;

    public CodexMcpServerHandler(HandlerContext context, CodexMcpServerManager codexMcpServerManager) {
        super(context);
        this.codexMcpServerManager = codexMcpServerManager;
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "get_codex_mcp_servers":
                handleGetMcpServers();
                return true;
            case "get_codex_mcp_server_status":
                handleGetMcpServerStatus();
                return true;
            case "get_codex_mcp_server_tools":
                handleGetMcpServerTools(content);
                return true;
            case "add_codex_mcp_server":
                handleAddMcpServer(content);
                return true;
            case "update_codex_mcp_server":
                handleUpdateMcpServer(content);
                return true;
            case "delete_codex_mcp_server":
                handleDeleteMcpServer(content);
                return true;
            case "toggle_codex_mcp_server":
                handleToggleMcpServer(content);
                return true;
            case "validate_codex_mcp_server":
                handleValidateMcpServer(content);
                return true;
            default:
                return false;
        }
    }

    /**
     * Get all Codex MCP servers from config.toml.
     * Runs file I/O in a background thread to avoid blocking the CEF IPC thread.
     */
    private void handleGetMcpServers() {
        CompletableFuture.runAsync(() -> {
            try {
                if (!isCodexLocalConfigAuthorized()) {
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("window.updateCodexMcpServers", escapeJs("[]"));
                    });
                    return;
                }

                List<JsonObject> servers = codexMcpServerManager.getMcpServers();
                Gson gson = new Gson();
                String serversJson = gson.toJson(servers);

                LOG.info("[CodexMcpServerHandler] Loaded " + servers.size() + " Codex MCP servers");

                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.updateCodexMcpServers", escapeJs(serversJson));
                });
            } catch (Exception e) {
                LOG.error("[CodexMcpServerHandler] Failed to get Codex MCP servers: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.updateCodexMcpServers", escapeJs("[]"));
                });
            }
        }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
            LOG.error("[CodexMcpServerHandler] Unexpected error in handleGetMcpServers: " + ex.getMessage(), ex);
            return null;
        });
    }

    /**
     * Get Codex MCP server connection status.
     * Validates server configuration and checks availability.
     * Runs in a background thread because status checks involve network I/O and process spawning
     * that can block for seconds per server (HTTP timeouts, `which` command execution).
     */
    private void handleGetMcpServerStatus() {
        CompletableFuture.runAsync(() -> {
            try {
                if (!isCodexLocalConfigAuthorized()) {
                    ApplicationManager.getApplication().invokeLater(() -> {
                        callJavaScript("window.updateCodexMcpServerStatus", escapeJs("[]"));
                    });
                    return;
                }

                List<JsonObject> statusList = codexMcpServerManager.getMcpServerStatus();
                Gson gson = new Gson();
                String statusJson = gson.toJson(statusList);

                LOG.info("[CodexMcpServerHandler] Got status for " + statusList.size() + " Codex MCP servers");
                for (JsonObject status : statusList) {
                    if (status.has("name")) {
                        String serverName = status.get("name").getAsString();
                        String serverStatus = status.has("status") ? status.get("status").getAsString() : "unknown";
                        LOG.info("[CodexMcpServerHandler] Server: " + serverName + ", Status: " + serverStatus);
                    }
                }

                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.updateCodexMcpServerStatus", escapeJs(statusJson));
                });
            } catch (Exception e) {
                LOG.error("[CodexMcpServerHandler] Failed to get Codex MCP server status: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.updateCodexMcpServerStatus", escapeJs("[]"));
                });
            }
        }, AppExecutorUtil.getAppExecutorService()).exceptionally(ex -> {
            LOG.error("[CodexMcpServerHandler] Unexpected error in handleGetMcpServerStatus: " + ex.getMessage(), ex);
            return null;
        });
    }

    /**
     * Gets the tool list for the specified Codex MCP server.
     */
    private void handleGetMcpServerTools(String content) {
        try {
            if (!isCodexLocalConfigAuthorized()) {
                Gson gson = new Gson();
                sendToolsError("", com.github.claudecodegui.i18n.ClaudeCodeGuiBundle.message("error.codexLocalAccessNotAuthorized"), gson);
                return;
            }

            Gson gson = new Gson();
            JsonObject json = gson.fromJson(content, JsonObject.class);
            if (json == null || !json.has("serverId")) {
                sendToolsError("", "Missing required field: serverId", gson);
                return;
            }
            String serverId = json.get("serverId").getAsString();

            JsonObject targetServer = null;
            List<JsonObject> servers = codexMcpServerManager.getMcpServers();
            for (JsonObject server : servers) {
                if (server.has("id") && serverId.equals(server.get("id").getAsString())) {
                    targetServer = server;
                    break;
                }
            }

            if (targetServer == null || !targetServer.has("server") || !targetServer.get("server").isJsonObject()) {
                sendToolsError(serverId, "Server not found or invalid config: " + serverId, gson);
                return;
            }

            String sessionCwd = context.getSession() != null ? context.getSession().getCwd() : null;
            String projectBasePath = context.getProject() != null ? context.getProject().getBasePath() : null;
            JsonObject serverConfig = prepareServerConfig(
                    targetServer.getAsJsonObject("server"), sessionCwd, projectBasePath);
            LOG.info("[CodexMcpServerHandler] Getting tools for Codex MCP server: " + serverId);

            context.getCodexSDKBridge().getMcpServerTools(serverId, serverConfig)
                .thenAccept(result -> {
                    String resultJson = gson.toJson(result);
                    ApplicationManager.getApplication().invokeLater(() ->
                        callJavaScript("window.updateMcpServerTools", escapeJs(resultJson))
                    );
                })
                .exceptionally(e -> {
                    LOG.error("[CodexMcpServerHandler] Failed to get MCP server tools: " + e.getMessage(), e);
                    sendToolsError(serverId, e.getMessage(), gson);
                    return null;
                });
        } catch (Exception e) {
            LOG.error("[CodexMcpServerHandler] Failed to get MCP server tools: " + e.getMessage(), e);
            Gson gson = new Gson();
            sendToolsError("", e.getMessage(), gson);
        }
    }

    private void sendToolsError(String serverId, String errorMessage, Gson gson) {
        JsonObject errorResult = new JsonObject();
        errorResult.addProperty("serverId", serverId != null ? serverId : "");
        errorResult.addProperty("error", errorMessage != null ? errorMessage : "Unknown error");
        errorResult.add("tools", new com.google.gson.JsonArray());
        String json = gson.toJson(errorResult);
        ApplicationManager.getApplication().invokeLater(() ->
            callJavaScript("window.updateMcpServerTools", escapeJs(json))
        );
    }

    static JsonObject prepareServerConfig(
            JsonObject originalConfig, String sessionCwd, String projectBasePath) {
        JsonObject serverConfig = originalConfig.deepCopy();
        if (!serverConfig.has("cwd")) {
            String cwd = sessionCwd != null && !sessionCwd.trim().isEmpty()
                    ? sessionCwd
                    : projectBasePath;
            if (cwd != null && !cwd.trim().isEmpty()) {
                serverConfig.addProperty("cwd", cwd);
            }
        }
        return serverConfig;
    }

    private boolean isCodexLocalConfigAuthorized() {
        try {
            return context.getSettingsService().isCodexLocalConfigAuthorized();
        } catch (Exception e) {
            LOG.warn("[CodexMcpServerHandler] Failed to read Codex local authorization state: " + e.getMessage());
            return false;
        }
    }

    /**
     * Add a new Codex MCP server
     */
    private void handleAddMcpServer(String content) {
        try {
            Gson gson = new Gson();
            JsonObject server = gson.fromJson(content, JsonObject.class);

            codexMcpServerManager.upsertMcpServer(server);

            String serverId = server.has("id") ? server.get("id").getAsString() : "unknown";
            LOG.info("[CodexMcpServerHandler] Added Codex MCP server: " + serverId);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.codexMcpServerAdded", escapeJs(content));
                handleGetMcpServers();
            });
        } catch (Exception e) {
            LOG.error("[CodexMcpServerHandler] Failed to add Codex MCP server: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                String errorMsg = escapeJs("Failed to add Codex MCP server: " + e.getMessage());
                callJavaScript("window.showError", errorMsg);
            });
        }
    }

    /**
     * Update an existing Codex MCP server
     */
    private void handleUpdateMcpServer(String content) {
        try {
            Gson gson = new Gson();
            JsonObject server = gson.fromJson(content, JsonObject.class);

            codexMcpServerManager.upsertMcpServer(server);

            String serverId = server.has("id") ? server.get("id").getAsString() : "unknown";
            LOG.info("[CodexMcpServerHandler] Updated Codex MCP server: " + serverId);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.codexMcpServerUpdated", escapeJs(content));
                handleGetMcpServers();
            });
        } catch (Exception e) {
            LOG.error("[CodexMcpServerHandler] Failed to update Codex MCP server: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                String errorMsg = escapeJs("Failed to update Codex MCP server: " + e.getMessage());
                callJavaScript("window.showError", errorMsg);
            });
        }
    }

    /**
     * Delete a Codex MCP server
     */
    private void handleDeleteMcpServer(String content) {
        try {
            Gson gson = new Gson();
            JsonObject json = gson.fromJson(content, JsonObject.class);
            String serverId = json.get("id").getAsString();

            boolean success = codexMcpServerManager.deleteMcpServer(serverId);

            if (success) {
                LOG.info("[CodexMcpServerHandler] Deleted Codex MCP server: " + serverId);
                ApplicationManager.getApplication().invokeLater(() -> {
                    callJavaScript("window.codexMcpServerDeleted", escapeJs(serverId));
                    handleGetMcpServers();
                });
            } else {
                LOG.warn("[CodexMcpServerHandler] Codex MCP server not found: " + serverId);
                ApplicationManager.getApplication().invokeLater(() -> {
                    String errorMsg = escapeJs("Codex MCP server not found: " + serverId);
                    callJavaScript("window.showError", errorMsg);
                });
            }
        } catch (Exception e) {
            LOG.error("[CodexMcpServerHandler] Failed to delete Codex MCP server: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                String errorMsg = escapeJs("Failed to delete Codex MCP server: " + e.getMessage());
                callJavaScript("window.showError", errorMsg);
            });
        }
    }

    /**
     * Toggle Codex MCP server enabled/disabled state
     */
    private void handleToggleMcpServer(String content) {
        try {
            Gson gson = new Gson();
            JsonObject server = gson.fromJson(content, JsonObject.class);

            codexMcpServerManager.upsertMcpServer(server);

            boolean isEnabled = !server.has("enabled") || server.get("enabled").getAsBoolean();
            String serverId = server.get("id").getAsString();
            String serverName = server.has("name") ? server.get("name").getAsString() : serverId;

            LOG.info("[CodexMcpServerHandler] Toggled Codex MCP server: " + serverName + " (enabled: " + isEnabled + ")");

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.codexMcpServerToggled", escapeJs(content));
                handleGetMcpServers();
            });
        } catch (Exception e) {
            LOG.error("[CodexMcpServerHandler] Failed to toggle Codex MCP server: " + e.getMessage(), e);
            ApplicationManager.getApplication().invokeLater(() -> {
                String errorMsg = escapeJs("Failed to toggle Codex MCP server: " + e.getMessage());
                callJavaScript("window.showError", errorMsg);
            });
        }
    }

    /**
     * Validate Codex MCP server configuration
     */
    private void handleValidateMcpServer(String content) {
        try {
            Gson gson = new Gson();
            JsonObject server = gson.fromJson(content, JsonObject.class);

            Map<String, Object> validation = codexMcpServerManager.validateMcpServer(server);
            String validationJson = gson.toJson(validation);

            ApplicationManager.getApplication().invokeLater(() -> {
                callJavaScript("window.codexMcpServerValidated", escapeJs(validationJson));
            });
        } catch (Exception e) {
            LOG.error("[CodexMcpServerHandler] Failed to validate Codex MCP server: " + e.getMessage(), e);
        }
    }
}
