package com.github.claudecodegui.handler.history;

import com.github.claudecodegui.handler.NodeJsServiceCaller;
import com.github.claudecodegui.handler.core.BaseMessageHandler;
import com.github.claudecodegui.handler.core.HandlerContext;

import com.intellij.openapi.diagnostic.Logger;

/**
 * History data handler.
 * Routes history-related messages to dedicated service classes.
 */
public class HistoryHandler extends BaseMessageHandler {

    private static final Logger LOG = Logger.getInstance(HistoryHandler.class);

    private static final String[] SUPPORTED_TYPES = {
            "load_history_data",
            "load_session",
            "load_codex_history_page",
            "delete_session",  // Delete session
            "delete_sessions", // Batch delete sessions
            "export_session",  // Export session
            "toggle_favorite", // Toggle favorite status
            "update_title",    // Update session title
            "delete_title",    // Delete orphaned custom title (B-011)
            "deep_search_history", // Deep search (clear cache and reload)
            "load_subagent_session", // Load Claude Code sidechain Agent process log
            "convert_to_cli_session" // Convert sidechain session to CLI-recognizable session
    };

    // Session load callback interface
    public interface SessionLoadCallback {
        void onLoadSession(String sessionId, String projectPath, String provider);
    }

    private SessionLoadCallback sessionLoadCallback;
    private String currentProvider = "claude"; // Default to claude

    private final HistoryLoadService historyLoadService;
    private final HistoryDeleteService historyDeleteService;
    private final HistoryExportService historyExportService;
    private final HistoryMessageInjector historyMessageInjector;
    private final HistoryMetadataService historyMetadataService;
    private final SubagentHistoryService subagentHistoryService;
    private final SessionConversionService sessionConversionService;

    public HistoryHandler(HandlerContext context) {
        super(context);
        NodeJsServiceCaller nodeJsServiceCaller = new NodeJsServiceCaller(context);
        this.historyLoadService = new HistoryLoadService(context, nodeJsServiceCaller);
        this.historyDeleteService = new HistoryDeleteService(context, nodeJsServiceCaller, historyLoadService);
        this.historyExportService = new HistoryExportService(context);
        this.historyMessageInjector = new HistoryMessageInjector(context);
        this.historyMetadataService = new HistoryMetadataService(context, nodeJsServiceCaller);
        this.subagentHistoryService = new SubagentHistoryService(context);
        this.sessionConversionService = new SessionConversionService(context);
    }

    public void setSessionLoadCallback(SessionLoadCallback callback) {
        this.sessionLoadCallback = callback;
    }

    @Override
    public String[] getSupportedTypes() {
        return SUPPORTED_TYPES;
    }

    @Override
    public boolean handle(String type, String content) {
        switch (type) {
            case "load_history_data":
                LOG.debug("[HistoryHandler] 处理: load_history_data, provider=" + content);
                this.currentProvider = content != null && !content.isEmpty() ? content : "claude";
                historyLoadService.handleLoadHistoryData(currentProvider);
                return true;
            case "load_session":
                LOG.debug("[HistoryHandler] 处理: load_session");
                historyMessageInjector.handleLoadSession(content, currentProvider, sessionLoadCallback);
                return true;
            case "load_codex_history_page":
                LOG.debug("[HistoryHandler] Processing: load_codex_history_page");
                historyMessageInjector.loadEarlierCodexHistoryPage(content);
                return true;
            case "delete_session":
                LOG.info("[HistoryHandler] 处理: delete_session, sessionId=" + content);
                historyDeleteService.handleDeleteSession(content, currentProvider);
                return true;
            case "delete_sessions":
                LOG.info("[HistoryHandler] 处理: delete_sessions");
                historyDeleteService.handleDeleteSessions(content, currentProvider);
                return true;
            case "export_session":
                LOG.info("[HistoryHandler] 处理: export_session, sessionId=" + content);
                historyExportService.handleExportSession(content, currentProvider);
                return true;
            case "toggle_favorite":
                LOG.info("[HistoryHandler] 处理: toggle_favorite, sessionId=" + content);
                historyMetadataService.handleToggleFavorite(content);
                return true;
            case "update_title":
                LOG.info("[HistoryHandler] 处理: update_title");
                historyMetadataService.handleUpdateTitle(content);
                return true;
            case "delete_title":
                LOG.info("[HistoryHandler] 处理: delete_title, sessionId=" + content);
                historyMetadataService.handleDeleteTitle(content);
                return true;
            case "deep_search_history":
                LOG.info("[HistoryHandler] 处理: deep_search_history, provider=" + content);
                this.currentProvider = content != null && !content.isEmpty() ? content : "claude";
                historyLoadService.handleDeepSearchHistory(currentProvider);
                return true;
            case "load_subagent_session":
                LOG.debug("[HistoryHandler] 处理: load_subagent_session");
                subagentHistoryService.handleLoadSubagentSession(content);
                return true;
            case "convert_to_cli_session":
                LOG.debug("[HistoryHandler] 处理: convert_to_cli_session");
                String conversionProjectPath = this.context.getProject() != null
                        ? this.context.getProject().getBasePath() : null;
                this.sessionConversionService.convertSdkSession(content, conversionProjectPath);
                return true;
            default:
                return false;
        }
    }
}
