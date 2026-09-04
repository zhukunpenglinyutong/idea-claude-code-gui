package com.github.claudecodegui.provider.claude;

import com.github.claudecodegui.bridge.EnvironmentConfigurator;
import com.github.claudecodegui.bridge.NodeDetector;
import com.github.claudecodegui.bridge.ProcessManager;
import com.github.claudecodegui.util.PlatformUtils;
import com.github.claudecodegui.util.UserMessageSanitizer;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.function.Supplier;

/**
 * Reads persisted Claude session history via the Node bridge.
 */
class ClaudeSessionQueryService {

    private static final String CHANNEL_SCRIPT = "channel-manager.js";
    private static final int PROCESS_TIMEOUT_SECONDS = 30;
    private static final Pattern VALID_SESSION_ID = Pattern.compile("[a-zA-Z0-9_\\-]+");
    private static final Pattern IMAGE_REFERENCE_PATTERN = Pattern.compile("(?m)^\\[Image #\\d+:\\s*(.+?)\\]\\s*$");
    private static final String IMAGE_ATTACHMENT_HINT =
            "The user has attached the image(s) above. Please use the Read tool to view them.";

    private final Logger log;
    private final Gson gson;
    private final NodeDetector nodeDetector;
    private final Supplier<File> sdkDirSupplier;
    private final ProcessManager processManager;
    private final EnvironmentConfigurator envConfigurator;
    private final ClaudeJsonOutputExtractor outputExtractor;

    ClaudeSessionQueryService(
            Logger log,
            Gson gson,
            NodeDetector nodeDetector,
            Supplier<File> sdkDirSupplier,
            ProcessManager processManager,
            EnvironmentConfigurator envConfigurator,
            ClaudeJsonOutputExtractor outputExtractor
    ) {
        this.log = log;
        this.gson = gson;
        this.nodeDetector = nodeDetector;
        this.sdkDirSupplier = sdkDirSupplier;
        this.processManager = processManager;
        this.envConfigurator = envConfigurator;
        this.outputExtractor = outputExtractor;
    }

    List<JsonObject> getSessionMessages(String sessionId, String cwd) {
        try {
            JsonObject jsonResult = runSessionQuery("getSession", sessionId, cwd, "getSessionMessages");

            if (jsonResult.has("success") && jsonResult.get("success").getAsBoolean()) {
                List<JsonObject> messages = new ArrayList<>();
                if (jsonResult.has("messages")) {
                    JsonArray messagesArray = jsonResult.getAsJsonArray("messages");
                    for (var msg : messagesArray) {
                        messages.add(normalizeClaudeHistoryMessage(msg.getAsJsonObject()));
                    }
                }
                return messages;
            }

            String errorMsg = (jsonResult.has("error") && !jsonResult.get("error").isJsonNull())
                    ? jsonResult.get("error").getAsString()
                    : "Unknown error";
            throw new RuntimeException("Get session failed: " + errorMsg);
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new RuntimeException("Failed to get session messages: " + e.getMessage(), e);
        }
    }

    JsonObject getLatestUserMessage(String sessionId, String cwd) {
        try {
            JsonObject jsonResult = runSessionQuery("getLatestUserMessage", sessionId, cwd, "getLatestUserMessage");

            if (jsonResult.has("success") && jsonResult.get("success").getAsBoolean()) {
                if (jsonResult.has("message") && jsonResult.get("message").isJsonObject()) {
                    return normalizeClaudeHistoryMessage(jsonResult.getAsJsonObject("message"));
                }
                return null;
            }

            String errorMsg = (jsonResult.has("error") && !jsonResult.get("error").isJsonNull())
                    ? jsonResult.get("error").getAsString()
                    : "Unknown error";
            throw new RuntimeException("Get latest user message failed: " + errorMsg);
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new RuntimeException("Failed to get latest user message: " + e.getMessage(), e);
        }
    }

    private JsonObject runSessionQuery(String commandName, String sessionId, String cwd, String logPrefix) throws Exception {
        if (sessionId == null || !VALID_SESSION_ID.matcher(sessionId).matches()) {
            throw new IllegalArgumentException("Invalid sessionId: " + sessionId);
        }

        String node = nodeDetector.findNodeExecutable();

        File workDir = sdkDirSupplier.get();
        if (workDir == null || !workDir.exists()) {
            throw new RuntimeException("Bridge directory not ready or invalid");
        }

        List<String> command = NodeDetector.buildNodeScriptCommand(
                node, new File(workDir, CHANNEL_SCRIPT).getAbsolutePath());
        command.add("claude");
        command.add(commandName);
        command.add(sessionId);
        // Only translate the cwd to a WSL path when the active node is a WSL binary,
        // mirroring ClaudeSDKBridge#normalizeCwdForNode; a native node keeps the cwd as-is.
        String cwdArg = "";
        if (cwd != null) {
            cwdArg = NodeDetector.isWslPath(node) ? NodeDetector.convertToWslPath(cwd) : cwd;
        }
        command.add(cwdArg);

        ProcessBuilder pb = new ProcessBuilder(command);
        pb.directory(workDir);
        pb.redirectErrorStream(true);
        envConfigurator.updateProcessEnvironment(pb, node);

        // L5 fix: register with ProcessManager so cleanupAllProcesses sees this child.
        String channelId = ProcessManager.newChannelId("claude-session-query");
        Process process = null;
        StringBuilder output = new StringBuilder();
        try {
            process = processManager.startManagedProcess(channelId, pb);

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
                throw new RuntimeException("Node.js process timed out after " + PROCESS_TIMEOUT_SECONDS + " seconds");
            }
        } finally {
            if (process != null) {
                if (process.isAlive()) {
                    PlatformUtils.terminateProcess(process);
                }
                processManager.unregisterProcess(channelId, process);
            }
        }

        String outputStr = output.toString().trim();
        log.debug("[" + logPrefix + "] Raw output length: " + outputStr.length());
        if (log.isDebugEnabled()) {
            log.debug("[" + logPrefix + "] Raw output (first 300 chars): "
                    + (outputStr.length() > 300 ? outputStr.substring(0, 300) + "..." : outputStr));
        }

        String jsonStr = outputExtractor.extractLastJsonLine(outputStr);
        if (jsonStr == null) {
            log.error("[" + logPrefix + "] Failed to extract JSON from output");
            throw new RuntimeException("Failed to extract JSON from Node.js output");
        }

        // A well-formed JSON object must end with '}'. If it doesn't, the Node child
        // exited before its stdout buffer fully drained (a known race for large
        // getSession payloads) and the JSON was truncated mid-stream. Log the lengths
        // so the failure is diagnosable instead of leaving only a cryptic Gson error.
        // extractLastJsonLine already trims its return value, so no trim is needed here
        // (avoiding an O(n) copy of the multi-megabyte payload on every getSession).
        if (!jsonStr.endsWith("}")) {
            log.warn("[" + logPrefix + "] Extracted JSON appears truncated: jsonLength="
                    + jsonStr.length() + ", rawOutputLength=" + outputStr.length());
        }

        if (log.isDebugEnabled()) {
            log.debug("[" + logPrefix + "] Extracted JSON: "
                    + (jsonStr.length() > 500 ? jsonStr.substring(0, 500) + "..." : jsonStr));
        }
        JsonObject jsonResult = gson.fromJson(jsonStr, JsonObject.class);
        log.debug("[" + logPrefix + "] JSON parsed successfully, success="
                + (jsonResult.has("success") ? jsonResult.get("success").getAsBoolean() : "null"));
        return jsonResult;
    }

    static JsonObject normalizeClaudeHistoryMessage(JsonObject originalMessage) {
        if (originalMessage == null
                || !originalMessage.has("type")
                || !"user".equals(originalMessage.get("type").getAsString())
                || !originalMessage.has("message")
                || !originalMessage.get("message").isJsonObject()) {
            return originalMessage;
        }

        JsonObject message = originalMessage.getAsJsonObject("message");
        if (!message.has("content") || message.get("content").isJsonNull()) {
            return originalMessage;
        }

        JsonElement contentElement = message.get("content");
        if (contentElement.isJsonPrimitive() && contentElement.getAsJsonPrimitive().isString()) {
            ClaudeImageReferenceRewrite rewrite = rewriteClaudeImageReferenceText(contentElement.getAsString());
            if (!rewrite.changed) {
                return originalMessage;
            }

            JsonObject normalizedMessage = originalMessage.deepCopy();
            normalizedMessage.getAsJsonObject("message").add("content", rewrite.contentBlocks);
            return normalizedMessage;
        }

        if (!contentElement.isJsonArray()) {
            return originalMessage;
        }

        JsonArray originalBlocks = contentElement.getAsJsonArray();
        JsonArray rebuiltBlocks = new JsonArray();
        boolean changed = false;

        for (JsonElement blockElement : originalBlocks) {
            if (!blockElement.isJsonObject()) {
                rebuiltBlocks.add(blockElement.deepCopy());
                continue;
            }

            JsonObject block = blockElement.getAsJsonObject();
            if (!isTextBlock(block)) {
                rebuiltBlocks.add(block.deepCopy());
                continue;
            }

            ClaudeImageReferenceRewrite rewrite = rewriteClaudeImageReferenceText(block.get("text").getAsString());
            if (!rewrite.changed) {
                rebuiltBlocks.add(block.deepCopy());
                continue;
            }

            changed = true;
            for (JsonElement normalizedBlock : rewrite.contentBlocks) {
                rebuiltBlocks.add(normalizedBlock);
            }
        }

        if (!changed) {
            return originalMessage;
        }

        JsonObject normalizedMessage = originalMessage.deepCopy();
        normalizedMessage.getAsJsonObject("message").add("content", rebuiltBlocks);
        return normalizedMessage;
    }

    private static boolean isTextBlock(JsonObject block) {
        return block.has("type")
                && "text".equals(block.get("type").getAsString())
                && block.has("text")
                && !block.get("text").isJsonNull();
    }

    private static ClaudeImageReferenceRewrite rewriteClaudeImageReferenceText(String text) {
        if (text == null) {
            return ClaudeImageReferenceRewrite.unchanged(null);
        }

        Matcher matcher = IMAGE_REFERENCE_PATTERN.matcher(text);
        StringBuilder remainingText = new StringBuilder();
        JsonArray contentBlocks = new JsonArray();
        int lastEnd = 0;
        boolean sawReference = false;
        boolean restoredImage = false;

        while (matcher.find()) {
            remainingText.append(text, lastEnd, matcher.start());
            lastEnd = matcher.end();
            sawReference = true;

            String imagePath = matcher.group(1) != null ? matcher.group(1).trim() : "";
            JsonObject imageBlock = createLocalImageBlock(imagePath);
            if (imageBlock != null) {
                contentBlocks.add(imageBlock);
                restoredImage = true;
            } else {
                remainingText.append(matcher.group());
            }
        }

        if (!sawReference || !restoredImage) {
            String sanitized = normalizeRemainingText(text);
            if (sanitized.equals(text)) {
                return ClaudeImageReferenceRewrite.unchanged(text);
            }
            appendTextBlock(contentBlocks, sanitized);
            return new ClaudeImageReferenceRewrite(true, contentBlocks);
        }

        remainingText.append(text.substring(lastEnd));
        String cleanedText = normalizeRemainingText(remainingText.toString());
        appendTextBlock(contentBlocks, cleanedText);
        return new ClaudeImageReferenceRewrite(true, contentBlocks);
    }

    private static String normalizeRemainingText(String text) {
        if (text == null) {
            return "";
        }
        String normalized = text.replace("\r\n", "\n");
        normalized = normalized.replace("\r", "\n");
        normalized = normalized.replace(IMAGE_ATTACHMENT_HINT, "");
        normalized = UserMessageSanitizer.sanitizeUserFacingText(normalized);
        normalized = normalized.replaceAll("(?m)^[ \\t]+$", "");
        normalized = normalized.replaceAll("\n{3,}", "\n\n");
        normalized = normalized.replaceAll("^(?:\\s*\\n)+", "");
        normalized = normalized.replaceAll("(?:\\n\\s*)+$", "");
        return normalized.trim();
    }

    private static void appendTextBlock(JsonArray contentBlocks, String text) {
        if (text == null || text.isBlank()) {
            return;
        }
        JsonObject textBlock = new JsonObject();
        textBlock.addProperty("type", "text");
        textBlock.addProperty("text", text);
        contentBlocks.add(textBlock);
    }

    private static JsonObject createLocalImageBlock(String imagePath) {
        if (imagePath == null || imagePath.isBlank()) {
            return null;
        }

        try {
            Path path = Path.of(imagePath);
            if (!Files.isRegularFile(path)) {
                return null;
            }

            String mediaType = Files.probeContentType(path);
            if (mediaType == null || mediaType.isBlank()) {
                mediaType = guessImageMediaType(path);
            }
            if (mediaType == null || mediaType.isBlank()) {
                mediaType = "image/png";
            }

            String base64Data = Base64.getEncoder().encodeToString(Files.readAllBytes(path));
            JsonObject imageBlock = new JsonObject();
            imageBlock.addProperty("type", "image");
            imageBlock.addProperty("src", "data:" + mediaType + ";base64," + base64Data);
            imageBlock.addProperty("mediaType", mediaType);
            imageBlock.addProperty("alt", path.getFileName() != null ? path.getFileName().toString() : "image");
            return imageBlock;
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String guessImageMediaType(Path path) {
        String fileName = path.getFileName() != null ? path.getFileName().toString().toLowerCase() : "";
        if (fileName.endsWith(".png")) {
            return "image/png";
        }
        if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg")) {
            return "image/jpeg";
        }
        if (fileName.endsWith(".gif")) {
            return "image/gif";
        }
        if (fileName.endsWith(".webp")) {
            return "image/webp";
        }
        if (fileName.endsWith(".bmp")) {
            return "image/bmp";
        }
        if (fileName.endsWith(".svg")) {
            return "image/svg+xml";
        }
        return null;
    }

    private static final class ClaudeImageReferenceRewrite {
        private final boolean changed;
        private final JsonArray contentBlocks;

        private ClaudeImageReferenceRewrite(boolean changed, JsonArray contentBlocks) {
            this.changed = changed;
            this.contentBlocks = contentBlocks;
        }

        private static ClaudeImageReferenceRewrite unchanged(String originalText) {
            JsonArray contentBlocks = new JsonArray();
            JsonObject textBlock = new JsonObject();
            textBlock.addProperty("type", "text");
            textBlock.addProperty("text", originalText != null ? originalText : "");
            contentBlocks.add(textBlock);
            return new ClaudeImageReferenceRewrite(false, contentBlocks);
        }
    }
}
