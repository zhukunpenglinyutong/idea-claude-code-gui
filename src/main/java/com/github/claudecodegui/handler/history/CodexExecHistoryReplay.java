package com.github.claudecodegui.handler.history;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Restores the nested shell commands persisted inside Codex Responses API
 * {@code exec} wrappers.
 *
 * <p>The live bridge receives command-execution events and renders them as
 * normal Bash tool cards. A cold history load instead sees the outer
 * JavaScript wrapper. This class statically reads object literals from that
 * wrapper without evaluating JavaScript, then recreates the same tool-use and
 * tool-result message shape used by the live bridge.</p>
 */
final class CodexExecHistoryReplay {

    private static final int MAX_REPLAYED_SHELL_COMMANDS = 100;
    private static final Pattern OUTPUT_MARKER_PATTERN = Pattern.compile(
        "(?m)^---(\\d+)---[\\t ]*\\r?$"
    );
    private static final Pattern FAILED_OUTPUT_PATTERN = Pattern.compile(
        "(?im)(?:exit[_ ]code|process exited with code)\\s*[=:]?\\s*-?[1-9]\\d*"
            + "|\"is_error\"\\s*:\\s*true|\\bscript (?:error|failed)\\b"
            + "|\\bpermission denied\\b"
    );
    private static final Pattern SHELL_WRAPPER_PATTERN = Pattern.compile(
        "^/bin/(?:zsh|bash)\\s+(?:-lc|-c)\\s+['\"](.+)['\"]$",
        Pattern.DOTALL
    );
    private static final Pattern CD_PREFIX_PATTERN = Pattern.compile(
        "^cd\\s+\\S+\\s+&&\\s+(.+)$",
        Pattern.DOTALL
    );

    private CodexExecHistoryReplay() {
    }

    static boolean isExecCall(JsonObject payload) {
        return "exec".equalsIgnoreCase(getStringProperty(payload, "name"));
    }

    static List<Command> extractCommands(JsonObject payload) {
        String script = getStringProperty(payload, "input");
        if (script == null) {
            script = getStringProperty(payload, "arguments");
        }

        List<Command> commands = new ArrayList<>();
        if (script == null || script.isBlank() || !script.contains("tools.shell_command")) {
            return commands;
        }

        List<int[]> objectSpans = findJavaScriptObjectSpans(script);
        objectSpans.sort((left, right) -> Integer.compare(left[0], right[0]));
        for (int[] span : objectSpans) {
            Map<String, String> properties =
                parseJavaScriptObjectProperties(script, span[0], span[1]);
            String command = properties.get("command");
            if (command == null || command.isBlank()) {
                continue;
            }

            commands.add(new Command(
                command,
                properties.get("description"),
                properties.get("workdir"),
                parseLongOrNull(properties.get("timeout_ms"))
            ));
            if (commands.size() >= MAX_REPLAYED_SHELL_COMMANDS) {
                break;
            }
        }
        return commands;
    }

    static JsonObject createToolUseMessage(
            String callId,
            List<Command> commands,
            String timestamp
    ) {
        JsonArray content = new JsonArray();
        for (int i = 0; i < commands.size(); i++) {
            Command command = commands.get(i);
            JsonObject input = new JsonObject();
            input.addProperty("command", command.command);
            input.addProperty(
                "description",
                command.description != null && !command.description.isBlank()
                    ? command.description
                    : smartCommandDescription(command.command)
            );
            if (command.workdir != null && !command.workdir.isBlank()) {
                input.addProperty("workdir", command.workdir);
            }
            if (command.timeoutMs != null) {
                input.addProperty("timeout_ms", command.timeoutMs);
            }

            JsonObject toolUse = new JsonObject();
            toolUse.addProperty("type", "tool_use");
            toolUse.addProperty("id", shellToolUseId(callId, i));
            toolUse.addProperty("name", smartShellToolName(command.command));
            toolUse.add("input", input);
            content.add(toolUse);
        }

        JsonObject raw = new JsonObject();
        raw.addProperty("role", "assistant");
        raw.add("content", content);

        JsonObject message = new JsonObject();
        message.addProperty("type", "assistant");
        message.addProperty("content", "");
        message.add("raw", raw);
        if (timestamp != null) {
            message.addProperty("timestamp", timestamp);
        }
        return message;
    }

    static JsonObject createToolResultMessage(
            String callId,
            List<Command> commands,
            Output output,
            String fallbackTimestamp
    ) {
        List<String> commandOutputs = splitShellCommandOutputs(output.payload, commands.size());
        boolean globalFailure = isFailedOutputPayload(output.payload);
        JsonArray content = new JsonArray();
        for (int i = 0; i < commands.size(); i++) {
            String commandOutput = i < commandOutputs.size()
                ? commandOutputs.get(i)
                : "(no output)";
            if (commandOutput == null || commandOutput.isBlank()) {
                commandOutput = "(no output)";
            }

            JsonObject toolResult = new JsonObject();
            toolResult.addProperty("type", "tool_result");
            toolResult.addProperty("tool_use_id", shellToolUseId(callId, i));
            toolResult.addProperty(
                "is_error",
                FAILED_OUTPUT_PATTERN.matcher(commandOutput).find()
                    || (globalFailure && commands.size() == 1)
            );
            toolResult.addProperty("content", commandOutput);
            content.add(toolResult);
        }

        JsonObject raw = new JsonObject();
        raw.addProperty("role", "user");
        raw.add("content", content);

        JsonObject message = new JsonObject();
        message.addProperty("type", "user");
        message.addProperty("content", "[tool_result]");
        message.add("raw", raw);
        String timestamp = output.timestamp != null ? output.timestamp : fallbackTimestamp;
        if (timestamp != null) {
            message.addProperty("timestamp", timestamp);
        }
        return message;
    }

    private static List<int[]> findJavaScriptObjectSpans(String script) {
        List<int[]> spans = new ArrayList<>();
        List<Integer> stack = new ArrayList<>();
        int cursor = 0;
        while (cursor < script.length()) {
            char current = script.charAt(cursor);
            if (isQuote(current)) {
                cursor = skipJavaScriptString(script, cursor);
                continue;
            }
            if (current == '/' && cursor + 1 < script.length()) {
                char next = script.charAt(cursor + 1);
                if (next == '/') {
                    cursor = skipLineComment(script, cursor + 2);
                    continue;
                }
                if (next == '*') {
                    cursor = skipBlockComment(script, cursor + 2);
                    continue;
                }
            }
            if (current == '{') {
                stack.add(cursor);
            } else if (current == '}' && !stack.isEmpty()) {
                int start = stack.remove(stack.size() - 1);
                spans.add(new int[]{start, cursor});
            }
            cursor++;
        }
        return spans;
    }

    private static Map<String, String> parseJavaScriptObjectProperties(
            String script,
            int objectStart,
            int objectEnd
    ) {
        Map<String, String> properties = new HashMap<>();
        int cursor = objectStart + 1;
        while (cursor < objectEnd) {
            cursor = skipWhitespaceAndCommas(script, cursor, objectEnd);
            if (cursor >= objectEnd) {
                break;
            }

            ParsedString key;
            char current = script.charAt(cursor);
            if (isQuote(current)) {
                key = readJavaScriptString(script, cursor);
            } else if (isJavaScriptIdentifierStart(current)) {
                int keyEnd = cursor + 1;
                while (keyEnd < objectEnd && isJavaScriptIdentifierPart(script.charAt(keyEnd))) {
                    keyEnd++;
                }
                key = new ParsedString(script.substring(cursor, keyEnd), keyEnd);
            } else {
                cursor++;
                continue;
            }

            cursor = skipWhitespace(script, key.nextIndex, objectEnd);
            if (cursor >= objectEnd || script.charAt(cursor) != ':') {
                int comma = findNextTopLevelComma(script, cursor, objectEnd);
                cursor = advancePastComma(comma, objectEnd);
                continue;
            }
            cursor = skipWhitespace(script, cursor + 1, objectEnd);
            if (cursor >= objectEnd) {
                break;
            }

            String propertyValue;
            current = script.charAt(cursor);
            if (isQuote(current)) {
                ParsedString parsedValue = readJavaScriptString(script, cursor);
                propertyValue = parsedValue.value;
                cursor = parsedValue.nextIndex;
            } else {
                int valueEnd = findNextTopLevelComma(script, cursor, objectEnd);
                propertyValue = script.substring(cursor, valueEnd).trim();
                cursor = valueEnd;
            }
            properties.put(key.value, propertyValue);
            cursor = advancePastComma(cursor, objectEnd);
        }
        return properties;
    }

    private static int findNextTopLevelComma(String script, int start, int limit) {
        int braceDepth = 0;
        int bracketDepth = 0;
        int parenthesisDepth = 0;
        int cursor = Math.max(0, start);
        while (cursor < limit) {
            char current = script.charAt(cursor);
            if (isQuote(current)) {
                cursor = skipJavaScriptString(script, cursor);
                continue;
            }
            if (current == '/' && cursor + 1 < limit) {
                char next = script.charAt(cursor + 1);
                if (next == '/') {
                    cursor = skipLineComment(script, cursor + 2);
                    continue;
                }
                if (next == '*') {
                    cursor = skipBlockComment(script, cursor + 2);
                    continue;
                }
            }
            if (current == '{') {
                braceDepth++;
            } else if (current == '}' && braceDepth > 0) {
                braceDepth--;
            } else if (current == '[') {
                bracketDepth++;
            } else if (current == ']' && bracketDepth > 0) {
                bracketDepth--;
            } else if (current == '(') {
                parenthesisDepth++;
            } else if (current == ')' && parenthesisDepth > 0) {
                parenthesisDepth--;
            } else if (current == ',' && braceDepth == 0
                    && bracketDepth == 0 && parenthesisDepth == 0) {
                return cursor;
            }
            cursor++;
        }
        return limit;
    }

    private static int advancePastComma(int cursor, int limit) {
        return cursor < limit ? cursor + 1 : cursor;
    }

    private static int skipJavaScriptString(String script, int start) {
        char quote = script.charAt(start);
        int cursor = start + 1;
        while (cursor < script.length()) {
            char current = script.charAt(cursor++);
            if (current == '\\' && cursor < script.length()) {
                cursor++;
            } else if (current == quote) {
                break;
            }
        }
        return cursor;
    }

    private static ParsedString readJavaScriptString(String script, int start) {
        char quote = script.charAt(start);
        StringBuilder decoded = new StringBuilder();
        int cursor = start + 1;
        while (cursor < script.length()) {
            char current = script.charAt(cursor++);
            if (current == quote) {
                break;
            }
            if (current != '\\' || cursor >= script.length()) {
                decoded.append(current);
                continue;
            }

            char escaped = script.charAt(cursor++);
            switch (escaped) {
                case 'n':
                    decoded.append('\n');
                    break;
                case 'r':
                    decoded.append('\r');
                    break;
                case 't':
                    decoded.append('\t');
                    break;
                case 'b':
                    decoded.append('\b');
                    break;
                case 'f':
                    decoded.append('\f');
                    break;
                case 'v':
                    decoded.append('\u000B');
                    break;
                case '0':
                    decoded.append('\u0000');
                    break;
                case 'x':
                    cursor = appendHexEscape(script, cursor, 2, escaped, decoded);
                    break;
                case 'u':
                    cursor = appendHexEscape(script, cursor, 4, escaped, decoded);
                    break;
                case '\r':
                    if (cursor < script.length() && script.charAt(cursor) == '\n') {
                        cursor++;
                    }
                    break;
                case '\n':
                    break;
                default:
                    decoded.append(escaped);
                    break;
            }
        }
        return new ParsedString(decoded.toString(), cursor);
    }

    private static int appendHexEscape(
            String script,
            int start,
            int length,
            char escaped,
            StringBuilder decoded
    ) {
        int end = start + length;
        if (end <= script.length()) {
            try {
                decoded.append((char) Integer.parseInt(script.substring(start, end), 16));
                return end;
            } catch (NumberFormatException ignored) {
                // Preserve the escape marker when the sequence is malformed.
            }
        }
        decoded.append(escaped);
        return start;
    }

    private static int skipLineComment(String script, int start) {
        int cursor = start;
        while (cursor < script.length() && script.charAt(cursor) != '\n') {
            cursor++;
        }
        return cursor;
    }

    private static int skipBlockComment(String script, int start) {
        int end = script.indexOf("*/", start);
        return end >= 0 ? end + 2 : script.length();
    }

    private static int skipWhitespaceAndCommas(String script, int start, int limit) {
        int cursor = start;
        while (cursor < limit) {
            char current = script.charAt(cursor);
            if (!Character.isWhitespace(current) && current != ',') {
                break;
            }
            cursor++;
        }
        return cursor;
    }

    private static int skipWhitespace(String script, int start, int limit) {
        int cursor = start;
        while (cursor < limit && Character.isWhitespace(script.charAt(cursor))) {
            cursor++;
        }
        return cursor;
    }

    private static boolean isQuote(char value) {
        return value == '\'' || value == '"' || value == '`';
    }

    private static boolean isJavaScriptIdentifierStart(char value) {
        return Character.isLetter(value) || value == '_' || value == '$';
    }

    private static boolean isJavaScriptIdentifierPart(char value) {
        return Character.isLetterOrDigit(value) || value == '_' || value == '$';
    }

    private static Long parseLongOrNull(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return Long.parseLong(value.trim());
        } catch (NumberFormatException ignored) {
            return null;
        }
    }

    private static List<String> splitShellCommandOutputs(JsonObject outputPayload, int commandCount) {
        List<String> texts = new ArrayList<>();
        if (outputPayload != null && outputPayload.has("output")) {
            collectOutputTexts(outputPayload.get("output"), texts);
        }

        List<String> outputs = new ArrayList<>();
        for (int i = 0; i < commandCount; i++) {
            outputs.add("(no output)");
        }
        if (texts.isEmpty() || commandCount == 0) {
            return outputs;
        }

        String combined = String.join("\n", texts);
        Matcher markerMatcher = OUTPUT_MARKER_PATTERN.matcher(combined);
        int previousCommandIndex = -1;
        int previousContentStart = -1;
        boolean foundMarker = false;
        while (markerMatcher.find()) {
            foundMarker = true;
            if (previousCommandIndex >= 0 && previousCommandIndex < commandCount) {
                outputs.set(
                    previousCommandIndex,
                    normalizeCommandOutput(
                        combined.substring(previousContentStart, markerMatcher.start())
                    )
                );
            }
            previousCommandIndex = Integer.parseInt(markerMatcher.group(1)) - 1;
            previousContentStart = markerMatcher.end();
        }
        if (foundMarker) {
            if (previousCommandIndex >= 0 && previousCommandIndex < commandCount) {
                outputs.set(
                    previousCommandIndex,
                    normalizeCommandOutput(combined.substring(previousContentStart))
                );
            }
            return outputs;
        }

        List<String> actualTexts = new ArrayList<>(texts);
        if (actualTexts.size() > 1 && isExecWrapperStatus(actualTexts.get(0))) {
            actualTexts.remove(0);
        }
        if (commandCount == 1) {
            outputs.set(0, normalizeCommandOutput(String.join("\n", actualTexts)));
            return outputs;
        }

        if (actualTexts.size() >= commandCount) {
            for (int i = 0; i < commandCount; i++) {
                outputs.set(i, normalizeCommandOutput(actualTexts.get(i)));
            }
        } else {
            outputs.set(0, normalizeCommandOutput(String.join("\n", actualTexts)));
        }
        return outputs;
    }

    private static void collectOutputTexts(JsonElement value, List<String> texts) {
        if (value == null || value.isJsonNull()) {
            return;
        }
        if (value.isJsonArray()) {
            for (JsonElement child : value.getAsJsonArray()) {
                collectOutputTexts(child, texts);
            }
            return;
        }
        if (value.isJsonObject()) {
            JsonObject object = value.getAsJsonObject();
            if (object.has("text") && object.get("text").isJsonPrimitive()) {
                texts.add(object.get("text").getAsString());
            } else if (object.has("content")) {
                collectOutputTexts(object.get("content"), texts);
            } else if (object.has("output")) {
                collectOutputTexts(object.get("output"), texts);
            }
            return;
        }
        if (!value.isJsonPrimitive()) {
            return;
        }

        String text = value.getAsString();
        String trimmed = text.trim();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
            try {
                JsonElement parsed = JsonParser.parseString(trimmed);
                if (isStructuredTextOutput(parsed)) {
                    collectOutputTexts(parsed, texts);
                    return;
                }
            } catch (Exception ignored) {
                // Treat ordinary command output beginning with '[' as plain text.
            }
        }
        texts.add(text);
    }

    private static boolean isStructuredTextOutput(JsonElement value) {
        if (!value.isJsonArray()) {
            return false;
        }
        for (JsonElement child : value.getAsJsonArray()) {
            if (child.isJsonObject() && child.getAsJsonObject().has("text")) {
                return true;
            }
        }
        return false;
    }

    private static String normalizeCommandOutput(String output) {
        String normalized = output == null ? "" : output.strip();
        return normalized.isEmpty() ? "(no output)" : normalized;
    }

    private static boolean isExecWrapperStatus(String text) {
        if (text == null) {
            return false;
        }
        String normalized = text.stripLeading().toLowerCase(Locale.ROOT);
        return normalized.startsWith("script completed")
            || normalized.startsWith("script failed")
            || normalized.startsWith("script running");
    }

    private static boolean isFailedOutputPayload(JsonObject output) {
        if (output == null) {
            return false;
        }
        if (output.has("is_error") && output.get("is_error").isJsonPrimitive()
                && output.get("is_error").getAsBoolean()) {
            return true;
        }
        String status = getStringProperty(output, "status");
        return status != null
            && ("failed".equalsIgnoreCase(status) || "error".equalsIgnoreCase(status));
    }

    private static String shellToolUseId(String callId, int commandIndex) {
        String stableCallId = callId == null || callId.isBlank() ? "unknown" : callId;
        return "codex_exec_" + stableCallId + "_" + commandIndex;
    }

    private static String smartShellToolName(String command) {
        String actualCommand = extractActualCommand(command);
        if (actualCommand.matches("^(ls|find|tree)\\b.*")) {
            return "glob";
        }
        if (actualCommand.matches("^(pwd|cat|head|tail|file|stat)\\b.*")
                || actualCommand.matches("^sed\\s+-n\\s+.*")) {
            return "read";
        }
        if (actualCommand.matches("^(grep|rg|ack|ag)\\b.*")) {
            return "glob";
        }
        return "bash";
    }

    private static String smartCommandDescription(String command) {
        if (command == null || command.isBlank()) {
            return "Execute command";
        }
        String actualCommand = extractActualCommand(command);
        String[] words = actualCommand.split("\\s+");
        String firstWord = words.length > 0 ? words[0] : actualCommand;

        if (actualCommand.matches("^ls\\b.*")) {
            return "List directory contents";
        }
        if (actualCommand.matches("^pwd\\b.*")) {
            return "Show current directory";
        }
        if (actualCommand.matches("^cat\\b.*")) {
            return "Read file contents";
        }
        if (actualCommand.matches("^head\\b.*")) {
            return "Read first lines";
        }
        if (actualCommand.matches("^tail\\b.*")) {
            return "Read last lines";
        }
        if (actualCommand.matches("^find\\b.*")) {
            return "Find files";
        }
        if (actualCommand.matches("^tree\\b.*")) {
            return "Show directory tree";
        }
        if (actualCommand.matches("^sed\\s+-n\\s+.*")) {
            return "Read file lines";
        }
        if (actualCommand.matches("^(grep|rg|ack|ag)\\b.*")) {
            return "Search in files";
        }
        if (actualCommand.matches("^git\\s+status\\b.*")) {
            return "Check git status";
        }
        if (actualCommand.matches("^git\\s+diff\\b.*")) {
            return "Show git diff";
        }
        if (actualCommand.matches("^git\\s+log\\b.*")) {
            return "Show git log";
        }
        if (actualCommand.matches("^git\\s+add\\b.*")) {
            return "Stage changes";
        }
        if (actualCommand.matches("^git\\s+commit\\b.*")) {
            return "Commit changes";
        }
        if (actualCommand.matches("^git\\s+push\\b.*")) {
            return "Push to remote";
        }
        if (actualCommand.matches("^git\\s+pull\\b.*")) {
            return "Pull from remote";
        }
        if (actualCommand.matches("^git\\s+.*") && words.length > 1) {
            return "Run git " + words[1];
        }
        if (actualCommand.matches("^npm\\s+install\\b.*")) {
            return "Install npm packages";
        }
        if (actualCommand.matches("^npm\\s+run\\b.*")) {
            return "Run npm script";
        }
        if (actualCommand.matches("^npm\\s+.*") && words.length > 1) {
            return "Run npm " + words[1];
        }
        if (actualCommand.matches("^(yarn|pnpm)\\s+.*")) {
            return "Run " + firstWord + " command";
        }
        if (actualCommand.matches("^(gradle|mvn|make)\\b.*")) {
            return "Run " + firstWord + " build";
        }
        return actualCommand.length() <= 30 ? actualCommand : "Run " + firstWord;
    }

    private static String extractActualCommand(String command) {
        if (command == null) {
            return "";
        }
        String actualCommand = command.trim();
        Matcher shellWrapper = SHELL_WRAPPER_PATTERN.matcher(actualCommand);
        if (shellWrapper.matches()) {
            actualCommand = shellWrapper.group(1);
        }
        Matcher cdPrefix = CD_PREFIX_PATTERN.matcher(actualCommand);
        if (cdPrefix.matches()) {
            actualCommand = cdPrefix.group(1);
        }
        return actualCommand.trim();
    }

    private static String getStringProperty(JsonObject object, String propertyName) {
        if (object == null
                || !object.has(propertyName)
                || object.get(propertyName).isJsonNull()
                || !object.get(propertyName).isJsonPrimitive()) {
            return null;
        }
        return object.get(propertyName).getAsString();
    }

    static final class Output {
        private final JsonObject payload;
        private final String timestamp;

        Output(JsonObject payload, String timestamp) {
            this.payload = payload;
            this.timestamp = timestamp;
        }
    }

    static final class Command {
        private final String command;
        private final String description;
        private final String workdir;
        private final Long timeoutMs;

        Command(String command, String description, String workdir, Long timeoutMs) {
            this.command = command;
            this.description = description;
            this.workdir = workdir;
            this.timeoutMs = timeoutMs;
        }
    }

    private static final class ParsedString {
        private final String value;
        private final int nextIndex;

        private ParsedString(String value, int nextIndex) {
            this.value = value;
            this.nextIndex = nextIndex;
        }
    }
}
