package com.github.claudecodegui.handler.history;

import com.google.gson.JsonArray;
import com.google.gson.JsonParser;
import org.junit.Test;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class SubagentHistoryServiceCompletionTest {

    private static JsonArray messages(String... records) {
        JsonArray result = new JsonArray();
        for (String record : records) {
            result.add(JsonParser.parseString(record));
        }
        return result;
    }

    @Test
    public void completedWhenLastAssistantStopsAtEndTurn() {
        JsonArray history = messages(
                "{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"tool_use\"}}",
                "{\"type\":\"user\",\"message\":{\"content\":[]}}",
                "{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"end_turn\"}}"
        );

        assertTrue(SubagentHistoryService.hasCompleted(history));
    }

    @Test
    public void unfinishedWhenLastAssistantIsStillUsingTools() {
        JsonArray history = messages(
                "{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"tool_use\"}}",
                "{\"type\":\"user\",\"message\":{\"content\":[]}}"
        );

        assertFalse(SubagentHistoryService.hasCompleted(history));
    }

    @Test
    public void unfinishedWhenLastAssistantIsPartialThinking() {
        JsonArray history = messages(
                "{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"tool_use\"}}",
                "{\"type\":\"assistant\",\"message\":{\"stop_reason\":null}}"
        );

        assertFalse(SubagentHistoryService.hasCompleted(history));
    }

    @Test
    public void ignoresNonAssistantRecordsAfterTerminalAssistant() {
        JsonArray history = messages(
                "{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"end_turn\"}}",
                "{\"type\":\"progress\"}"
        );

        assertTrue(SubagentHistoryService.hasCompleted(history));
    }

    @Test
    public void completedWhenLastAssistantStopsAtMaxTokens() {
        // A background agent that hits the token limit has still terminated;
        // treating max_tokens as not-completed would leave the UI stuck on
        // "running", reproducing the bug this class exists to fix.
        JsonArray history = messages(
                "{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"tool_use\"}}",
                "{\"type\":\"user\",\"message\":{\"content\":[]}}",
                "{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"max_tokens\"}}"
        );

        assertTrue(SubagentHistoryService.hasCompleted(history));
    }

    @Test
    public void completedWhenLastAssistantStopsAtRefusal() {
        JsonArray history = messages(
                "{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"refusal\"}}"
        );

        assertTrue(SubagentHistoryService.hasCompleted(history));
    }

    @Test
    public void completedWhenLastAssistantStopsAtPauseTurn() {
        JsonArray history = messages(
                "{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"pause_turn\"}}"
        );

        assertTrue(SubagentHistoryService.hasCompleted(history));
    }
}
