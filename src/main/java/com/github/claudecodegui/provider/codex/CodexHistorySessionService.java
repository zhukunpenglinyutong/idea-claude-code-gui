package com.github.claudecodegui.provider.codex;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonStreamParser;
import com.intellij.openapi.diagnostic.Logger;

import java.io.BufferedReader;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.stream.Stream;

/**
 * Reads raw Codex session messages and normalizes tool calls for the webview.
 */
class CodexHistorySessionService {

    private static final Logger LOG = Logger.getInstance(CodexHistorySessionService.class);

    private final Path sessionsDir;
    private final Gson gson;

    CodexHistorySessionService(Path sessionsDir, Gson gson) {
        this.sessionsDir = sessionsDir;
        this.gson = gson;
    }

    String getSessionMessagesAsJson(String sessionId) {
        try {
            List<CodexHistoryReader.CodexMessage> messages = new ArrayList<>();
            forEachSessionMessage(sessionId, messages::add);

            return gson.toJson(messages);
        } catch (Exception e) {
            LOG.error("[CodexHistoryReader] Failed to read session messages: " + e.getMessage(), e);
            return gson.toJson(new ArrayList<>());
        }
    }

    int forEachSessionMessage(String sessionId,
                              Consumer<CodexHistoryReader.CodexMessage> consumer) throws IOException {
        Path sessionFile = findSessionFile(sessionId);
        if (sessionFile == null) {
            throw new IOException("Codex session file not found: " + sessionId);
        }

        int messageCount = 0;
        try (BufferedReader reader = Files.newBufferedReader(sessionFile, StandardCharsets.UTF_8)) {
            String line;
            while ((line = reader.readLine()) != null) {
                if (line.trim().isEmpty()) {
                    continue;
                }

                try {
                    JsonStreamParser lineParser = new JsonStreamParser(line);
                    while (lineParser.hasNext()) {
                        JsonElement element = lineParser.next();
                        CodexHistoryReader.CodexMessage message = gson.fromJson(
                                element, CodexHistoryReader.CodexMessage.class);
                        if (message != null) {
                            consumer.accept(transformFunctionCall(message));
                            messageCount++;
                        }
                    }
                } catch (Exception e) {
                    LOG.debug("[CodexHistoryReader] Failed to parse message: " + e.getMessage());
                }
            }
        }
        return messageCount;
    }

    private Path findSessionFile(String sessionId) throws IOException {
        if (!Files.exists(sessionsDir)) {
            return null;
        }

        try (Stream<Path> paths = Files.walk(sessionsDir)) {
            // Use contains() to match both UUID-based session IDs (from session_meta.id)
            // and full filename-based IDs. The Codex SDK thread ID (UUID) is embedded
            // in the filename (e.g., rollout-2026-04-01T14-57-29-<UUID>.jsonl).
            return paths
                    .filter(Files::isRegularFile)
                    .filter(path -> path.toString().endsWith(".jsonl"))
                    .filter(path -> path.getFileName().toString().contains(sessionId))
                    .findFirst()
                    .orElse(null);
        }
    }

    private CodexHistoryReader.CodexMessage transformFunctionCall(CodexHistoryReader.CodexMessage msg) {
        if (msg == null || !"response_item".equals(msg.type) || msg.payload == null) {
            return msg;
        }

        JsonObject payload = msg.payload;
        if (!payload.has("type") || !"function_call".equals(payload.get("type").getAsString())) {
            return msg;
        }
        if (!payload.has("name") || !"shell_command".equals(payload.get("name").getAsString())) {
            return msg;
        }
        if (!payload.has("arguments")) {
            return msg;
        }

        try {
            String argumentsStr = payload.get("arguments").getAsString();
            JsonObject arguments = gson.fromJson(argumentsStr, JsonObject.class);

            if (arguments != null && arguments.has("command")) {
                String command = arguments.get("command").getAsString();
                if (isFileViewingCommand(command)) {
                    payload.addProperty("name", "read");
                    LOG.debug("[CodexHistoryReader] Transformed shell_command to read for: " + command);
                }
            }
        } catch (Exception e) {
            LOG.debug("[CodexHistoryReader] Failed to parse arguments: " + e.getMessage());
        }

        return msg;
    }

    private boolean isFileViewingCommand(String command) {
        if (command == null || command.isEmpty()) {
            return false;
        }

        String trimmed = command.trim();
        return trimmed.matches("^(pwd|ls|cat|head|tail|tree|file|stat)\\b.*")
                || trimmed.matches("^sed\\s+-n\\s+.*");
    }
}
