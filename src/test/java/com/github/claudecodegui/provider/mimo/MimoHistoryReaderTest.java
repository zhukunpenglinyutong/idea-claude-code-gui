package com.github.claudecodegui.provider.mimo;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Verifies that MiMo Code (an OpenCode fork) sessions are read with the
 * inherited OpenCode parsing under the fork's own data home and labels.
 */
public class MimoHistoryReaderTest {

    @Test
    public void listsAndLoadsSessionWithMimoProviderLabel() throws Exception {
        Path storage = Files.createTempDirectory("mimo-history-test");
        String sessionId = "ses_mimo123abc";
        String projectHash = "hash123";

        Path sessionFile = storage.resolve("session").resolve(projectHash).resolve(sessionId + ".json");
        Files.createDirectories(sessionFile.getParent());
        Files.writeString(sessionFile, """
                {
                  "id": "%s",
                  "projectID": "%s",
                  "directory": "C:\\\\code\\\\my-app",
                  "title": "MiMo chat",
                  "time": { "created": 1000, "updated": 2000 }
                }
                """.formatted(sessionId, projectHash), StandardCharsets.UTF_8);

        String userMsgId = "msg_user1";
        String asstMsgId = "msg_asst1";
        Path userMsg = storage.resolve("message").resolve(sessionId).resolve(userMsgId + ".json");
        Path asstMsg = storage.resolve("message").resolve(sessionId).resolve(asstMsgId + ".json");
        Files.createDirectories(userMsg.getParent());
        Files.writeString(userMsg, """
                {"id":"%s","sessionID":"%s","role":"user","time":{"created":1001}}
                """.formatted(userMsgId, sessionId), StandardCharsets.UTF_8);
        Files.writeString(asstMsg, """
                {"id":"%s","sessionID":"%s","role":"assistant","time":{"created":1002}}
                """.formatted(asstMsgId, sessionId), StandardCharsets.UTF_8);

        Path userPart = storage.resolve("part").resolve(userMsgId).resolve("prt_1.json");
        Path asstText = storage.resolve("part").resolve(asstMsgId).resolve("prt_2.json");
        Files.createDirectories(userPart.getParent());
        Files.createDirectories(asstText.getParent());
        Files.writeString(userPart, """
                {"id":"prt_1","type":"text","text":"hello mimo","messageID":"%s"}
                """.formatted(userMsgId), StandardCharsets.UTF_8);
        Files.writeString(asstText, """
                {"id":"prt_2","type":"text","text":"world","messageID":"%s"}
                """.formatted(asstMsgId), StandardCharsets.UTF_8);

        // No SQLite file → pure legacy JSON path (inherited from OpenCode).
        Path missingDb = storage.resolveSibling("missing-mimocode.db");
        MimoHistoryReader reader = new MimoHistoryReader(storage, missingDb, new Gson());

        List<MimoHistoryReader.SessionInfo> listed =
                reader.listSessionsForProject("C:/code/my-app");
        assertEquals(1, listed.size());
        assertEquals(sessionId, listed.get(0).sessionId);
        assertEquals("mimo", listed.get(0).provider);
        assertEquals("MiMo chat", listed.get(0).title);
        assertEquals(2, listed.get(0).messageCount);

        List<JsonObject> messages = reader.getSessionMessages(sessionId, "C:\\code\\my-app");
        assertEquals(2, messages.size());
        assertEquals("user", messages.get(0).get("type").getAsString());
        assertEquals("assistant", messages.get(1).get("type").getAsString());

        // The sessions listing JSON must carry the mimo provider id.
        String listingJson = reader.getSessionsForProjectAsJson("C:/code/my-app");
        assertTrue(listingJson.contains("\"provider\":\"mimo\""));

        assertTrue(reader.deleteSession(sessionId, "C:/code/my-app"));
        assertTrue(reader.listSessionsForProject("C:/code/my-app").isEmpty());
    }
}
