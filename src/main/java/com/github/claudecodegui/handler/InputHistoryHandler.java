package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.PlatformUtils;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/**
 * Handles input history management messages.
 * Delegates to Node.js input-history-service.cjs for actual storage.
 */
public class InputHistoryHandler {

    private static final Logger LOG = Logger.getInstance(InputHistoryHandler.class);

    /** Hard wall-clock timeout for the input-history Node.js child process. */
    private static final long PROCESS_TIMEOUT_SECONDS = 30;

    private final HandlerContext context;

    public InputHistoryHandler(HandlerContext context) {
        this.context = context;
    }

    /**
     * Get input history records.
     */
    public void handleGetInputHistory() {
        CompletableFuture.runAsync(() -> {
            try {
                String result = callInputHistoryService("getAllHistoryData", null);
                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.onInputHistoryLoaded", context.escapeJs(result));
                });
            } catch (Exception e) {
                LOG.error("[InputHistoryHandler] Failed to get input history: " + e.getMessage(), e);
                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.onInputHistoryLoaded", context.escapeJs("{\"items\":[],\"counts\":{}}"));
                });
            }
        });
    }

    /**
     * Record input history.
     * @param content JSON array of fragments
     */
    public void handleRecordInputHistory(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                String result = callInputHistoryServiceWithArray("recordHistory", content);
                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.onInputHistoryRecorded", context.escapeJs(result));
                });
            } catch (Exception e) {
                LOG.error("[InputHistoryHandler] Failed to record input history: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Delete a single input history item.
     * @param content the history item to delete
     */
    public void handleDeleteInputHistoryItem(String content) {
        CompletableFuture.runAsync(() -> {
            try {
                String result = callInputHistoryService("deleteHistoryItem", content);
                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.onInputHistoryDeleted", context.escapeJs(result));
                });
            } catch (Exception e) {
                LOG.error("[InputHistoryHandler] Failed to delete input history item: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Clear all input history.
     */
    public void handleClearInputHistory() {
        CompletableFuture.runAsync(() -> {
            try {
                String result = callInputHistoryService("clearAllHistory", null);
                ApplicationManager.getApplication().invokeLater(() -> {
                    context.callJavaScript("window.onInputHistoryCleared", context.escapeJs(result));
                });
            } catch (Exception e) {
                LOG.error("[InputHistoryHandler] Failed to clear input history: " + e.getMessage(), e);
            }
        });
    }

    /**
     * Call Node.js input-history-service (single parameter version).
     */
    public String callInputHistoryService(String functionName, String param) throws Exception {
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        String servicePath = NodeJsServiceCaller.resolveServicePath(
                nodePath, bridgePath, "input-history-service.cjs");
        String nodeScript;
        if (param == null || param.isEmpty()) {
            // Call without parameters
            nodeScript = String.format(
                "const { %s } = require(process.argv[1]); " +
                "const result = %s(); " +
                "console.log(JSON.stringify(result));",
                functionName,
                functionName
            );
            return executeNodeScript(nodePath, nodeScript, null, servicePath);
        } else {
            // Single parameter call (passed via stdin to avoid escaping issues)
            nodeScript = String.format(
                "const { %s } = require(process.argv[1]); " +
                "let input = ''; " +
                "process.stdin.on('data', chunk => input += chunk); " +
                "process.stdin.on('end', () => { " +
                "  try { " +
                "    const param = input.trim(); " +
                "    const result = %s(param); " +
                "    console.log(JSON.stringify(result)); " +
                "  } catch (err) { " +
                "    console.error(JSON.stringify({ error: err.message })); " +
                "    process.exit(1); " +
                "  } " +
                "});",
                functionName,
                functionName
            );
            return executeNodeScript(nodePath, nodeScript, param, servicePath);
        }
    }

    /**
     * Call Node.js input-history-service (array parameter version, used for recordHistory).
     */
    public String callInputHistoryServiceWithArray(String functionName, String jsonArrayParam) throws Exception {
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();

        String servicePath = NodeJsServiceCaller.resolveServicePath(
                nodePath, bridgePath, "input-history-service.cjs");
        // Use stdin to pass JSON data, avoiding shell escaping issues with special characters
        String nodeScript = String.format(
            "const { %s } = require(process.argv[1]); " +
            "let input = ''; " +
            "process.stdin.on('data', chunk => input += chunk); " +
            "process.stdin.on('end', () => { " +
            "  try { " +
            "    const data = JSON.parse(input); " +
            "    const result = %s(data); " +
            "    console.log(JSON.stringify(result)); " +
            "  } catch (err) { " +
            "    console.error(JSON.stringify({ error: err.message })); " +
            "    process.exit(1); " +
            "  } " +
            "});",
            functionName,
            functionName
        );

        return executeNodeScript(nodePath, nodeScript, jsonArrayParam, servicePath);
    }

    /**
     * Execute a Node.js script, optionally writing stdinData to the process stdin.
     * Handles process creation, stdin write, stdout read, 30s timeout, and exit code check.
     *
     * @param nodePath   path to the node executable
     * @param nodeScript the JavaScript code to run via node -e
     * @param stdinData  data to write to stdin, or null to skip stdin write
     * @return the last non-empty line of stdout
     */
    private String executeNodeScript(
            String nodePath, String nodeScript, String stdinData, String servicePath) throws Exception {
        List<String> command = NodeDetector.buildNodeInlineCommand(nodePath, nodeScript);
        command.add(servicePath);
        ProcessBuilder pb = new ProcessBuilder(command);
        pb.redirectErrorStream(true);

        // L7 fix: register with ProcessManager so cleanupAllProcesses sees this child.
        ProcessManager processManager = context.getClaudeSDKBridge().getProcessManager();
        String channelId = ProcessManager.newChannelId("input-history");
        Process process = null;
        try {
            process = pb.start();
            processManager.registerProcess(channelId, process);

            if (stdinData != null) {
                try (BufferedWriter writer = new BufferedWriter(
                        new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8))) {
                    writer.write(stdinData);
                    writer.flush();
                }
            }

            StringBuilder output = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append("\n");
                }
            }

            boolean finished = process.waitFor(PROCESS_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (!finished) {
                PlatformUtils.terminateProcess(process);
                throw new Exception("Node.js process timeout after " + PROCESS_TIMEOUT_SECONDS + " seconds");
            }

            int exitCode = process.exitValue();
            if (exitCode != 0) {
                throw new Exception("Node.js process exited with code " + exitCode + ": " + output);
            }

            String[] lines = output.toString().split("\n");
            return lines.length > 0 ? lines[lines.length - 1] : "{}";
        } finally {
            if (process != null) {
                if (process.isAlive()) {
                    PlatformUtils.terminateProcess(process);
                }
                processManager.unregisterProcess(channelId, process);
            }
        }
    }
}
