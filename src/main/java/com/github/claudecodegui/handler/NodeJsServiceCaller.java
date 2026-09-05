package com.github.claudecodegui.handler;

import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.handler.core.HandlerContext;
import com.github.claudecodegui.util.PlatformUtils;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;

/**
 * Handles Node.js subprocess calls for favorites and session titles services.
 * <p>
 * Extracted from HistoryHandler to encapsulate all Node.js process invocation logic
 * for favorites-service.cjs and session-titles-service.cjs.
 */
public class NodeJsServiceCaller {

    private static final int PROCESS_TIMEOUT_SECONDS = 30;

    private static final Set<String> ALLOWED_FAVORITES_FUNCTIONS = Set.of(
        "loadFavorites", "toggleFavorite"
    );

    private static final Set<String> ALLOWED_TITLES_FUNCTIONS = Set.of(
        "loadTitles", "updateTitle", "deleteTitle"
    );

    private final HandlerContext context;
    private final int processTimeoutSeconds;

    public NodeJsServiceCaller(HandlerContext context) {
        this(context, PROCESS_TIMEOUT_SECONDS);
    }

    NodeJsServiceCaller(HandlerContext context, int processTimeoutSeconds) {
        this.context = context;
        this.processTimeoutSeconds = processTimeoutSeconds;
    }

    /**
     * Call Node.js favorites-service.
     */
    public String callNodeJsFavoritesService(String functionName, String sessionId) throws Exception {
        validateFunctionName(functionName, ALLOWED_FAVORITES_FUNCTIONS);

        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();
        String servicePath = resolveServicePath(nodePath, bridgePath, "favorites-service.cjs");

        String nodeScript = String.format(
            "const { %s } = require(process.argv[1]); " +
            "const result = %s(process.env.SESSION_ID); " +
            "console.log(JSON.stringify(result));",
            functionName,
            functionName
        );

        ProcessBuilder pb = buildNodeProcessBuilder(nodePath, nodeScript, servicePath);
        pb.redirectErrorStream(true);
        pb.environment().put("SESSION_ID", sessionId);

        return executeNodeScript(pb);
    }

    /**
     * Call Node.js session-titles-service (no-argument version, for loadTitles).
     */
    public String callNodeJsTitlesService(String functionName) throws Exception {
        validateFunctionName(functionName, ALLOWED_TITLES_FUNCTIONS);

        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();
        String servicePath = resolveServicePath(nodePath, bridgePath, "session-titles-service.cjs");

        String nodeScript = String.format(
            "const { %s } = require(process.argv[1]); " +
            "const result = %s(); " +
            "console.log(JSON.stringify(result));",
            functionName,
            functionName
        );

        ProcessBuilder pb = buildNodeProcessBuilder(nodePath, nodeScript, servicePath);
        pb.redirectErrorStream(true);

        return executeNodeScript(pb);
    }

    /**
     * Call Node.js session-titles-service (with parameters, for updateTitle).
     */
    public String callNodeJsTitlesServiceWithParams(String functionName, String sessionId, String customTitle) throws Exception {
        validateFunctionName(functionName, ALLOWED_TITLES_FUNCTIONS);

        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();
        String servicePath = resolveServicePath(nodePath, bridgePath, "session-titles-service.cjs");

        String nodeScript = String.format(
            "const { %s } = require(process.argv[1]); " +
            "const result = %s(process.env.SESSION_ID, process.env.CUSTOM_TITLE); " +
            "console.log(JSON.stringify(result));",
            functionName,
            functionName
        );

        ProcessBuilder pb = buildNodeProcessBuilder(nodePath, nodeScript, servicePath);
        pb.redirectErrorStream(true);
        pb.environment().put("SESSION_ID", sessionId);
        pb.environment().put("CUSTOM_TITLE", customTitle);

        return executeNodeScript(pb);
    }

    /**
     * Call Node.js session-titles-service to delete a title (single parameter version).
     */
    public String callNodeJsDeleteTitle(String sessionId) throws Exception {
        String bridgePath = context.getClaudeSDKBridge().getSdkTestDir().getAbsolutePath();
        String nodePath = context.getClaudeSDKBridge().getNodeExecutable();
        String servicePath = resolveServicePath(nodePath, bridgePath, "session-titles-service.cjs");

        String nodeScript =
            "const { deleteTitle } = require(process.argv[1]); " +
            "const result = deleteTitle(process.env.SESSION_ID); " +
            "console.log(JSON.stringify({ success: result }));";

        ProcessBuilder pb = buildNodeProcessBuilder(nodePath, nodeScript, servicePath);
        pb.redirectErrorStream(true);
        pb.environment().put("SESSION_ID", sessionId);

        return executeNodeScript(pb);
    }

    /**
     * Build a ProcessBuilder for running a Node.js inline script.
     * Delegates to {@link NodeDetector#buildNodeInlineCommand} so WSL prefixing is centralised.
     */
    private ProcessBuilder buildNodeProcessBuilder(String nodePath, String nodeScript, String servicePath) {
        List<String> command = NodeDetector.buildNodeInlineCommand(nodePath, nodeScript);
        command.add(servicePath);
        return new ProcessBuilder(command);
    }

    static String resolveServicePath(String nodePath, String bridgePath, String serviceFileName) {
        String servicePath = bridgePath + "/services/" + serviceFileName;
        return NodeDetector.isWslPath(nodePath) ? NodeDetector.convertToWslPath(servicePath) : servicePath;
    }

    /**
     * Validate that the function name is in the allowed set to prevent injection.
     */
    private void validateFunctionName(String functionName, Set<String> allowedFunctions) {
        if (functionName == null || !allowedFunctions.contains(functionName)) {
            throw new IllegalArgumentException(
                "Invalid function name: " + functionName + ". Allowed: " + allowedFunctions
            );
        }
    }

    /**
     * Execute a Node.js script via ProcessBuilder, enforce a timeout, and
     * return the last line of stdout (expected to be JSON).
     *
     * <p>Stdout is drained on a daemon thread so the timeout below is the real
     * deadline: the previous read-to-EOF-then-wait ordering let a hung child
     * holding the pipe open block forever with the timeout never reached.
     */
    String executeNodeScript(ProcessBuilder pb) throws Exception {
        // L8 fix: register with ProcessManager so cleanupAllProcesses sees this child.
        ProcessManager processManager = context.getClaudeSDKBridge().getProcessManager();
        String channelId = ProcessManager.newChannelId("node-service");
        Process process = null;
        try {
            process = pb.start();
            processManager.registerProcess(channelId, process);

            final Process started = process;
            StringBuilder output = new StringBuilder();
            Thread readerThread = new Thread(() -> {
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(started.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) {
                        synchronized (output) {
                            output.append(line).append("\n");
                        }
                    }
                } catch (Exception ignored) {
                }
            });
            readerThread.setDaemon(true);
            readerThread.start();

            boolean finished = process.waitFor(processTimeoutSeconds, TimeUnit.SECONDS);
            if (!finished) {
                PlatformUtils.terminateProcess(process);
                throw new Exception("Node.js process timed out after " + processTimeoutSeconds + " seconds");
            }
            // Process exited; the reader hits EOF promptly — join for the final lines.
            readerThread.join(2000L);

            int exitCode = process.exitValue();
            String outputText;
            synchronized (output) {
                outputText = output.toString();
            }
            if (exitCode != 0) {
                throw new Exception("Node.js process exited with code " + exitCode + ": " + outputText);
            }

            String[] lines = outputText.split("\n");
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
