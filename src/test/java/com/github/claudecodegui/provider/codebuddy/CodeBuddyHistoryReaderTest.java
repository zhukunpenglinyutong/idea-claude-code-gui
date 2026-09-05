package com.github.claudecodegui.provider.codebuddy;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CodeBuddyHistoryReaderTest {

    @Test
    public void findsSessionByJsonlMetadataWhenFilenameDoesNotContainId() throws Exception {
        Path projectsRoot = Files.createTempDirectory("codebuddy-history-test");
        Path transcript = projectsRoot.resolve("project").resolve("transcript.jsonl");
        Files.createDirectories(transcript.getParent());
        Files.writeString(transcript, ""
                + "{\"type\":\"metadata\",\"session_id\":\"session-1\","
                + "\"cwd\":\"C:\\\\project\"}\n"
                + "{\"type\":\"user\",\"session_id\":\"session-1\","
                + "\"message\":{\"role\":\"user\",\"content\":\"hello\"}}\n"
                + "{\"type\":\"assistant\",\"session_id\":\"session-1\","
                + "\"message\":{\"role\":\"assistant\",\"content\":\"world\"}}\n",
                StandardCharsets.UTF_8);

        CodeBuddyHistoryReader reader = new CodeBuddyHistoryReader(projectsRoot, new Gson());
        List<JsonObject> messages = reader.getSessionMessages("session-1", "C:/project");

        assertEquals(2, messages.size());
        assertEquals("user", messages.get(0).get("type").getAsString());
        assertTrue(reader.deleteSession("session-1", "C:/project"));
        assertFalse(Files.exists(transcript));
    }

    @Test
    public void doesNotReturnAnotherProjectWithSameSessionFilename() throws Exception {
        Path projectsRoot = Files.createTempDirectory("codebuddy-history-test");
        Path transcript = projectsRoot.resolve("project").resolve("session-1.jsonl");
        Files.createDirectories(transcript.getParent());
        Files.writeString(transcript,
                "{\"session_id\":\"session-1\",\"cwd\":\"C:\\\\other\","
                        + "\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"x\"}}\n",
                StandardCharsets.UTF_8);

        CodeBuddyHistoryReader reader = new CodeBuddyHistoryReader(projectsRoot, new Gson());

        assertTrue(reader.getSessionMessages("session-1", "C:/project").isEmpty());
    }
}
